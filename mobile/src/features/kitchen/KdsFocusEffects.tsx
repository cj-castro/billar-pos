import { useFocusEffect } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback } from 'react';
import { BackHandler } from 'react-native';

const TAG = 'kds';

/**
 * Screen stays awake while the KDS route is focused. `blockBack` swallows the hardware back button
 * (KDS root must not be exited by accident, SCREEN_STATE_MATRIX K-01 "Navigation").
 */
export function KdsFocusEffects({ blockBack }: { blockBack?: boolean }) {
  useFocusEffect(
    useCallback(() => {
      activateKeepAwakeAsync(TAG).catch(() => {});
      const sub = blockBack ? BackHandler.addEventListener('hardwareBackPress', () => true) : undefined;
      return () => {
        deactivateKeepAwake(TAG).catch(() => {});
        sub?.remove();
      };
    }, [blockBack]),
  );
  return null;
}
