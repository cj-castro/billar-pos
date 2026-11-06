import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ageLevelFor, type KdsThresholds } from '../features/kitchen/kdsModel';
import { ageStyle, fontSizesKds, kds, radii, spacing } from '../theme/tokens';
import { useNow } from '../utils/useNow';
import { AppText } from './AppText';

/** Seconds -> "m:ss", or "h:mm" from 60 min. */
export function formatAge(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface KdsAgeBadgeProps {
  /** ISO timestamp of the oldest un-READY item (sent_at). */
  since: string;
  /** Fixed "now" (tests); otherwise ticks every second. */
  now?: number;
  /** Server-vs-device clock offset in ms (serverNow - Date.now()). */
  clockOffsetMs?: number;
  /** Server-configured warn/late minutes (defaults to the design tokens 10/20). */
  thresholds?: KdsThresholds;
  testID?: string;
}

const TOKEN_TH: KdsThresholds = { warnMin: kds.warnAfterMin, lateMin: kds.alertAfterMin };

export function KdsAgeBadge({ since, now, clockOffsetMs = 0, thresholds = TOKEN_TH, testID = 'kds-age' }: KdsAgeBadgeProps) {
  const { t } = useTranslation('mobile');
  const tick = useNow(now);

  const start = new Date(since).getTime();
  const seconds = Number.isNaN(start) ? 0 : (tick + clockOffsetMs - start) / 1000;
  const level = ageLevelFor(seconds / 60, thresholds);
  const st = ageStyle(level);
  const a11y = [
    t('kds.age', { min: Math.floor(seconds / 60), sec: Math.floor(seconds % 60) }),
    level === 'alert' ? t('kds.ageUrgent') : level === 'warn' ? t('kds.ageWarn') : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View testID={testID} accessible accessibilityRole="timer" accessibilityLabel={a11y} style={[styles.badge, { backgroundColor: st.bg }]}>
      <MaterialCommunityIcons name="clock-outline" size={26} color={st.fg} />
      <AppText variant="headline" bold color={st.fg} fixedScale style={styles.text} testID={`${testID}-text`}>
        {formatAge(seconds)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: spacing.s1, paddingHorizontal: spacing.s3, paddingVertical: spacing.s1, borderRadius: radii.pill },
  text: { fontSize: fontSizesKds.age, lineHeight: 34, fontVariant: ['tabular-nums'] },
});
