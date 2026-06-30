import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Colors, Spacing } from '../../src/theme';

export default function ProfileScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.heading}>Profile</Text>
      <TouchableOpacity style={styles.homeButton} onPress={() => router.replace('/(app)')} activeOpacity={0.7}>
        <Text style={styles.homeButtonText}>Home</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  homeButton: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.coral,
  },
  homeButtonText: {
    color: Colors.coral,
    fontSize: 16,
    fontWeight: '600',
  },
});
