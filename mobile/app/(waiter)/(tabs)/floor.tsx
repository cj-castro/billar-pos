import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../../src/components/ConfirmDialog';
import { FloorScreen } from '../../../src/features/waiter/floor/FloorScreen';

export default function Screen() {
  const { t } = useTranslation('mobile');
  const [confirmExit, setConfirmExit] = useState(false);
  // Floor is the root: hardware back would silently close the app (and the session's socket), so ask first.
  useFocusEffect(
    useCallback(() => {
      // Android-only: iOS has no hardware back button (BackHandler is a no-op there).
      if (Platform.OS !== 'android') return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        setConfirmExit(true);
        return true;
      });
      return () => sub.remove();
    }, []),
  );
  return (
    <>
      <FloorScreen />
      <ConfirmDialog
        visible={confirmExit}
        title={t('waiter.floor.exitTitle')}
        confirmLabel={t('waiter.floor.exitYes')}
        cancelLabel={t('waiter.floor.exitNo')}
        onConfirm={() => BackHandler.exitApp()}
        onCancel={() => setConfirmExit(false)}
        testID="exit-dialog"
      />
    </>
  );
}
