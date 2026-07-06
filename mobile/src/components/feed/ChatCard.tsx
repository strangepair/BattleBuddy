import { View, Text, StyleSheet, Dimensions, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface ChatCardProps {
  onOpenChat: () => void;
}

export default function ChatCard({ onOpenChat }: ChatCardProps) {
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Ionicons name="chatbubbles-outline" size={44} color="rgba(255,255,255,0.85)" style={styles.emoji} />
        <Text style={styles.heading}>Want to talk it through?</Text>
        <Text style={styles.subtext}>
          Your buddy is here to listen and help you work through the urge.
        </Text>
        <TouchableOpacity style={styles.chatButton} onPress={onOpenChat} activeOpacity={0.85}>
          <Text style={styles.chatButtonText}>Talk to Buddy</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    backgroundColor: '#1C1C1E',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emoji: {
    fontSize: 64,
    marginBottom: 24,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtext: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 40,
  },
  chatButton: {
    backgroundColor: '#E8624A',
    borderRadius: 28,
    paddingVertical: 18,
    paddingHorizontal: 48,
  },
  chatButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
});
