import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { colors, elevation, radii, spacing } from '../theme/tokens';
import { AppButton } from './AppButton';
import { AppText } from './AppText';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Confirm becomes a danger button; cancel stays the safe, prominent choice. */
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}

/** Centered modal. Back / outside tap = cancel, except while `loading`. */
export function ConfirmDialog({ visible, title, message, confirmLabel, cancelLabel, destructive, loading, onConfirm, onCancel, testID = 'confirm-dialog' }: ConfirmDialogProps) {
  const cancel = () => {
    if (!loading) onCancel();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.scrim} onPress={cancel} accessible={false} testID={`${testID}-scrim`}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityViewIsModal testID={testID}>
          <AppText variant="headline" accessibilityRole="header">
            {title}
          </AppText>
          {!!message && (
            <AppText variant="body" color={colors.textSecondary}>
              {message}
            </AppText>
          )}
          <View style={styles.actions}>
            <AppButton label={cancelLabel} variant="secondary" size="lg" onPress={cancel} disabled={loading} testID={`${testID}-cancel`} style={styles.btn} />
            <AppButton
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              size="lg"
              onPress={onConfirm}
              loading={loading}
              testID={`${testID}-confirm`}
              style={styles.btn}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', alignItems: 'center', justifyContent: 'center', padding: spacing.s6 },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: spacing.s6,
    gap: spacing.s3,
    elevation: elevation.e3,
  },
  actions: { gap: spacing.s2, marginTop: spacing.s3 },
  btn: { alignSelf: 'stretch' },
});
