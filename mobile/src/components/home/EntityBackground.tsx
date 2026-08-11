import React, { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedProps,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

const NUM_PARTICLES = 60;
const CONNECT_DISTANCE = 84;
const MAX_LINES = 220;
const COLOR_PERIOD_S = 30;
const BREATH_PERIOD_S = 7;

// How far the whole entity leans/compacts toward a CTA while it's only being
// previewed (drag in progress, not yet released past the swipe threshold).
const HOVER_CAP = 0.6;
const HOVER_EASE_RATE = 5.5; // per second
const COMMIT_EASE_RATE = 18; // per second — snaps fast so the exit reads as decisive
const STATE_COLOR_EASE_RATE = 0.06; // per frame — how fast the entity eases toward targetColor
const STATE_ENERGY_EASE_RATE = 0.08; // per frame

export type SwipeDirection = 'up' | 'right' | 'down' | 'left' | null;

const DIRECTION_VECTORS: Record<Exclude<SwipeDirection, null>, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export interface EntityBackgroundHandle {
  /** Live preview while a direction is being pressed/dragged but not yet committed. amt is 0..1 of HOVER_CAP. */
  lean: (direction: Exclude<SwipeDirection, null>, amt: number) => void;
  /** Clears an in-progress lean preview (drag cancelled, CTA released without commit). */
  release: () => void;
  /** Full commit: entity compacts, glows, and rushes off toward `direction`. */
  commit: (direction: Exclude<SwipeDirection, null>) => void;
  /** Snaps back to idle instantly — call when the hub screen regains focus. */
  reset: () => void;
}

interface ParticleConfig {
  homeAngle: number;
  homeRadius: number;
  ampX: number;
  ampY: number;
  freqX: number;
  freqY: number;
  seedX: number;
  seedY: number;
  radius: number;
  baseOpacity: number;
}

// Deterministic hash -> [0,1), used as the pseudo-random gradient source for value noise.
function hash(n: number): number {
  'worklet';
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

// 1D value noise with smoothstep interpolation — smooth, never exactly repeats
// for a monotonically increasing input (unlike a pure sine wave).
function valueNoise1D(x: number): number {
  'worklet';
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(i);
  const b = hash(i + 1);
  return a + (b - a) * u;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return { r, g, b };
}

// Particles rest on a contained ring around the hub center — a central presence,
// not a full-screen scatter — so it reads as one entity behind the BB button.
function makeParticleConfigs(containRadius: number): ParticleConfig[] {
  const configs: ParticleConfig[] = [];
  for (let i = 0; i < NUM_PARTICLES; i++) {
    configs.push({
      homeAngle: Math.random() * Math.PI * 2,
      homeRadius: 24 + Math.random() * containRadius,
      ampX: 10 + Math.random() * 26,
      ampY: 10 + Math.random() * 26,
      freqX: 0.04 + Math.random() * 0.09,
      freqY: 0.04 + Math.random() * 0.09,
      seedX: Math.random() * 1000,
      seedY: Math.random() * 1000,
      radius: 1.6 + Math.random() * 3.2,
      baseOpacity: 0.4 + Math.random() * 0.45,
    });
  }
  return configs;
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

interface ParticleProps {
  index: number;
  config: ParticleConfig;
  positions: SharedValue<{ x: number; y: number }[]>;
  fillColor: SharedValue<string>;
  glow: SharedValue<number>;
}

const Particle = React.memo(function Particle({ index, config, positions, fillColor, glow }: ParticleProps) {
  const animatedProps = useAnimatedProps(() => {
    const p = positions.value[index] ?? { x: 0, y: 0 };
    const g = glow.value;
    return {
      cx: p.x,
      cy: p.y,
      fill: fillColor.value,
      r: config.radius * g,
      opacity: Math.min(1, config.baseOpacity * g),
    };
  });

  return <AnimatedCircle animatedProps={animatedProps} />;
});

interface EntityBackgroundProps {
  center?: { x: number; y: number };
  /**
   * When provided, overrides the hub's ambient auto-cycling color with this
   * hex target, eased smoothly frame to frame — used for deterministic
   * state-driven color (e.g. the voice call's listening/speaking/thinking
   * states) instead of the free-roaming mood cycle.
   */
  targetColor?: string;
  /**
   * 0..1 — scales breathing amplitude and particle glow on top of whatever
   * the focus/lean system is doing. Meant for real audio-reactivity (voice
   * call mic/speaker level) layered on a per-state baseline; omit for the
   * hub's default calm ambient breathing.
   */
  energy?: number;
}

const EntityBackground = forwardRef<EntityBackgroundHandle, EntityBackgroundProps>(function EntityBackground(
  { center, targetColor, energy }: EntityBackgroundProps,
  ref,
) {
  const { width, height } = useWindowDimensions();
  const CX = center?.x ?? width / 2;
  const CY = center?.y ?? height / 2;
  const useStateColor = targetColor !== undefined;

  const containRadius = useMemo(() => Math.min(width, height) * 0.4, [width, height]);
  const configs = useMemo(() => makeParticleConfigs(containRadius), [containRadius]);

  const time = useSharedValue(0);
  const positions = useSharedValue(configs.map(() => ({ x: CX, y: CY })));
  const linesPath = useSharedValue('');

  // Focus state: a single eased amount (0..1) plus the direction it's aimed at.
  // 0 = idle/centered. ~HOVER_CAP = leaning toward a direction as a preview.
  // 1 = fully committed — compacted, glowing, and exiting off that edge.
  const focusVec = useSharedValue({ x: 0, y: 0 });
  const focusTarget = useSharedValue(0);
  const focusEaseRate = useSharedValue(HOVER_EASE_RATE);
  const focusAmt = useSharedValue(0);

  // State-driven color + energy (voice call usage only — see props above).
  // Only used to seed the initial shared-value color; later changes to
  // targetColor are picked up by the effect below, not by re-running this.
  const initialRGB = useMemo(() => hexToRgb(targetColor ?? '#4FC3F7'), []);
  const curR = useSharedValue(initialRGB.r);
  const curG = useSharedValue(initialRGB.g);
  const curB = useSharedValue(initialRGB.b);
  const targetR = useSharedValue(initialRGB.r);
  const targetG = useSharedValue(initialRGB.g);
  const targetB = useSharedValue(initialRGB.b);
  const energyTarget = useSharedValue(energy ?? 0);
  const energyAmt = useSharedValue(energy ?? 0);

  useEffect(() => {
    if (!targetColor) return;
    const rgb = hexToRgb(targetColor);
    targetR.value = rgb.r;
    targetG.value = rgb.g;
    targetB.value = rgb.b;
  }, [targetColor, targetR, targetG, targetB]);

  useEffect(() => {
    energyTarget.value = energy ?? 0;
  }, [energy, energyTarget]);

  useImperativeHandle(ref, () => ({
    lean: (direction, amt) => {
      focusVec.value = DIRECTION_VECTORS[direction];
      focusTarget.value = Math.min(HOVER_CAP, Math.max(0, amt) * HOVER_CAP);
      focusEaseRate.value = HOVER_EASE_RATE;
    },
    release: () => {
      focusTarget.value = 0;
      focusEaseRate.value = HOVER_EASE_RATE;
    },
    commit: (direction) => {
      focusVec.value = DIRECTION_VECTORS[direction];
      focusTarget.value = 1;
      focusEaseRate.value = COMMIT_EASE_RATE;
    },
    reset: () => {
      focusTarget.value = 0;
      focusAmt.value = 0;
      focusVec.value = { x: 0, y: 0 };
    },
  }));

  useFrameCallback((frameInfo) => {
    'worklet';
    const dt = (frameInfo.timeSincePreviousFrame ?? 16) / 1000;
    // Energy accelerates the entity's internal clock: at full energy
    // (BB speaking) the swarm moves ~2.8x faster — visibly alive, not a
    // wallpaper. At rest it keeps the hub's calm drift.
    const speedScale = useStateColor ? 1 + 1.8 * energyAmt.value : 1;
    time.value += dt * speedScale;
    const t = time.value;

    focusAmt.value += (focusTarget.value - focusAmt.value) * Math.min(1, focusEaseRate.value * dt);
    const amt = focusAmt.value;
    const vec = focusVec.value;

    if (useStateColor) {
      curR.value += (targetR.value - curR.value) * STATE_COLOR_EASE_RATE;
      curG.value += (targetG.value - curG.value) * STATE_COLOR_EASE_RATE;
      curB.value += (targetB.value - curB.value) * STATE_COLOR_EASE_RATE;
      energyAmt.value += (energyTarget.value - energyAmt.value) * STATE_ENERGY_EASE_RATE;
    }

    const compact = 1 - 0.6 * amt;
    const offsetDist = containRadius * 1.4 * amt;
    const focusCX = CX + vec.x * offsetDist;
    const focusCY = CY + vec.y * offsetDist;
    const breathingAmp = useStateColor ? 0.14 + 0.34 * energyAmt.value : 0.14;
    const breathing = 1 + breathingAmp * Math.sin((t / BREATH_PERIOD_S) * 2 * Math.PI) * (1 - amt * 0.6);

    const next: { x: number; y: number }[] = new Array(configs.length);
    for (let i = 0; i < configs.length; i++) {
      const c = configs[i];
      const nx = (valueNoise1D(t * c.freqX + c.seedX) * 2 - 1) * c.ampX * compact;
      const ny = (valueNoise1D(t * c.freqY + c.seedY) * 2 - 1) * c.ampY * compact;
      const homeX = focusCX + Math.cos(c.homeAngle) * c.homeRadius * compact * breathing;
      const homeY = focusCY + Math.sin(c.homeAngle) * c.homeRadius * compact * breathing;
      next[i] = { x: homeX + nx, y: homeY + ny };
    }
    positions.value = next;

    let d = '';
    let lineCount = 0;
    for (let i = 0; i < next.length && lineCount < MAX_LINES; i++) {
      for (let j = i + 1; j < next.length && lineCount < MAX_LINES; j++) {
        const dx = next[i].x - next[j].x;
        const dy = next[i].y - next[j].y;
        if (dx * dx + dy * dy < CONNECT_DISTANCE * CONNECT_DISTANCE) {
          d += `M${next[i].x.toFixed(1)},${next[i].y.toFixed(1)} L${next[j].x.toFixed(1)},${next[j].y.toFixed(1)} `;
          lineCount++;
        }
      }
    }
    linesPath.value = d;
  }, true);

  const fillColor = useDerivedValue(() => {
    if (useStateColor) {
      return `rgb(${Math.round(curR.value)}, ${Math.round(curG.value)}, ${Math.round(curB.value)})`;
    }
    const cycle = (Math.sin((time.value / COLOR_PERIOD_S) * 2 * Math.PI) + 1) / 2;
    return interpolateColor(cycle, [0, 1], ['#4FC3F7', '#2563EB']);
  });

  // Glow reacts to whichever driver is active for this screen — the hub's
  // focus/commit system, or the voice call's audio energy. Baseline is 1
  // (particles render at their configured size/opacity at rest); the boost
  // on top goes up to +0.85x when focused or energetic. Passing raw
  // focusAmt/energyAmt here (0 at rest) instead of this baseline+boost form
  // would make particles render at r≈0, opacity≈0 — invisible at idle.
  const glow = useDerivedValue(() => 1 + 1.15 * Math.max(focusAmt.value, energyAmt.value));

  const lineProps = useAnimatedProps(() => ({
    d: linesPath.value,
    strokeOpacity: Math.min(0.65, 0.16 * (1 + 2.2 * Math.max(focusAmt.value, energyAmt.value))),
  }));

  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height} viewBox={`0 0 ${width} ${height}`} pointerEvents="none">
      <AnimatedPath stroke="#8FD6FF" strokeWidth={1} fill="none" animatedProps={lineProps} />
      {configs.map((config, index) => (
        <Particle key={index} index={index} config={config} positions={positions} fillColor={fillColor} glow={glow} />
      ))}
    </Svg>
  );
});

export default EntityBackground;
