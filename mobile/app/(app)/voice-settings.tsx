import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ApiConfig } from '../../src/config';
import { Colors, Spacing, Radii } from '../../src/theme';
import { useAuthStore } from '../../src/stores/authStore';
import { getAuthToken } from '../../src/services/supabase';
import HamburgerMenu from '../../src/components/common/HamburgerMenu';

const VOICES = [
  { id: 'aura-2-arcas-en', name: 'Arcas', style: 'Calm male' },
  { id: 'aura-2-apollo-en', name: 'Apollo', style: 'Confident male' },
  { id: 'aura-helios-en', name: 'Helios', style: 'Friendly male' },
  { id: 'aura-2-orion-en', name: 'Orion', style: 'Deep male' },
  { id: 'aura-2-zeus-en', name: 'Zeus', style: 'Authoritative male' },
  { id: 'aura-2-theia-en', name: 'Theia', style: 'Warm female' },
  { id: 'aura-2-athena-en', name: 'Athena', style: 'Professional female' },
  { id: 'aura-2-luna-en', name: 'Luna', style: 'Soft female' },
  { id: 'aura-stella-en', name: 'Stella', style: 'Bright female' },
];

export default function VoiceSettingsScreen() {
  const userId = useAuthStore((s) => s.user?.id);
  const [currentVoice, setCurrentVoice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const token = await getAuthToken();
        const res = await fetch(`${ApiConfig.CHAT_URL}/context/profile/${encodeURIComponent(userId)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json();
        setCurrentVoice(data.profile?.voice_preference ?? 'aura-2-arcas-en');
      } catch {
        setCurrentVoice('aura-2-arcas-en');
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  const selectVoice = useCallback(async (voiceId: string) => {
    if (!userId) return;
    setSaving(voiceId);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${ApiConfig.CHAT_URL}/context/profile/${encodeURIComponent(userId)}/voice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ voice: voiceId }),
      });
      const data = await res.json();
      if (data.ok) {
        setCurrentVoice(voiceId);
      }
    } catch {}
    setSaving(null);
  }, [userId]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Buddy's Voice</Text>
        <HamburgerMenu />
      </View>

      <Text style={styles.subtitle}>
        Choose how your buddy sounds in voice mode. Changes take effect on the next voice session.
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : !userId ? (
        <View style={styles.center}>
          <Text style={styles.subtitle}>Sign in to choose your buddy's voice.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {VOICES.map((voice) => {
            const isActive = voice.id === currentVoice;
            const isSaving = voice.id === saving;
            return (
              <TouchableOpacity
                key={voice.id}
                style={[styles.voiceCard, isActive && styles.voiceCardActive]}
                onPress={() => selectVoice(voice.id)}
                activeOpacity={0.7}
                disabled={isSaving}
              >
                <View style={styles.voiceInfo}>
                  <Text style={[styles.voiceName, isActive && styles.voiceNameActive]}>
                    {voice.name}
                  </Text>
                  <Text style={styles.voiceStyle}>{voice.style}</Text>
                </View>
                {isSaving ? (
                  <ActivityIndicator size="small" color={Colors.coral} />
                ) : isActive ? (
                  <Text style={styles.checkmark}>✓</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  backButton: { paddingVertical: Spacing.xs, paddingRight: Spacing.sm, minWidth: 60 },
  backText: { color: Colors.coral, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  spacer: { minWidth: 60 },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    lineHeight: 20,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.xxl, gap: Spacing.sm },
  voiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  voiceCardActive: {
    borderColor: Colors.coral,
    backgroundColor: 'rgba(232, 98, 74, 0.08)',
  },
  voiceInfo: { gap: 2 },
  voiceName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  voiceNameActive: { color: Colors.coral },
  voiceStyle: { fontSize: 13, color: Colors.textSecondary },
  checkmark: { fontSize: 20, fontWeight: '700', color: Colors.coral },
});
