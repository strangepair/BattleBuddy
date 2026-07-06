import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useSessionStore, type SessionMessage } from '../../stores/sessionStore';
import { useSessionChat } from '../../hooks/useSessionChat';
import { fetchUserProfile } from '../../services/profileBuilder';
import TriggerCapture from '../session/TriggerCapture';
import { Colors, Spacing } from '../../theme';

interface ChatBottomSheetProps {
  open: boolean;
  onClose: () => void;
  onSwitchToVoice?: () => void;
}

export default function ChatBottomSheet({ open, onClose, onSwitchToVoice }: ChatBottomSheetProps) {
  const [input, setInput] = useState('');
  const [showTrigger, setShowTrigger] = useState(false);
  const [hasGreeted, setHasGreeted] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();

  const messages = useSessionStore((s) => s.messages);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const isActive = useSessionStore((s) => s.isActive);
  const previousMessages = useSessionStore((s) => s.previousMessages);
  const startSession = useSessionStore((s) => s.startSession);
  const setTriggerContext = useSessionStore((s) => s.setTriggerContext);
  const setProfileSummary = useSessionStore((s) => s.setProfileSummary);
  const setRecentHistory = useSessionStore((s) => s.setRecentHistory);
  const { sendMessage, greet, abort } = useSessionChat();

  useEffect(() => {
    return () => abort();
  }, [abort]);

  // Auto-greet immediately when sheet opens
  useEffect(() => {
    if (!open || hasGreeted) return;

    if (!isActive) {
      startSession('text');
    }
    setHasGreeted(true);

    fetchUserProfile(null).then((profile) => {
      setProfileSummary(profile.summary);
      setRecentHistory(profile.recentHistory);
    });

    greet();
  }, [open, hasGreeted, isActive, startSession, setProfileSummary, setRecentHistory, greet]);

  const handleTriggerComplete = useCallback(
    (trigger: string, intensity: number) => {
      setTriggerContext({
        trigger,
        intensity,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      setShowTrigger(false);
      setHasGreeted(true);
      greet();
    },
    [setTriggerContext, greet],
  );

  const handleTriggerSkip = useCallback(() => {
    setShowTrigger(false);
    setHasGreeted(true);
    greet();
  }, [greet]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    sendMessage(text);
  }, [input, isStreaming, sendMessage]);

  const handleSwitchToVoice = useCallback(() => {
    onSwitchToVoice?.();
  }, [onSwitchToVoice]);

  // Filter out the hidden seed message for display
  const displayMessages = useMemo(() => {
    const current = messages.filter((item) => {
      if (item.role === 'user' && item.content.startsWith('[') && item.content.endsWith(']')) {
        return false;
      }
      return true;
    });

    // Prepend previous session messages with a separator
    if (previousMessages.length > 0) {
      const prevFiltered = previousMessages.filter(m =>
        m.content.length > 0 && !(m.content.startsWith('[') && m.content.endsWith(']'))
      );
      if (prevFiltered.length > 0) {
        const separator: SessionMessage = {
          id: 'prev-separator',
          role: 'assistant',
          content: '── previous session ──',
          mode: 'text',
          timestamp: 0,
        };
        return [...prevFiltered, separator, ...current];
      }
    }
    return current;
  }, [messages, previousMessages]);

  const renderMessage = useCallback(
    ({ item }: { item: SessionMessage }) => {
      if (item.id === 'prev-separator') {
        return (
          <View style={styles.separator}>
            <View style={styles.separatorLine} />
            <Text style={styles.separatorText}>previous session</Text>
            <View style={styles.separatorLine} />
          </View>
        );
      }
      const isAssistant = item.role === 'assistant';
      return (
        <View style={[styles.bubble, isAssistant ? styles.assistantBubble : styles.userBubble]}>
          {isAssistant && !item.content && isStreaming && (
            <Text style={styles.typing}>...</Text>
          )}
          {item.mode === 'voice' && isAssistant && (
            <Text style={styles.modeTag}>via voice</Text>
          )}
          {isAssistant && item.content ? (
            <Markdown style={mdStyles}>{item.content}</Markdown>
          ) : (
            <Text style={styles.messageText}>{item.content}</Text>
          )}
        </View>
      );
    },
    [isStreaming],
  );

  if (!open) return null;

  return (
    <View style={[styles.overlay, { paddingTop: insets.top }]}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Talk to Buddy</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        {showTrigger ? (
          <TriggerCapture onComplete={handleTriggerComplete} onSkip={handleTriggerSkip} />
        ) : (
          <>
            {/* Messages — inverted FlatList so newest is always at bottom */}
            <FlatList
              ref={flatListRef}
              data={[...displayMessages].reverse()}
              renderItem={renderMessage}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messageList}
              inverted
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
            />

            {/* Voice switch FAB — floats above input */}
            {onSwitchToVoice && (
              <TouchableOpacity
                onPress={handleSwitchToVoice}
                style={styles.voiceFab}
                activeOpacity={0.7}
              >
                <Text style={styles.voiceFabIcon}>🎙</Text>
                <Text style={styles.voiceFabLabel}>Switch to voice</Text>
              </TouchableOpacity>
            )}

            {/* Input — pinned to bottom */}
            <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <TextInput
                ref={inputRef}
                style={styles.input}
                placeholder="Type a message..."
                placeholderTextColor={Colors.textTertiary}
                value={input}
                onChangeText={setInput}
                onSubmitEditing={() => { handleSend(); inputRef.current?.focus(); }}
                returnKeyType="send"
                blurOnSubmit={false}
                editable={!isStreaming}
                multiline
                textAlignVertical="top"
              />
              <TouchableOpacity
                style={[styles.sendButton, (!input.trim() || isStreaming) && styles.sendDisabled]}
                onPress={() => { handleSend(); inputRef.current?.focus(); }}
                disabled={!input.trim() || isStreaming}
                activeOpacity={0.7}
              >
                <Text style={styles.sendText}>↑</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    // Translucent so the screen's ambient entity breathes through behind the
    // conversation — same organism as the hub, dimmed under the messages.
    backgroundColor: 'rgba(10,10,12,0.86)',
    zIndex: 20,
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.surfaceBorder,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    color: Colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  voiceFab: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: Colors.coral,
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 6,
    marginBottom: 8,
  },
  voiceFabIcon: {
    fontSize: 16,
  },
  voiceFabLabel: {
    color: Colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  separator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
  },
  separatorLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.surfaceBorder,
  },
  separatorText: {
    fontSize: 11,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  messageList: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 8,
  },
  userBubble: {
    backgroundColor: Colors.coral,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: Colors.surface,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    color: Colors.textPrimary,
    lineHeight: 22,
  },
  modeTag: {
    fontSize: 10,
    color: Colors.textTertiary,
    marginBottom: 2,
    fontStyle: 'italic',
  },
  typing: {
    color: Colors.textSecondary,
    fontSize: 20,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
    gap: 8,
    backgroundColor: Colors.background,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: Colors.textPrimary,
    minHeight: 40,
    maxHeight: 120,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.coral,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendText: {
    color: Colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
});

const mdStyles = StyleSheet.create({
  body: {
    color: Colors.textPrimary,
    fontSize: 16,
    lineHeight: 24,
  },
  strong: {
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  em: {
    fontStyle: 'italic',
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 8,
  },
  bullet_list: {
    marginTop: 4,
    marginBottom: 4,
  },
  ordered_list: {
    marginTop: 4,
    marginBottom: 4,
  },
  list_item: {
    marginBottom: 4,
  },
  bullet_list_icon: {
    color: Colors.coral,
    fontSize: 16,
    lineHeight: 24,
    marginRight: 8,
  },
  code_inline: {
    backgroundColor: Colors.surfaceBorder,
    color: Colors.coral,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontSize: 14,
    fontFamily: 'Menlo',
  },
  fence: {
    backgroundColor: Colors.surfaceBorder,
    borderRadius: 8,
    padding: 12,
    marginVertical: 4,
  },
  fence_body: {
    color: Colors.textPrimary,
    fontSize: 14,
    fontFamily: 'Menlo',
  },
  link: {
    color: Colors.coral,
    textDecorationLine: 'underline',
  },
  heading1: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 8,
  },
  heading2: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 6,
  },
  heading3: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  hr: {
    backgroundColor: Colors.surfaceBorder,
    height: 1,
    marginVertical: 8,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.coral,
    paddingLeft: 12,
    marginVertical: 4,
    opacity: 0.9,
  },
});
