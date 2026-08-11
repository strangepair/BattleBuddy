import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { ApiConfig } from '../config';

export type NudgeType = 'check_in' | 'streak' | 're_engage';

export interface NudgePayload {
  type: NudgeType;
  title: string;
  body: string;
  route?: 'chat' | 'voice';
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function requestPermissions(): Promise<boolean> {
  if (!Device.isDevice) {
    console.warn('Push notifications require a physical device');
    return false;
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
    },
  });

  return status === 'granted';
}

export async function getExpoPushToken(): Promise<string | null> {
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: projectId ?? undefined,
    });
    return tokenData.data;
  } catch (err) {
    console.error('Failed to get push token:', err);
    return null;
  }
}

export async function registerTokenWithServer(
  token: string,
  userId: string,
): Promise<void> {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';

  try {
    await fetch(`${ApiConfig.CHAT_URL}/push/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, platform, userId }),
    });
  } catch (err) {
    console.error('Failed to register push token:', err);
  }
}

export function parseNudgePayload(
  notification: Notifications.Notification,
): NudgePayload | null {
  const data = notification.request.content.data;
  if (!data?.type) return null;

  return {
    type: data.type as NudgeType,
    title: notification.request.content.title ?? '',
    body: notification.request.content.body ?? '',
    route: data.route as 'chat' | 'voice' | undefined,
  };
}

if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'BattleBuddy',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#2563EB',
  });
}
