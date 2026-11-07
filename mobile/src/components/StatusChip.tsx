import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { draftStatusStyle, lineStatusStyle, radii, tableStatusStyle, type DraftStatus, type LineStatus, type TableState } from '../theme/tokens';
import { AppText } from './AppText';

export type StatusChipProps = { size?: 'sm' | 'lg'; testID?: string } & (
  | { kind: 'item'; status: LineStatus }
  | { kind: 'table'; status: TableState }
  | { kind: 'draft'; status: DraftStatus }
);

/** Colour + icon + word, always (never colour alone). */
export function StatusChip(props: StatusChipProps) {
  const { t } = useTranslation('mobile');
  const { size = 'sm', testID } = props;
  const s = props.kind === 'item' ? lineStatusStyle(props.status) : props.kind === 'draft' ? draftStatusStyle(props.status) : tableStatusStyle(props.status);
  const label = t(s.labelKey);
  const lg = size === 'lg';
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.chip, { backgroundColor: s.bg, minHeight: lg ? 44 : 26, paddingHorizontal: lg ? 14 : 10 }]}
    >
      <MaterialCommunityIcons name={s.icon} size={lg ? 22 : 16} color={s.fg} />
      <AppText variant={lg ? 'label' : 'caption'} bold color={s.fg} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, borderRadius: radii.pill },
});
