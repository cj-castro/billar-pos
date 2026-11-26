import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Local mute of the new-order chime on this device (the server switch `kds_sound_enabled` is separate). */
export const useKdsPrefs = create<{ muted: boolean; setMuted: (v: boolean) => void }>()(
  persist((set) => ({ muted: false, setMuted: (muted) => set({ muted }) }), {
    name: 'bola8.kdsPrefs',
    version: 1,
    storage: createJSONStorage(() => AsyncStorage),
    partialize: (s) => ({ muted: s.muted }),
  }),
);
