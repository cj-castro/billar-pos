import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { radii, spacing, tableStatusStyle, type TableState } from '../theme/tokens';
import { elapsedSince, useElapsed } from '../utils/time';
import { AppText } from './AppText';

export interface TableCardProps {
  code: string;
  kind: 'POOL' | 'TABLE' | 'BAR';
  state: TableState;
  customerName?: string | null;
  /** ISO start of the pool timer. */
  timerStart?: string | null;
  timerStopped?: boolean;
  /** Small caption next to the timer (e.g. "estimado": amounts/time are server-final only on close). */
  timerLabel?: string;
  onPress?: () => void;
  /** Offline: dimmed, timer frozen with "~". */
  stale?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function TableCard({ code, kind, state, customerName, timerStart, timerStopped, timerLabel, onPress, stale, disabled, testID }: TableCardProps) {
  const { t } = useTranslation('mobile');
  const st = tableStatusStyle(state);
  const pool = kind === 'POOL';
  const frozen = !!(stale || timerStopped);
  const live = useElapsed(pool && timerStart && !frozen ? timerStart : null);
  const timer = pool && timerStart ? (frozen ? `~${elapsedSince(timerStart)}` : live) : '';
  const inactive = state === 'INACTIVE';
  const stateText = t(st.labelKey);
  const short = state === 'BILL_REQUESTED' ? t('table.billShort') : stateText;
  const label = [t('table.a11y', { code, state: stateText }), customerName, timer ? t('table.withTimer', { timer }) : null].filter(Boolean).join(', ');

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive || !!disabled }}
      onPress={inactive || disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.card,
        {
          minHeight: pool ? 76 : 68,
          backgroundColor: st.bg,
          borderColor: st.border,
          borderStyle: inactive ? 'dashed' : 'solid',
          opacity: stale ? 0.7 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <AppText variant="title" numberOfLines={1}>
        {code}
      </AppText>
      <View style={styles.row}>
        <MaterialCommunityIcons name={st.icon} size={14} color={st.fg} />
        <AppText variant="caption" bold color={st.fg} numberOfLines={1}>
          {short}
        </AppText>
      </View>
      {!!customerName && (
        <AppText variant="label" numberOfLines={1}>
          {customerName}
        </AppText>
      )}
      {!!timer && (
        <View style={styles.row}>
          <AppText variant="bodyLg" bold style={styles.timer}>
            {timer}
          </AppText>
          {!!timerLabel && (
            <AppText variant="caption" color={st.fg}>
              {timerLabel}
            </AppText>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, borderWidth: 1.5, borderRadius: radii.md, padding: spacing.s3, justifyContent: 'center', gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timer: { fontSize: 20, fontVariant: ['tabular-nums'] },
});
