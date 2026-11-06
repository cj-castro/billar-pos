import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { BackHandler } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../../src/components/ConfirmDialog';
import { FloorScreen } from '../../../src/features/waiter/floor/FloorScreen';

export default function Screen() {
  const { t } = useTranslation('mobile');
  const [confirmExit, setConfirmExit] = useState(false);
  // Floor is the root: hardware back would silently close the app (and the session's socket), so ask first.
  useFocusEffect(
    useCallback(() => {
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
