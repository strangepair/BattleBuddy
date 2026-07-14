import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import FeedPager, { type FeedCard } from '../feed/FeedPager';
import { fetchContentFeed } from '../../services/contentFeedService';
import { Colors, Spacing } from '../../theme';

function titleCase(theme: string): string {
  return theme.replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ContentPaneProps {
  /** The pane's measured height — FeedPager pages must match it exactly. */
  height: number;
  /** "Talk" affordances route back into the conversation, same surface. */
  onOpenChat: () => void;
}

// The Content tab of the One Conversation surface: the existing vertical
// video pager, sized to the pane between the seg bar and the dock instead
// of the full screen.
export default function ContentPane({ height, onOpenChat }: ContentPaneProps) {
  const [cards, setCards] = useState<FeedCard[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [cardEngagements, setCardEngagements] = useState<Record<string, { helped: boolean }>>({});

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

  const handleCardVisible = useCallback(() => {}, []);

  const empty = (
    <View style={styles.center}>
      <Text style={styles.emptyIcon}>🎬</Text>
      <Text style={styles.emptyTitle}>Content is on its way</Text>
      <Text style={styles.emptySubtitle}>We're still stocking the feed — check back soon.</Text>
    </View>
  );

  if (cards === null && !loadError) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.coral} />
      </View>
    );
  }

  if (loadError || (cards !== null && cards.length <= 1)) {
    return empty;
  }

  return (
    <FeedPager
      cards={cards!}
      onOpenChat={onOpenChat}
      onCardVisible={handleCardVisible}
      cardEngagements={cardEngagements}
      onHelpedTap={handleHelpedTap}
      pageHeight={height}
    />
  );
}

const styles = StyleSheet.create({
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
});
