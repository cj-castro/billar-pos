import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, layout, spacing, type ConnLevel } from '../theme/tokens';
import { formatClock } from '../utils/time';
import { AppText } from './AppText';
import { useConnectionLevel, useLastUpdated } from './connection';

export interface OfflineBannerProps {
  /** 'demo' (D13) is always shown; otherwise the banner follows the connection. */
  kind?: 'demo';
  /** Override derived values (tests). */
  level?: ConnLevel;
  lastUpdated?: number | null;
}

/** 36 dp strip under the header: offline / reconnecting (stale) / "connected again" for 2 s. Not dismissible. */
export function OfflineBanner({ kind, level, lastUpdated }: OfflineBannerProps) {
  const { t } = useTranslation('mobile');
  const derived = useConnectionLevel();
  const cached = useLastUpdated();
  const current = level ?? derived;
  const updated = lastUpdated === undefined ? cached : lastUpdated;

  const [recovered, setRecovered] = useState(false);
  const prev = useRef<ConnLevel>(current);
  useEffect(() => {
    const was = prev.current;
    prev.current = current;
    const justRecovered = current === 'online' && was !== 'online';
    const show = setTimeout(() => setRecovered(justRecovered), 0);
    const hide = justRecovered ? setTimeout(() => setRecovered(false), 2000) : undefined;
    return () => {
      clearTimeout(show);
      if (hide) clearTimeout(hide);
    };
  }, [current]);

  let text: string;
  let fg: string = colors.offlineBannerFg;
  let bg: string = colors.offlineBannerBg;
  let icon: 'wifi-off' | 'refresh' | 'check' | 'alert-circle-outline' = 'wifi-off';
  if (kind === 'demo') {
    text = t('offline.demo');
    fg = colors.warning;
    bg = colors.warningTint;
    icon = 'alert-circle-outline';
  } else if (current === 'offline') {
    const time = formatClock(updated);
    text = time ? `${t('offline.offline')} · ${t('offline.lastUpdated', { time })}` : t('offline.offline');
  } else if (current === 'reconnecting') {
    text = t('offline.stale');
    icon = 'refresh';
  } else if (recovered) {
    text = t('offline.recovered');
    fg = colors.success;
    bg = colors.successTint;
    icon = 'check';
  } else {
    return null;
  }

  return (
    <View
      testID="offline-banner"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={text}
      accessibilityLiveRegion="polite"
      style={[styles.bar, { backgroundColor: bg }]}
    >
      <MaterialCommunityIcons name={icon} size={20} color={fg} />
      <AppText variant="label" bold color={fg} numberOfLines={1} style={styles.text}>
        {text}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { minHeight: layout.statusBannerHeight, flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingHorizontal: spacing.s4 },
  text: { flex: 1 },
});
