import { useCallback, useMemo, useRef } from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useSessionStore, type SessionMessage } from '../../stores/sessionStore';
import { Colors, Spacing } from '../../theme';

// The One Conversation stream. Phase 1 renders message bubbles (and the
// previous-session separator) exactly as ChatBottomSheet did; Phase 3 extends
// the item union with receipts, phase banners, and inline cards.

function isHiddenSeed(m: SessionMessage): boolean {
  return m.role === 'user' && m.content.startsWith('[') && m.content.endsWith(']');
}

/** Dashboard/content CTAs prefix the turn with bracketed context for the
    model ("[Looking at the arc card…] Let's talk about this."). The context
    rides to the API; the stream shows only the human part. Phase 5 renders
    the prefix as a reply-quote instead of dropping it. */
function displayContent(m: SessionMessage): string {
  if (m.role === 'user' && m.content.startsWith('[')) {
    const close = m.content.indexOf(']');
    if (close > 0 && close < m.content.length - 1) {
      return m.content.slice(close + 1).trim();
    }
  }
  return m.content;
}

export default function ConversationStream() {
  const messages = useSessionStore((s) => s.messages);
  const previousMessages = useSessionStore((s) => s.previousMessages);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const listRef = useRef<FlatList>(null);

  const displayMessages = useMemo(() => {
    const current = messages.filter((m) => !isHiddenSeed(m));
    if (previousMessages.length > 0) {
      const prevFiltered = previousMessages.filter(
        (m) => m.content.length > 0 && !isHiddenSeed(m),
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
      const content = displayContent(item);
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
            <Text style={styles.messageText}>{content}</Text>
          )}
        </View>
      );
    },
    [isStreaming],
  );

  return (
    <FlatList
      ref={listRef}
      data={[...displayMessages].reverse()}
      renderItem={renderMessage}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      inverted
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  list: {
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
