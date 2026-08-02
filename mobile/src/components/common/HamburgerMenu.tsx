import { TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../theme';
import { useUIStore } from '../../stores/uiStore';

export default function HamburgerMenu() {
  const openMenu = useUIStore((s) => s.openMenu);

  return (
    <TouchableOpacity onPress={openMenu} style={styles.button} hitSlop={12}>
      <Ionicons name="menu-outline" size={26} color={Colors.textPrimary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingRight: 4,
  },
});
