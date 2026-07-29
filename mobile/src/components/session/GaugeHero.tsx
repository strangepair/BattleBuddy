import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import type { SessionPhase } from './SessionHeader';
import { Colors } from '../../theme';

// The Mission HUD hero: time since the last cigarette, ticking live, drawn
// against a semicircular gauge whose end marker is the personal best. The
// framing is deliberately AVE-safe (abstinence-violation effect): the timer
// restarts when a cigarette is logged, but the best is "the marker to pass,"
// never a streak that shatters. In resistance the same gauge turns coral and
// reads "holding for" — one skeleton, two phases.

// Hero-scale by request: one large display of time since the last cigarette,
// front and center — the gauge fills the dashboard width and the timer is the
// biggest thing on the screen.
const W = 340;
const H = 196;
const R = 140;
const CX = W / 2;
const CY = 182;
// Semicircle arc length ≈ π·R
const ARC_LEN = Math.PI * R;

interface GaugeHeroProps {
  phase: SessionPhase;
  /** Timestamp (ms) of the last logged cigarette; null = none logged yet. */
  lastCigaretteAt: number | null;
  /** All-time best waking gap in ms (records only grow). */
  bestGapMs: number | null;
}

function fmtTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtShort(ms: number): string {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export default function GaugeHero({ phase, lastCigaretteAt, bestGapMs }: GaugeHeroProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const resistance = phase === 'resistance';
  const accent = resistance ? Colors.coral : Colors.stateIdle;

  const gapMs = lastCigaretteAt != null ? now - lastCigaretteAt : null;
  const best = bestGapMs && bestGapMs > 0 ? bestGapMs : null;
  const pastBest = gapMs != null && best != null && gapMs > best;
  // Progress toward the best; with no best yet the arc breathes at a sliver.
  const progress =
    gapMs == null ? 0 : best ? Math.min(1, gapMs / best) : 0.06;

  // Marker for the best sits at the end of the arc.
  const markerAngle = Math.PI; // end of semicircle (right side)
  const mx = CX + R * Math.cos(Math.PI - markerAngle);
  const my = CY - R * Math.sin(Math.PI - markerAngle);

  const label = resistance ? 'Holding for' : 'Since your last one';
  const sub =
    gapMs == null
      ? 'log the first one and the clock starts — data, not a verdict'
      : pastBest
        ? `past your best ${fmtShort(best!)} — new record, live`
        : best
          ? `your best ${fmtShort(best)} — the marker to pass`
          : 'your first best is being set right now';

  return (
    <View style={styles.wrap}>
      <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <Path
          d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
          fill="none"
          stroke={Colors.surfaceBorder}
          strokeWidth={13}
          strokeLinecap="round"
        />
        <Path
          d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
          fill="none"
          stroke={accent}
          strokeWidth={13}
          strokeLinecap="round"
          strokeDasharray={`${ARC_LEN * progress} ${ARC_LEN}`}
        />
        <Circle cx={mx} cy={my} r={6.5} fill={pastBest ? accent : Colors.success} />
      </Svg>
      <View style={styles.num} pointerEvents="none">
        <Text style={styles.k}>{label.toUpperCase()}</Text>
        <Text
          style={[
            styles.v,
            resistance && { color: Colors.coral },
            gapMs == null && styles.vWaiting,
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {gapMs != null ? fmtTimer(gapMs) : '0:00:00'}
        </Text>
        <Text style={styles.d}>{sub}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: W,
    height: H + 16,
    alignSelf: 'center',
  },
  num: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 88,
    alignItems: 'center',
  },
  k: {
    fontSize: 11,
    letterSpacing: 2.6,
    color: Colors.textSecondary,
    fontWeight: '700',
  },
  v: {
    fontFamily: 'Menlo',
    fontSize: 56,
    fontWeight: '800',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
    maxWidth: W - 44,
  },
  vWaiting: {
    opacity: 0.35,
  },
  d: {
    fontSize: 11.5,
    color: Colors.textSecondary,
    marginTop: 3,
    textAlign: 'center',
    paddingHorizontal: 10,
  },
});
