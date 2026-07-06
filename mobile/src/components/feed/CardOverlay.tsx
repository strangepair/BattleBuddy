import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../theme';

interface CardOverlayProps {
  text?: string;
  onHelpedTap: () => void;
  helped: boolean;
}

export default function CardOverlay({ text, onHelpedTap, helped }: CardOverlayProps) {
  return (
    <>
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0.85)']}
        locations={[0, 0.5, 1]}
        style={styles.gradient}
      />

      {text && (
        <View style={styles.textContainer}>
          <Text style={styles.overlayText}>{text}</Text>
        </View>
      )}

      <View style={styles.actionContainer}>
        <TouchableOpacity
          style={[styles.helpedButton, helped && styles.helpedButtonActive]}
          onPress={onHelpedTap}
          activeOpacity={0.7}
        >
          <Ionicons
            name={helped ? 'heart' : 'heart-outline'}
            size={22}
            color={helped ? Colors.coral : 'rgba(255,255,255,0.9)'}
            style={styles.helpedIcon}
          />
          <Text style={[styles.helpedLabel, helped && styles.helpedLabelActive]}>
            {helped ? 'Helped' : 'This helped'}
          </Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  gradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '50%',
  },
  textContainer: {
    position: 'absolute',
    bottom: 120,
    left: 24,
    right: 80,
  },
  overlayText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    lineHeight: 28,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  actionContainer: {
    position: 'absolute',
    right: 16,
    bottom: 140,
    alignItems: 'center',
  },
  helpedButton: {
    alignItems: 'center',
    padding: 8,
  },
  helpedButtonActive: {},
  helpedIcon: {
    fontSize: 32,
  },
  helpedLabel: {
    color: '#AEAEB2',
    fontSize: 12,
    marginTop: 4,
  },
  helpedLabelActive: {
    color: '#E8624A',
  },
});
