import { useCallback, useEffect, useRef, useState } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import AppDrawer from '../../src/components/drawer/AppDrawer';
import { useUIStore } from '../../src/stores/uiStore';
import { useOnboarding } from '../../src/hooks/useOnboarding';
import { usePushSetup } from '../../src/hooks/usePushSetup';
import { FeatureFlags } from '../../src/config';
import { Colors } from '../../src/theme';
import { startSyncWorker } from '../../src/services/syncWorker';
import { getDb } from '../../src/services/localDb';
import { AppState } from 'react-native';
import { startBiometricStream } from '../../src/services/biometricStream';
import { startRiskWindowMonitor } from '../../src/services/engagementEngine';
import { useSessionStore, hydrateSessionStore } from '../../src/stores/sessionStore';
import { useAuthStore } from '../../src/stores/authStore';
import { ApiConfig } from '../../src/config';

export default function AppLayout() {
  const drawerOpen = useUIStore((s) => s.drawerOpen);
  const closeDrawer = useUIStore((s) => s.closeDrawer);
  const { complete: onboardingComplete } = useOnboarding();
  const authUser = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.loading);
  const initAuth = useAuthStore((s) => s.initialize);
  const passwordRecovery = useAuthStore((s) => s.passwordRecovery);
  const segments = useSegments();

  // Initialize auth on mount
  useEffect(() => {
    initAuth();
  }, [initAuth]);

  usePushSetup(null, FeatureFlags.proactiveNudges);

  // Hydrate persisted session data (session count, profile, history) — this
  // data is namespaced per signed-in user (see scopedStorage.ts), so re-run
  // whenever the user changes (sign-in/sign-out/switch accounts) rather than
  // once ever, or a new user would see the previous user's cached data.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (authLoading) return;
    hydrateSessionStore().then(() => setHydrated(true));
  }, [authLoading, authUser?.id]);

  useEffect(() => {
    if (!FeatureFlags.offlineResilience) return;
    getDb().catch(() => {});
    const stopSync = startSyncWorker();
    return stopSync;
  }, []);

  // Start biometric stream (HealthKit on iOS)
  useEffect(() => {
    let stopBio: (() => void) | null = null;
    startBiometricStream().then((stop) => { stopBio = stop; });
    return () => { stopBio?.(); };
  }, []);

  // Start risk window monitor when user is authenticated
  useEffect(() => {
    if (!authUser?.id) return;
    let stopRisk: (() => void) | null = null;
    startRiskWindowMonitor(authUser.id).then((stop) => { stopRisk = stop; });
    return () => { stopRisk?.(); };
  }, [authUser?.id]);

  // Auto-generate session report when app backgrounds with an active session
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        const session = useSessionStore.getState();
        if (session.isActive && session.messages.length >= 2) {
          const nonEmpty = session.messages.filter(m => m.content.length > 0);
          if (nonEmpty.length >= 2) {
            import('../../src/services/outcomeRecorder').then(({ recordOutcome }) => {
              recordOutcome({
                userId: useAuthStore.getState().user?.id ?? null,
                sessionId: session.sessionId || 'bg-save',
                mode: session.mode,
                outcome: 'unsure',
                helped: false,
                startedAt: session.startedAt || Date.now(),
                endedAt: Date.now(),
                triggerContext: session.triggerContext,
                messages: session.messages,
                intensityStart: null,
                intensityEnd: null,
              });
            }).catch(() => {});
          }
        }
      }
    });
    return () => sub.remove();
  }, []);

  // Seed user name into profile (once, outside routing effect)
  useEffect(() => {
    if (!authUser?.name) return;
    const state = useSessionStore.getState();
    if (state.profileSummary.includes('New user')) {
      state.setProfileSummary(`Name: ${authUser.name}. New user — getting to know them.`);
    }
  }, [authUser?.name]);

  // Redirect: auth → onboarding. Once onboarding is complete, land on the hub
  // (index) and let the user choose a direction themselves — no auto-launch.
  const currentRoute = useRef<string | null>(null);
  useEffect(() => {
    if (authLoading) return;
    // A recovery deep link lands here with a session but no business being
    // routed into onboarding/hub yet — let reset-password.tsx own navigation
    // until the new password is saved. Segments check covers the cold-start
    // case where passwordRecovery hasn't been set yet but the deep link
    // already opened straight into this route.
    if (passwordRecovery || segments.includes('reset-password')) return;

    let target: string | null = null;
    if (!authUser) {
      target = '/(app)/auth';
    } else if (onboardingComplete === false) {
      target = '/(app)/onboarding';
    } else if (
      onboardingComplete === true &&
      (currentRoute.current === '/(app)/auth' || currentRoute.current === '/(app)/onboarding')
    ) {
      // Just finished auth/onboarding — escape to the hub. Guarded so this
      // doesn't fire (and remount the hub) on every normal cold launch.
      target = '/(app)/';
    }

    if (!target || target === currentRoute.current) return;
    currentRoute.current = target;

    setTimeout(() => router.replace(target!), 0);
  }, [authLoading, authUser, onboardingComplete]);

  const handleNavigate = useCallback((key: string) => {
    closeDrawer();
    switch (key) {
      case 'history':
        router.push('/history');
        break;
      case 'analytics':
        router.push('/analytics');
        break;
      case 'goals':
        router.push('/goals');
        break;
      case 'routines':
        router.push('/routines');
        break;
      case 'preferences':
        router.push('/preferences');
        break;
      case 'insights':
        router.push('/insights');
        break;
    }
  }, [closeDrawer]);

  // Don't render drawer until onboarding state is known
  if (authLoading || onboardingComplete === null || !hydrated) return null;

  return (
    <AppDrawer
      open={drawerOpen}
      onClose={closeDrawer}
      onNavigate={handleNavigate}
    >
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Colors.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="auth" options={{ animation: 'fade' }} />
        <Stack.Screen name="reset-password" options={{ animation: 'fade' }} />
        <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        <Stack.Screen name="disclaimer" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="history" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="analytics" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="goals" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="routines" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="preferences" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="voice-settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="insights" options={{ animation: 'slide_from_right' }} />
        {/* Hub destinations animate themselves via EdgeEntrance, sliding in
            from their fixed edge relative to home — native transition is
            disabled here so the two don't stack. */}
        <Stack.Screen name="content-feed" options={{ animation: 'none' }} />
        <Stack.Screen name="profile" options={{ animation: 'none' }} />
        <Stack.Screen name="session-chat" options={{ animation: 'none' }} />
        {/* The One Conversation surface — replaces session-chat/-voice and
            the standalone dashboards as the phases land. */}
        <Stack.Screen name="session" options={{ animation: 'none' }} />
      </Stack>
    </AppDrawer>
  );
}
