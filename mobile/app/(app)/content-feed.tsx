import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import FeedPager, { type FeedCard } from '../../src/components/feed/FeedPager';
import EdgeEntrance from '../../src/components/common/EdgeEntrance';
import { fetchContentFeed } from '../../src/services/contentFeedService';
import { Colors, Spacing } from '../../src/theme';

function titleCase(theme: string): string {
  return theme.replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ContentFeedScreen() {
  const [cards, setCards] = useState<FeedCard[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [cardEngagements, setCardEngagements] = useState<Record<string, { helped: boolean }>>({});
  const cardTimestamps = useRef<Record<number, number>>({});

  useEffect(() => {
    let cancelled = false;

    fetchContentFeed()
      .then((videos) => {
        if (cancelled) return;
        const videoCards: FeedCard[] = videos.map((video) => ({
          id: video.id,
          type: 'video',
          mediaUri: video.r2Url,
          overlayText: video.theme ? titleCase(video.theme) : undefined,
        }));
        setCards([...videoCards, { id: 'chat-prompt', type: 'chat' }]);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleHelpedTap = useCallback((cardId: string) => {
    setCardEngagements((prev) => ({
      ...prev,
      [cardId]: { helped: !prev[cardId]?.helped },
    }));
  }, []);

  const handleCardVisible = useCallback((index: number) => {
    cardTimestamps.current[index] = Date.now();
  }, []);

  const handleOpenChat = useCallback(() => {
    router.push('/(app)/session-chat');
  }, []);

  const goHome = useCallback(() => router.replace('/(app)/'), []);
  const goVoice = useCallback(() => router.push('/session-voice'), []);

  return (
    <EdgeEntrance edge="left">
    <View style={styles.container}>
      <StatusBar style="light" />

      {cards === null && !loadError && (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      )}

      {loadError && (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🎬</Text>
          <Text style={styles.emptyTitle}>Content is on its way</Text>
          <Text style={styles.emptySubtitle}>
            We're still stocking the feed — check back soon.
          </Text>
        </View>
      )}

      {cards !== null && !loadError && cards.length <= 1 && (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🎬</Text>
          <Text style={styles.emptyTitle}>Content is on its way</Text>
          <Text style={styles.emptySubtitle}>
            We're still stocking the feed — check back soon.
          </Text>
        </View>
      )}

      {cards !== null && !loadError && cards.length > 1 && (
        <FeedPager
          cards={cards}
          onOpenChat={handleOpenChat}
          onCardVisible={handleCardVisible}
          cardEngagements={cardEngagements}
          onHelpedTap={handleHelpedTap}
        />
      )}

      <View style={styles.topBar}>
        <TouchableOpacity style={styles.iconButton} onPress={goVoice} activeOpacity={0.7} hitSlop={10}>
          <Ionicons name="mic" size={20} color={Colors.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconButton} onPress={goHome} activeOpacity={0.7} hitSlop={10}>
          <Ionicons name="home" size={20} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>
    </View>
    </EdgeEntrance>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
  emptyIcon: { fontSize: 40, marginBottom: Spacing.sm },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  emptySubtitle: { fontSize: 14, color: Colors.textTertiary, textAlign: 'center', lineHeight: 20 },
  topBar: {
    position: 'absolute',
    top: 60,
    right: 20,
    flexDirection: 'row',
    gap: 10,
    zIndex: 10,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
