import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import EntityBackground from './EntityBackground';
import { recordSessionOutcome } from '../../services/outcomeRecorder';
import { logEvent } from '../../services/eventService';
import { useAuthStore } from '../../stores/authStore';
import { Colors } from '../../theme';
import { NAV_ROUTES, type Direction } from '../../lib/navDirections';

// Decision gets its own accent so it never reads as either a win (green) or
// a loss (the gave-in chip) — a conscious choice is neither (doc 08 §2).
const DECISION_COLOR = '#8B5CF6';

const BB_SIZE = 80;
const GLOW_SIZE = BB_SIZE + 24;
const ICON_SIZE = 56;
const TAP_MAX_DISTANCE = 5;
const PAN_MIN_DISTANCE = 5;
const AXIS_LOCK_THRESHOLD = 8;
const DRAG_COMMIT_RATIO = 0.25;
const VELOCITY_COMMIT_THRESHOLD = 500;
const DRAG_SCALE = 1.4;
const HINT_KEY = '@bb_swipe_hint_shown';

// Distinct per-destination tint so the peek-through behind the departing
// screen tells the user where the drag is headed before they let go.
const DEST_TINTS: Record<Direction, string> = {
  down: '#5B9FFF',
  up: '#34C759',
  left: Colors.stateListening,
  right: '#8B5CF6',
};

interface HubHomeScreenProps {
  onOpenDrawer: () => void;
}

export default function HubHomeScreen(_props: HubHomeScreenProps) {
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();

  const [menuOpen, setMenuOpen] = useState(false);
  const [showHint, setShowHint] = useState(false);

  // Idle breathing on the BB circle itself.
  const breathScale = useSharedValue(1);
  // Brief outward pulse on tap.
  const tapPulse = useSharedValue(1);
  // Scale + glow while a drag is active.
  const dragScale = useSharedValue(1);
  const glowOpacity = useSharedValue(0);

  // Whole-screen translate while dragging.
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const currentDir = useSharedValue<Direction | null>(null);
  // Axis locked in from the first few pixels of movement — 'x' or 'y' for
  // the rest of the gesture, so drags never track diagonally.
  const lockedAxis = useSharedValue<'x' | 'y' | null>(null);

  // Quick-log menu (tap) — shared fade for both options, plus a per-option
  // "fly away" amount driven independently so only the tapped one exits.
  const menuOpacity = useSharedValue(0);
  const resistedFly = useSharedValue(0);
  const gaveInFly = useSharedValue(0);
  const decisionFly = useSharedValue(0);
  const talkingFly = useSharedValue(0);

  // First-launch hint.
  const hintRingScale = useSharedValue(1);
  const hintRingOpacity = useSharedValue(0);
  const hintDragY = useSharedValue(0);
  const hintDragOpacity = useSharedValue(0);

  useEffect(() => {
    breathScale.value = withRepeat(
      withTiming(1.08, { duration: 2200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [breathScale]);

  useEffect(() => {
    AsyncStorage.getItem(HINT_KEY).then((val) => {
      if (val) return;
      setShowHint(true);

      hintRingOpacity.value = withSequence(withTiming(0.7, { duration: 120 }), withTiming(0, { duration: 900 }));
      hintRingScale.value = withSequence(
        withTiming(1, { duration: 0 }),
        withTiming(2.4, { duration: 1000, easing: Easing.out(Easing.ease) }),
      );

      hintDragOpacity.value = withDelay(
        1000,
        withSequence(withTiming(0.85, { duration: 200 }), withTiming(0.85, { duration: 1000 }), withTiming(0, { duration: 300 })),
      );
      hintDragY.value = withDelay(
        1000,
        withRepeat(
          withSequence(
            withTiming(26, { duration: 380, easing: Easing.out(Easing.ease) }),
            withTiming(0, { duration: 380, easing: Easing.in(Easing.ease) }),
          ),
          2,
          false,
        ),
      );

      const timer = setTimeout(() => {
        setShowHint(false);
        AsyncStorage.setItem(HINT_KEY, 'true').catch(() => {});
      }, 2600);
      return () => clearTimeout(timer);
    });
  }, [hintRingOpacity, hintRingScale, hintDragOpacity, hintDragY]);

  // Re-center everything whenever the hub regains focus (e.g. back from a
  // portal destination) so a half-finished drag never lingers on return.
  useFocusEffect(
    useCallback(() => {
      translateX.value = 0;
      translateY.value = 0;
      dragScale.value = 1;
      glowOpacity.value = 0;
      currentDir.value = null;
      lockedAxis.value = null;
      menuOpacity.value = 0;
      resistedFly.value = 0;
      gaveInFly.value = 0;
      decisionFly.value = 0;
      talkingFly.value = 0;
      setMenuOpen(false);
    }, [translateX, translateY, dragScale, glowOpacity, currentDir, lockedAxis, menuOpacity, resistedFly, gaveInFly, decisionFly, talkingFly]),
  );

  const navigateTo = useCallback((direction: Direction) => {
    router.replace(NAV_ROUTES[direction] as never);
  }, []);

  const openMenu = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    resistedFly.value = 0;
    gaveInFly.value = 0;
    decisionFly.value = 0;
    talkingFly.value = 0;
    setMenuOpen(true);
    menuOpacity.value = withTiming(1, { duration: 180 });
  }, [menuOpacity, resistedFly, gaveInFly, decisionFly, talkingFly]);

  const closeMenu = useCallback(() => {
    menuOpacity.value = withTiming(0, { duration: 150 }, (finished) => {
      if (finished) runOnJS(setMenuOpen)(false);
    });
  }, [menuOpacity]);

  const handleOutcome = useCallback((outcome: 'resisted' | 'gave_in') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const userId = useAuthStore.getState().user?.id || 'default';
    recordSessionOutcome(userId, outcome);

    const fly = outcome === 'resisted' ? resistedFly : gaveInFly;
    fly.value = withTiming(1, { duration: 260 });
    menuOpacity.value = withDelay(120, withTiming(0, { duration: 200 }, (finished) => {
      if (finished) runOnJS(setMenuOpen)(false);
    }));
  }, [menuOpacity, resistedFly, gaveInFly]);

  // A decision is a conscious choice to smoke, not a slip — logged distinctly
  // from urge_gave_in so neither the agent nor the dashboard treats it as a
  // failure (doc 08 §2). No shame-adjacent haptic or copy anywhere near it.
  const handleDecision = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const userId = useAuthStore.getState().user?.id || 'default';
    const timestamp = new Date().toISOString();
    logEvent(userId, 'decision', {}, timestamp);
    logEvent(userId, 'cigarette', {}, timestamp);

    decisionFly.value = withTiming(1, { duration: 260 });
    menuOpacity.value = withDelay(120, withTiming(0, { duration: 200 }, (finished) => {
      if (finished) runOnJS(setMenuOpen)(false);
    }));
  }, [menuOpacity, decisionFly]);

  // No event logged — this is just a door into chat, not an outcome.
  const handleTalking = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    talkingFly.value = withTiming(1, { duration: 260 });
    menuOpacity.value = withTiming(0, { duration: 200 }, (finished) => {
      if (finished) {
        runOnJS(setMenuOpen)(false);
        runOnJS(navigateTo)('up');
      }
    });
  }, [menuOpacity, talkingFly, navigateTo]);

  const tapGesture = Gesture.Tap()
    .maxDistance(TAP_MAX_DISTANCE)
    .onEnd((_e, success) => {
      if (!success) return;
      tapPulse.value = withSequence(withTiming(1.4, { duration: 75 }), withTiming(1, { duration: 75 }));
      runOnJS(openMenu)();
    });

  const panGesture = Gesture.Pan()
    .minDistance(PAN_MIN_DISTANCE)
    .onStart(() => {
      lockedAxis.value = null;
      dragScale.value = withSpring(DRAG_SCALE, { damping: 14, stiffness: 180 });
      glowOpacity.value = withTiming(1, { duration: 150 });
    })
    .onUpdate((e) => {
      // Determine the axis from the first few pixels of movement, then hold
      // it for the rest of the gesture — the other axis stays zeroed so the
      // screen only ever tracks purely horizontal or purely vertical.
      if (lockedAxis.value === null) {
        const absX = Math.abs(e.translationX);
        const absY = Math.abs(e.translationY);
        if (absX >= AXIS_LOCK_THRESHOLD || absY >= AXIS_LOCK_THRESHOLD) {
          lockedAxis.value = absX > absY ? 'x' : 'y';
        }
      }

      if (lockedAxis.value === 'x') {
        translateX.value = e.translationX;
        translateY.value = 0;
        currentDir.value = e.translationX > 0 ? 'right' : 'left';
      } else if (lockedAxis.value === 'y') {
        translateX.value = 0;
        translateY.value = e.translationY;
        currentDir.value = e.translationY > 0 ? 'down' : 'up';
      }
    })
    .onEnd((e) => {
      const dir = currentDir.value;
      if (!dir) {
        lockedAxis.value = null;
        return;
      }

      const isXAxis = lockedAxis.value === 'x';
      const dragRatio = isXAxis ? Math.abs(e.translationX) / SCREEN_W : Math.abs(e.translationY) / SCREEN_H;
      const velocity = isXAxis ? Math.abs(e.velocityX) : Math.abs(e.velocityY);

      if (dragRatio > DRAG_COMMIT_RATIO || velocity > VELOCITY_COMMIT_THRESHOLD) {
        const targetX = dir === 'left' ? -SCREEN_W : dir === 'right' ? SCREEN_W : 0;
        const targetY = dir === 'up' ? -SCREEN_H : dir === 'down' ? SCREEN_H : 0;
        translateX.value = withTiming(targetX, { duration: 320, easing: Easing.out(Easing.cubic) });
        translateY.value = withTiming(targetY, { duration: 320, easing: Easing.out(Easing.cubic) }, (finished) => {
          if (finished) runOnJS(navigateTo)(dir);
        });
      } else {
        translateX.value = withSpring(0, { damping: 16, stiffness: 180 });
        translateY.value = withSpring(0, { damping: 16, stiffness: 180 });
        dragScale.value = withSpring(1, { damping: 14, stiffness: 180 });
        glowOpacity.value = withTiming(0, { duration: 200 });
        currentDir.value = null;
      }
      lockedAxis.value = null;
    });

  const screenStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  const circleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: breathScale.value * tapPulse.value * dragScale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const downPreviewStyle = useAnimatedStyle(() => ({ opacity: currentDir.value === 'down' ? 1 : 0 }));
  const upPreviewStyle = useAnimatedStyle(() => ({ opacity: currentDir.value === 'up' ? 1 : 0 }));
  const leftPreviewStyle = useAnimatedStyle(() => ({ opacity: currentDir.value === 'left' ? 1 : 0 }));
  const rightPreviewStyle = useAnimatedStyle(() => ({ opacity: currentDir.value === 'right' ? 1 : 0 }));

  const resistedStyle = useAnimatedStyle(() => ({
    opacity: menuOpacity.value * (1 - resistedFly.value),
    transform: [{ translateY: -resistedFly.value * 40 }],
  }));
  const gaveInStyle = useAnimatedStyle(() => ({
    opacity: menuOpacity.value * (1 - gaveInFly.value),
    transform: [{ translateY: -gaveInFly.value * 40 }],
  }));
  const decisionStyle = useAnimatedStyle(() => ({
    opacity: menuOpacity.value * (1 - decisionFly.value),
    transform: [{ translateY: -decisionFly.value * 40 }],
  }));
  const talkingStyle = useAnimatedStyle(() => ({
    opacity: menuOpacity.value * (1 - talkingFly.value),
    transform: [{ translateY: -talkingFly.value * 40 }],
  }));

  const hintRingStyle = useAnimatedStyle(() => ({
    opacity: hintRingOpacity.value,
    transform: [{ scale: hintRingScale.value }],
  }));
  const hintDragStyle = useAnimatedStyle(() => ({
    opacity: hintDragOpacity.value,
    transform: [{ translateY: BB_SIZE / 2 + 20 + hintDragY.value }],
  }));

  return (
    <GestureDetector gesture={panGesture}>
      <View style={styles.container}>
        <Animated.View style={[styles.preview, { backgroundColor: DEST_TINTS.down }, downPreviewStyle]} pointerEvents="none">
          <Text style={[styles.destLabelHorizontal, styles.destLabelTop]}>VOICE</Text>
        </Animated.View>
        <Animated.View style={[styles.preview, { backgroundColor: DEST_TINTS.up }, upPreviewStyle]} pointerEvents="none">
          <Text style={[styles.destLabelHorizontal, styles.destLabelBottom]}>CHAT</Text>
        </Animated.View>
        <Animated.View style={[styles.preview, { backgroundColor: DEST_TINTS.left }, leftPreviewStyle]} pointerEvents="none">
          <View style={[styles.destLabelVerticalWrap, styles.destLabelVerticalWrapRight]}>
            <Text style={[styles.destLabelVertical, styles.destLabelRotateRight]}>CONTENT</Text>
          </View>
        </Animated.View>
        <Animated.View style={[styles.preview, { backgroundColor: DEST_TINTS.right }, rightPreviewStyle]} pointerEvents="none">
          <View style={[styles.destLabelVerticalWrap, styles.destLabelVerticalWrapLeft]}>
            <Text style={[styles.destLabelVertical, styles.destLabelRotateLeft]}>PROFILE</Text>
          </View>
        </Animated.View>

        <Animated.View style={[styles.screen, screenStyle]}>
          <EntityBackground />

          {menuOpen && <Pressable style={StyleSheet.absoluteFill} onPress={closeMenu} />}

          <View style={styles.hub} pointerEvents="box-none">
            <Animated.View style={[styles.optionWrap, styles.optionLeft, resistedStyle]} pointerEvents={menuOpen ? 'auto' : 'none'}>
              <TouchableOpacity style={styles.optionChip} activeOpacity={0.8} onPress={() => handleOutcome('resisted')}>
                <Text style={styles.optionEmoji}>💪</Text>
              </TouchableOpacity>
              <Text style={styles.optionLabel}>Resisted</Text>
            </Animated.View>

            <Animated.View style={[styles.optionWrap, styles.optionRight, gaveInStyle]} pointerEvents={menuOpen ? 'auto' : 'none'}>
              <TouchableOpacity style={styles.optionChip} activeOpacity={0.8} onPress={() => handleOutcome('gave_in')}>
                <Text style={styles.optionEmoji}>😐</Text>
              </TouchableOpacity>
              <Text style={styles.optionLabel}>Gave In</Text>
            </Animated.View>

            <Animated.View style={[styles.optionWrap, styles.optionDecision, decisionStyle]} pointerEvents={menuOpen ? 'auto' : 'none'}>
              <TouchableOpacity style={[styles.optionChip, styles.decisionChip]} activeOpacity={0.8} onPress={handleDecision}>
                <Text style={styles.optionEmoji}>🙂</Text>
              </TouchableOpacity>
              <Text style={[styles.optionLabel, styles.decisionLabel]}>Decision</Text>
            </Animated.View>

            <Animated.View style={[styles.optionWrap, styles.optionTalking, talkingStyle]} pointerEvents={menuOpen ? 'auto' : 'none'}>
              <TouchableOpacity style={[styles.optionChip, styles.talkingChip]} activeOpacity={0.8} onPress={handleTalking}>
                <Text style={styles.optionEmoji}>💬</Text>
              </TouchableOpacity>
              <Text style={[styles.optionLabel, styles.talkingLabel]}>Just Talking</Text>
            </Animated.View>

            <Animated.View style={[styles.glowRing, glowStyle]} pointerEvents="none" />

            <GestureDetector gesture={tapGesture}>
              <Animated.View style={[styles.bbCircle, circleStyle]} />
            </GestureDetector>

            {showHint && (
              <>
                <Animated.View style={[styles.hintRing, hintRingStyle]} pointerEvents="none" />
                <Animated.View style={[styles.hintDrag, hintDragStyle]} pointerEvents="none" />
              </>
            )}
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  preview: {
    ...StyleSheet.absoluteFill,
  },
  destLabelHorizontal: {
    position: 'absolute',
    left: 0,
    right: 0,
    fontSize: 92,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.92)',
    textAlign: 'center',
    letterSpacing: 4,
  },
  destLabelTop: {
    top: 14,
  },
  destLabelBottom: {
    bottom: 14,
  },
  destLabelVerticalWrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  destLabelVerticalWrapLeft: {
    left: 0,
  },
  destLabelVerticalWrapRight: {
    right: 0,
  },
  destLabelVertical: {
    fontSize: 84,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.92)',
    letterSpacing: 4,
  },
  destLabelRotateLeft: {
    transform: [{ rotate: '-90deg' }],
  },
  destLabelRotateRight: {
    transform: [{ rotate: '90deg' }],
  },
  screen: {
    ...StyleSheet.absoluteFill,
    backgroundColor: Colors.background,
  },
  hub: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bbCircle: {
    width: BB_SIZE,
    height: BB_SIZE,
    borderRadius: BB_SIZE / 2,
    backgroundColor: Colors.coral,
  },
  glowRing: {
    position: 'absolute',
    width: GLOW_SIZE,
    height: GLOW_SIZE,
    borderRadius: GLOW_SIZE / 2,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.85)',
  },
  optionWrap: {
    position: 'absolute',
    alignItems: 'center',
    gap: 8,
  },
  optionLeft: {
    transform: [{ translateX: -86 }, { translateY: -100 }],
  },
  optionRight: {
    transform: [{ translateX: 30 }, { translateY: -100 }],
  },
  optionDecision: {
    transform: [{ translateX: -140 }, { translateY: -20 }],
  },
  optionTalking: {
    transform: [{ translateX: 84 }, { translateY: -20 }],
  },
  optionChip: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: ICON_SIZE / 2,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  decisionChip: {
    backgroundColor: 'rgba(139,92,246,0.14)',
    borderColor: DECISION_COLOR,
  },
  talkingChip: {
    backgroundColor: 'rgba(91,159,255,0.14)',
    borderColor: Colors.stateIdle,
  },
  optionEmoji: {
    fontSize: 28,
  },
  optionLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: Colors.textSecondary,
  },
  decisionLabel: {
    color: '#C4B5FD',
  },
  talkingLabel: {
    color: '#A9C8FF',
  },
  hintRing: {
    position: 'absolute',
    width: BB_SIZE,
    height: BB_SIZE,
    borderRadius: BB_SIZE / 2,
    borderWidth: 2,
    borderColor: Colors.textPrimary,
  },
  hintDrag: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: Colors.textPrimary,
  },
});
