import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  GestureHandlerRootView,
  PanGestureHandler,
  State,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import EntityBackground, { type SwipeDirection } from './EntityBackground';
import { LAST_OUTCOME_KEY, type LastOutcome } from '../../services/outcomeRecorder';
import { Colors, Spacing } from '../../theme';

const SWIPE_DISTANCE_THRESHOLD = 80;
const SWIPE_VELOCITY_THRESHOLD = 300;
const NAVIGATE_DELAY_MS = 500;

const ROUTES: Record<Exclude<SwipeDirection, null>, string> = {
  up: '/session-voice',
  down: '/(app)/session-chat',
  right: '/(app)/content-feed',
  left: '/(app)/profile',
};

function formatCountUp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

interface HubHomeScreenProps {
  onOpenDrawer: () => void;
}

export default function HubHomeScreen({ onOpenDrawer }: HubHomeScreenProps) {
  const [swipeDirection, setSwipeDirection] = useState<SwipeDirection>(null);
  const [now, setNow] = useState(Date.now());
  const [lastOutcome, setLastOutcome] = useState<LastOutcome | null>(null);
  const navigateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(LAST_OUTCOME_KEY).then((raw) => {
      if (raw) {
        try {
          setLastOutcome(JSON.parse(raw));
        } catch {}
      }
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (navigateTimer.current) clearTimeout(navigateTimer.current);
    };
  }, []);

  const triggerDirection = useCallback((direction: Exclude<SwipeDirection, null>) => {
    setSwipeDirection(direction);
    if (navigateTimer.current) clearTimeout(navigateTimer.current);
    navigateTimer.current = setTimeout(() => {
      router.push(ROUTES[direction] as never);
      setSwipeDirection(null);
    }, NAVIGATE_DELAY_MS);
  }, []);

  const onHandlerStateChange = useCallback(
    (event: PanGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.state !== State.END) return;
      const { translationX, translationY, velocityX, velocityY } = event.nativeEvent;
      const absX = Math.abs(translationX);
      const absY = Math.abs(translationY);
      const absVX = Math.abs(velocityX);
      const absVY = Math.abs(velocityY);

      let direction: Exclude<SwipeDirection, null> | null = null;
      if (absX > absY) {
        if (absX > SWIPE_DISTANCE_THRESHOLD || absVX > SWIPE_VELOCITY_THRESHOLD) {
          direction = translationX > 0 ? 'right' : 'left';
        }
      } else {
        if (absY > SWIPE_DISTANCE_THRESHOLD || absVY > SWIPE_VELOCITY_THRESHOLD) {
          direction = translationY > 0 ? 'down' : 'up';
        }
      }

      if (direction) triggerDirection(direction);
    },
    [triggerDirection],
  );

  const elapsed = lastOutcome ? now - new Date(lastOutcome.timestamp).getTime() : null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.container}>
        <EntityBackground swipeDirection={swipeDirection} />

        <SafeAreaView style={styles.safeArea}>
          <View style={styles.header}>
            <Text style={styles.logo}>BB</Text>
            <TouchableOpacity onPress={onOpenDrawer} hitSlop={12} style={styles.hamburger}>
              <Ionicons name="menu" size={26} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.clockArea}>
            <Text style={styles.clock}>{elapsed !== null ? formatCountUp(elapsed) : '—'}</Text>
            <Text style={styles.clockLabel}>
              {elapsed !== null ? 'since last urge' : 'no urges logged yet'}
            </Text>
          </View>

          <PanGestureHandler onHandlerStateChange={onHandlerStateChange}>
            <View style={styles.stage}>
              <TouchableOpacity
                style={[styles.arrowGroup, styles.arrowUp]}
                onPress={() => triggerDirection('up')}
                activeOpacity={0.7}
              >
                <Ionicons name="chevron-up" size={64} color={Colors.coral} />
                <Text style={styles.arrowLabel}>TALK</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.arrowGroup, styles.arrowRight]}
                onPress={() => triggerDirection('right')}
                activeOpacity={0.7}
              >
                <Ionicons name="chevron-forward" size={64} color={Colors.coral} />
                <Text style={styles.arrowLabel}>SCROLL</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.arrowGroup, styles.arrowDown]}
                onPress={() => triggerDirection('down')}
                activeOpacity={0.7}
              >
                <Ionicons name="chevron-down" size={64} color={Colors.coral} />
                <Text style={styles.arrowLabel}>CHAT</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.arrowGroup, styles.arrowLeft]}
                onPress={() => triggerDirection('left')}
                activeOpacity={0.7}
              >
                <Ionicons name="chevron-back" size={64} color={Colors.coral} />
                <Text style={styles.arrowLabel}>PROFILE</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.bbCircle}
                onPress={() => triggerDirection('down')}
                activeOpacity={0.8}
              >
                <Text style={styles.bbText}>BB</Text>
              </TouchableOpacity>
            </View>
          </PanGestureHandler>
        </SafeAreaView>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
  },
  logo: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: 1,
  },
  hamburger: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockArea: {
    alignItems: 'center',
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
  },
  clock: {
    fontSize: 48,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  clockLabel: {
    fontSize: 13,
    color: Colors.textTertiary,
    fontWeight: '500',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bbCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: Colors.coral,
    backgroundColor: 'rgba(232,98,74,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-10deg' }],
  },
  bbText: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.coral,
    letterSpacing: 1,
  },
  arrowGroup: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    alignItems: 'center',
    gap: 4,
  },
  arrowUp: {
    transform: [{ translateX: -32 }, { translateY: -120 - 32 }],
  },
  arrowRight: {
    transform: [{ translateX: 140 - 32 }, { translateY: -32 }],
  },
  arrowDown: {
    transform: [{ translateX: -32 }, { translateY: 120 - 32 }],
  },
  arrowLeft: {
    transform: [{ translateX: -140 - 32 }, { translateY: -32 }],
  },
  arrowLabel: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.coral,
    letterSpacing: 1,
  },
});
