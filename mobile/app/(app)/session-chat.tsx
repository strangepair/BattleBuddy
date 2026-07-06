import { useCallback, useEffect } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import ChatBottomSheet from '../../src/components/chat/ChatBottomSheet';
import BBNavOverlay from '../../src/components/common/BBNavOverlay';
import EdgeEntrance from '../../src/components/common/EdgeEntrance';
import EntityBackground from '../../src/components/home/EntityBackground';
import { useSessionStore } from '../../src/stores/sessionStore';
import { useEngagementEngine } from '../../src/services/engagementEngine';
import { Colors } from '../../src/theme';

export default function SessionChatScreen() {
  const endSession = useSessionStore((s) => s.endSession);
  const switchMode = useSessionStore((s) => s.switchMode);
  const onSelfEngaged = useEngagementEngine((s) => s.onUserSelfEngaged);
  const onSessionEndEngagement = useEngagementEngine((s) => s.onSessionEnd);

  useEffect(() => {
    onSelfEngaged();
  }, [onSelfEngaged]);

  const handleClose = useCallback(() => {
    endSession();
    onSessionEndEngagement();
    router.replace('/(app)');
  }, [endSession, onSessionEndEngagement]);

  const handleSwitchToVoice = useCallback(() => {
    switchMode('voice');
    router.replace('/session-voice');
  }, [switchMode]);

  const { width, height } = useWindowDimensions();

  return (
    <EdgeEntrance edge="up">
      <View style={styles.container}>
        {/* Ambient entity behind the translucent sheet — the HomeButton that
            used to sit here rendered inside the status bar (topOffset bypassed
            the safe area) and duplicated the sheet's ✕ as a second exit. */}
        <EntityBackground
          targetColor={Colors.stateIdle}
          energy={0.08}
          center={{ x: width / 2, y: height * 0.3 }}
        />
        <ChatBottomSheet open onClose={handleClose} onSwitchToVoice={handleSwitchToVoice} />
        <BBNavOverlay currentDirection="up" anchor="bottom-right" />
      </View>
    </EdgeEntrance>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
});
