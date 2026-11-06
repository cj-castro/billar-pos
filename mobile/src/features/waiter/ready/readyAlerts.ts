import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Local toggles on the "Yo" screen. Both default on. */
export const useAlertPrefs = create<{ alerts: boolean; sound: boolean; setAlerts: (v: boolean) => void; setSound: (v: boolean) => void }>()(
  persist(
    (set) => ({ alerts: true, sound: true, setAlerts: (alerts) => set({ alerts }), setSound: (sound) => set({ sound }) }),
    { name: 'bola8.alertPrefs', version: 1, storage: createJSONStorage(() => AsyncStorage), partialize: (s) => ({ alerts: s.alerts, sound: s.sound }) },
  ),
);

// The native modules are loaded lazily and every call is best-effort: an alert must never break the READY toast.
const safe = async (fn: () => Promise<unknown> | unknown) => {
  try {
    await fn();
  } catch {
    // no sound / no notification is acceptable
  }
};

/** 200 ms two-tone chime. */
export function playChime() {
  return safe(async () => {
    const { createAudioPlayer } = await import('expo-audio');
    const player = createAudioPlayer(require('../../../../assets/sounds/chime.wav'));
    player.play();
    setTimeout(() => safe(() => player.remove()), 1500);
  });
}

/** Ask once (the OS remembers the answer). Returns whether notifications are allowed. */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const N = await import('expo-notifications');
    const cur = await N.getPermissionsAsync();
    if (cur.granted) return true;
    if (!cur.canAskAgain) return false;
    return (await N.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** Local notification right now (app in background). Android needs a channel first. */
export function notifyReady(title: string, ticketId: string) {
  return safe(async () => {
    const N = await import('expo-notifications');
    if (Platform.OS === 'android') await N.setNotificationChannelAsync('ready', { name: 'Listos', importance: N.AndroidImportance.HIGH });
    if (!(await N.getPermissionsAsync()).granted) return;
    await N.scheduleNotificationAsync({ content: { title, data: { route: '/ready', ticketId } }, trigger: null });
  });
}

/** Tap on a notification -> the Listos tab. Returns the unsubscribe. */
export function onNotificationTap(go: (route: string) => void): () => void {
  let off = () => {};
  let dead = false;
  void safe(async () => {
    const N = await import('expo-notifications');
    const sub = N.addNotificationResponseReceivedListener((r) => {
      const route = r.notification.request.content.data?.route;
      if (typeof route === 'string') go(route);
    });
    if (dead) sub.remove();
    else off = () => sub.remove();
  });
  return () => {
    dead = true;
    off();
  };
}
