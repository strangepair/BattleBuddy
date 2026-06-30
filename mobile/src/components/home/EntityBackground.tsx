import React, { useEffect, useMemo } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

const NUM_PARTICLES = 60;
const CONNECT_DISTANCE = 80;
const MAX_LINES = 220;
const COLOR_PERIOD_S = 30;
const BREATH_PERIOD_S = 4;
const PULL_DURATION_MS = 600;

export type SwipeDirection = 'up' | 'right' | 'down' | 'left' | null;

const DIRECTION_VECTORS: Record<Exclude<SwipeDirection, null>, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

interface ParticleConfig {
  baseX: number;
  baseY: number;
  ampX: number;
  ampY: number;
  freqX: number;
  freqY: number;
  seedX: number;
  seedY: number;
  radius: number;
  opacity: number;
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

function makeParticleConfigs(width: number, height: number): ParticleConfig[] {
  const configs: ParticleConfig[] = [];
  for (let i = 0; i < NUM_PARTICLES; i++) {
    configs.push({
      baseX: Math.random() * width,
      baseY: Math.random() * height,
      ampX: 16 + Math.random() * 40,
      ampY: 16 + Math.random() * 40,
      freqX: 0.04 + Math.random() * 0.09,
      freqY: 0.04 + Math.random() * 0.09,
      seedX: Math.random() * 1000,
      seedY: Math.random() * 1000,
      radius: 1.5 + Math.random() * 3,
      opacity: 0.35 + Math.random() * 0.5,
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
}

const Particle = React.memo(function Particle({ index, config, positions, fillColor }: ParticleProps) {
  const animatedProps = useAnimatedProps(() => {
    const p = positions.value[index] ?? { x: config.baseX, y: config.baseY };
    return {
      cx: p.x,
      cy: p.y,
      fill: fillColor.value,
    };
  });

  return <AnimatedCircle r={config.radius} opacity={config.opacity} animatedProps={animatedProps} />;
});

interface EntityBackgroundProps {
  swipeDirection?: SwipeDirection;
}

export default function EntityBackground({ swipeDirection = null }: EntityBackgroundProps) {
  const { width, height } = useWindowDimensions();

  const configs = useMemo(() => makeParticleConfigs(width, height), [width, height]);
  const edgeDistance = useMemo(() => Math.max(width, height) * 0.9, [width, height]);

  const time = useSharedValue(0);
  const positions = useSharedValue(configs.map((c) => ({ x: c.baseX, y: c.baseY })));
  const linesPath = useSharedValue('');
  const pullDir = useSharedValue({ x: 0, y: 0 });
  const pullProgress = useSharedValue(0);

  useFrameCallback((frameInfo) => {
    'worklet';
    const dt = (frameInfo.timeSincePreviousFrame ?? 16) / 1000;
    time.value += dt;
    const t = time.value;
    const dir = pullDir.value;
    const pull = pullProgress.value;

    const next: { x: number; y: number }[] = new Array(configs.length);
    for (let i = 0; i < configs.length; i++) {
      const c = configs[i];
      const nx = (valueNoise1D(t * c.freqX + c.seedX) * 2 - 1) * c.ampX;
      const ny = (valueNoise1D(t * c.freqY + c.seedY) * 2 - 1) * c.ampY;
      let x = c.baseX + nx;
      let y = c.baseY + ny;
      if (pull > 0) {
        x += dir.x * edgeDistance * pull;
        y += dir.y * edgeDistance * pull;
      }
      next[i] = { x, y };
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

  useEffect(() => {
    if (swipeDirection) {
      pullDir.value = DIRECTION_VECTORS[swipeDirection];
      pullProgress.value = withTiming(1, { duration: PULL_DURATION_MS, easing: Easing.in(Easing.cubic) });
    } else {
      pullProgress.value = 0;
    }
  }, [swipeDirection, pullDir, pullProgress]);

  const fillColor = useDerivedValue(() => {
    const cycle = (Math.sin((time.value / COLOR_PERIOD_S) * 2 * Math.PI) + 1) / 2;
    return interpolateColor(cycle, [0, 1], ['#4FC3F7', '#E8624A']);
  });

  const lineProps = useAnimatedProps(() => ({ d: linesPath.value }));

  const breathStyle = useAnimatedStyle(() => {
    const scale = 1 + 0.03 * Math.sin((time.value / BREATH_PERIOD_S) * 2 * Math.PI);
    return { transform: [{ scale }] };
  });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, breathStyle]} pointerEvents="none">
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <AnimatedPath stroke="#4FC3F7" strokeOpacity={0.16} strokeWidth={1} fill="none" animatedProps={lineProps} />
        {configs.map((config, index) => (
          <Particle key={index} index={index} config={config} positions={positions} fillColor={fillColor} />
        ))}
      </Svg>
    </Animated.View>
  );
}
