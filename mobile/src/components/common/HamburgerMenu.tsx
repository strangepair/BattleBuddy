import { TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../theme';
import { useUIStore } from '../../stores/uiStore';

export default function HamburgerMenu() {
  const openMenu = useUIStore((s) => s.openMenu);

  return (
    <TouchableOpacity
      onPress={openMenu}
      style={styles.button}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Open menu"
    >
      <Ionicons name="menu-outline" size={26} color={Colors.textPrimary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // A full 44x44 target (Apple's HIG minimum) rather than the icon's own ~26pt
  // box, plus hitSlop on top. ScreenHeader's rightSlot is already minWidth 44,
  // so this changes nothing on the screens that render it there.
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
