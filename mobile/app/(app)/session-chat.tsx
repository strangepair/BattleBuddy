import { useCallback, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import ChatBottomSheet from '../../src/components/chat/ChatBottomSheet';
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

  return (
    <View style={styles.container}>
      <ChatBottomSheet open onClose={handleClose} onSwitchToVoice={handleSwitchToVoice} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
});
