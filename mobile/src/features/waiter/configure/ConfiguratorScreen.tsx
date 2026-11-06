import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { AppTextField } from '../../../components/AppTextField';
import { ErrorState } from '../../../components/ErrorState';
import { IconButton } from '../../../components/IconButton';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { ModifierGroup } from '../../../components/ModifierGroup';
import { QuantityStepper } from '../../../components/QuantityStepper';
import { colors, spacing } from '../../../theme/tokens';
import { haptic } from '../../../utils/haptics';
import { formatMXN } from '../../../utils/money';
import { useDraftStore } from '../draft/draftStore';
import { useMenuItems, useStockCheck } from '../queries';
import { Sheet } from '../ui/Sheet';
import { buildDraftLine, checkSelections, groupsForItem, NOTE_MAX, type Selections } from './configurator';

/** SCR-W-04: modifier groups (rules from `validateModifierSelection`), notes, quantity 1-99 -> local draft. */
export function ConfiguratorScreen({ ticketId, itemId }: { ticketId: string; itemId: string }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const items = useMenuItems();
  const stock = useStockCheck();
  const addLine = useDraftStore((s) => s.addLine);
  const [selections, setSelections] = useState<Selections>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState('');
  const [qty, setQty] = useState(1);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const close = () => (router.canGoBack() ? router.back() : router.replace(`/ticket/${ticketId}`));
  const item = items.data?.find((i) => i.id === itemId);
  const groups = item ? groupsForItem(item) : [];
  const check = checkSelections(groups, selections);
  // 2+ groups push the note below the fold: put it first. Any option group makes the sheet tall (90 %).
  const notesFirst = groups.length >= 2;
  const tall = groups.length > 0;
  const blockedMods = new Set(stock.data?.blocked_modifiers ?? []);
  const soldOut = !!item && !!stock.data?.blocked_items.includes(item.id);

  let content;
  if (items.isPending && !item) content = <LoadingSkeleton variant="list" count={3} />;
  else if (!item) content = <ErrorState error={items.error} message={t('waiter.configure.noItem')} onRetry={() => items.refetch()} testID="configure-error" />;
  else {
    const line = buildDraftLine(item, groups, selections, notes, qty);
    const unit = line.unitPriceCents + line.modifiers.reduce((s, m) => s + m.priceCents, 0);
    const add = () => {
      if (!check.valid || soldOut) return;
      addLine(ticketId, line);
      haptic.light();
      close();
    };
    const notesField = (
      <AppTextField
        label={t('waiter.configure.notes')}
        placeholder={t('waiter.configure.notesPlaceholder')}
        value={notes}
        onChangeText={setNotes}
        maxLength={NOTE_MAX}
        autoCapitalize="sentences"
        testID="configure-notes"
        onFocus={notesFirst ? undefined : () => setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 300)}
      />
    );
    content = (
      <>
        <ScrollView ref={scroll} style={tall ? styles.scrollTall : styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {notesFirst && notesField}
          {groups.map((g) => (
            <ModifierGroup
              key={g.id}
              testID={`group-${g.id}`}
              title={g.name}
              mandatory={g.is_mandatory}
              min={g.min_selections}
              max={g.max_selections}
              allowMultiple={g.allow_multiple}
              options={g.modifiers.map((m) => ({ id: m.id, name: m.name, priceDeltaCents: m.price_cents ?? 0, disabled: blockedMods.has(m.id) }))}
              selectedIds={selections[g.id] ?? []}
              showError={!!touched[g.id]}
              onChange={(ids) => {
                setSelections((s) => ({ ...s, [g.id]: ids }));
                setTouched((x) => ({ ...x, [g.id]: true }));
              }}
            />
          ))}
          {!notesFirst && notesField}
        </ScrollView>
        <View style={styles.qtyRow}>
          <AppText variant="bodyLg" bold>
            {`${t('stepper.value')}`}
          </AppText>
          <QuantityStepper value={qty} onChange={setQty} testID="configure-qty" />
        </View>
        {soldOut ? (
          <AppText variant="label" bold color={colors.dangerText} style={styles.center}>
            {t('waiter.configure.soldOutItem')}
          </AppText>
        ) : !check.valid ? (
          <AppText variant="label" color={colors.textSecondary} style={styles.center} testID="configure-helper">
            {t('waiter.configure.fixRequired')}
          </AppText>
        ) : null}
        <AppButton
          label={`${t('waiter.configure.add')} · ${formatMXN(unit * qty)}`}
          size="lg"
          fullWidth
          disabled={!check.valid || soldOut}
          onPress={add}
          testID="configure-add"
        />
      </>
    );
  }

  return (
    <Sheet testID="configure-sheet" onClose={close} height={tall ? '90%' : undefined}>
      <View style={styles.head}>
        <View style={styles.titles}>
          <AppText variant="headline" numberOfLines={2} accessibilityRole="header">
            {item?.name ?? t('waiter.configure.title')}
          </AppText>
          {!!item && (
            <AppText variant="body" color={colors.textSecondary}>
              {formatMXN(item.price_cents)}
            </AppText>
          )}
        </View>
        <IconButton icon="close" accessibilityLabel={t('waiter.configure.close')} onPress={close} testID="configure-close" />
      </View>
      {content}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s2 },
  titles: { flex: 1 },
  scroll: { flexGrow: 0 },
  scrollTall: { flex: 1 },
  body: { gap: spacing.s4, paddingBottom: spacing.s2 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { textAlign: 'center' },
});
