import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import HomeButton from '../../src/components/common/HomeButton';
import EdgeEntrance from '../../src/components/common/EdgeEntrance';
import { Colors } from '../../src/theme';

export default function ProfileScreen() {
  return (
    <EdgeEntrance edge="right">
      <View style={styles.root}>
        <HomeButton />
        <SafeAreaView style={styles.container}>
          <Text style={styles.heading}>Profile</Text>
        </SafeAreaView>
      </View>
    </EdgeEntrance>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
});
