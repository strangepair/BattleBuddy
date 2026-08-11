import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiConfig } from '../../config';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ChatSheetProps {
  onClose: () => void;
}

async function streamFromServer(
  messages: { role: string; content: string }[],
  onToken: (accumulated: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(`${ApiConfig.CHAT_URL}/session/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok || !res.body) throw new Error('Failed to connect');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          let msg = "Sorry, I couldn't connect. Try again in a moment.";
          if (parsed.error.includes('credit balance')) {
            msg = "I'm having a connection issue right now. Give me a minute and try again.";
          }
          throw new Error(msg);
        }
        if (parsed.text) {
          accumulated += parsed.text;
          onToken(accumulated);
        }
      } catch (e) {
        if (e instanceof Error && e.message !== data) throw e;
      }
    }
  }

  return accumulated;
}

export default function ChatSheet({ onClose }: ChatSheetProps) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const updateLastAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === 'assistant') {
        updated[updated.length - 1] = { ...last, content };
      }
      return updated;
    });
  }, []);

  // Auto-greet on mount
  useEffect(() => {
    const greet = async () => {
      const userMsg: Message = { id: 'sys-0', role: 'user', content: "I'm having an urge right now." };
      const assistantMsg: Message = { id: 'greet-1', role: 'assistant', content: '' };
      setMessages([userMsg, assistantMsg]);
      setIsStreaming(true);

      try {
        abortRef.current = new AbortController();
        await streamFromServer(
          [{ role: 'user', content: userMsg.content }],
          updateLastAssistant,
          abortRef.current.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        updateLastAssistant("I'm here for you. Tell me what's going on.");
      } finally {
        setIsStreaming(false);
      }
    };

    greet();
  }, [updateLastAssistant]);

  const sendMessageWithText = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text.trim() };
    const assistantMsg: Message = { id: (Date.now() + 1).toString(), role: 'assistant', content: '' };

    const updatedMessages = [...messages, userMsg];
    setMessages([...updatedMessages, assistantMsg]);
    setInput('');
    setIsStreaming(true);

    try {
      abortRef.current = new AbortController();
      await streamFromServer(
        updatedMessages
          .filter((m) => m.id !== 'sys-0')
          .map((m) => ({ role: m.role, content: m.content })),
        (accumulated) => {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], content: accumulated };
            return updated;
          });
        },
        abortRef.current.signal,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant' && !last.content) {
          updated[updated.length - 1] = { ...last, content: "Sorry, I couldn't connect. Try again in a moment." };
        }
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  }, [messages, isStreaming]);

  const sendMessage = useCallback(() => {
    sendMessageWithText(input);
  }, [input, sendMessageWithText]);

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => {
      if (item.id === 'sys-0') return null;
      return (
        <View style={[styles.messageBubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
          {item.role === 'assistant' && !item.content && isStreaming && (
            <Text style={styles.typing}>...</Text>
          )}
          <Text style={styles.messageText}>{item.content}</Text>
        </View>
      );
    },
    [isStreaming],
  );

  return (
    <View style={[styles.container, { paddingTop: Math.max(insets.top, 59) }]}>
      <View style={styles.safeArea}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Talk to Buddy</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          style={styles.chatArea}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            onLayout={() => flatListRef.current?.scrollToEnd({ animated: false })}
          />

          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder="Type a message..."
              placeholderTextColor="#636366"
              value={input}
              onChangeText={setInput}
              onSubmitEditing={() => { sendMessage(); inputRef.current?.focus(); }}
              returnKeyType="send"
              blurOnSubmit={false}
              editable={!isStreaming}
            />
            <TouchableOpacity
              style={[styles.sendButton, (!input.trim() || isStreaming) && styles.sendDisabled]}
              onPress={() => { sendMessage(); inputRef.current?.focus(); }}
              disabled={!input.trim() || isStreaming}
              activeOpacity={0.7}
            >
              <Text style={styles.sendText}>↑</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#1C1C1E',
    zIndex: 20,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#3A3A3C',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#3A3A3C',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  chatArea: {
    flex: 1,
  },
  messageList: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  messageBubble: {
    maxWidth: '80%',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 8,
  },
  userBubble: {
    backgroundColor: '#2563EB',
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: '#2C2C2E',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    color: '#FFFFFF',
    lineHeight: 22,
  },
  typing: {
    color: '#8E8E93',
    fontSize: 20,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#3A3A3C',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#2C2C2E',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: '#FFFFFF',
    maxHeight: 100,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#2563EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
});
