import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../../components/AppText';
import { BottomActionBar } from '../../../components/BottomActionBar';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { useConnectionLevel } from '../../../components/connection';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { MenuItemTile } from '../../../components/MenuItemTile';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { colors, fontSizes, MAX_FONT_SCALE, radii, spacing, touch } from '../../../theme/tokens';
import { haptic } from '../../../utils/haptics';
import { quickLine, needsConfigurator } from '../configure/configurator';
import { selectLines, useDraftStore } from '../draft/draftStore';
import { useMenuCategories, useMenuItems, useStockCheck, useTicketQuery } from '../queries';
import { ALL_CATEGORIES, filterMenuItems } from './menuSearch';

/** SCR-W-03 Menu: search (accent-insensitive) + category chips + 2-col grid; sold-out from /inventory/stock-check. */
export function MenuScreen({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const offline = useConnectionLevel() === 'offline';
  const categories = useMenuCategories();
  const items = useMenuItems();
  const stock = useStockCheck();
  const ticket = useTicketQuery(ticketId);
  const draft = useDraftStore(selectLines(ticketId));
  const addLine = useDraftStore((s) => s.addLine);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [query, setQuery] = useState('');

  const blocked = useMemo(() => new Set(stock.data?.blocked_items ?? []), [stock.data]);
  const visible = useMemo(() => filterMenuItems(items.data ?? [], category, query), [items.data, category, query]);
  // Odd count: pad so the last tile keeps half width.
  const padded = useMemo(() => (visible.length % 2 ? [...visible, null] : visible), [visible]);
  const draftQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of draft) m.set(l.menuItemId, (m.get(l.menuItemId) ?? 0) + l.quantity);
    return m;
  }, [draft]);
  const draftCount = draft.length;

  const code = ticket.data?.resource_code ?? '';
  const onItem = (id: string) => {
    const item = items.data?.find((i) => i.id === id);
    if (!item) return;
    if (needsConfigurator(item)) router.push(`/ticket/${ticketId}/configure/${id}`);
    else {
      addLine(ticketId, quickLine(item));
      haptic.light();
    }
  };

  let body;
  if (items.isPending && !items.data) body = <LoadingSkeleton variant="menu" />;
  else if (!items.data) body = <ErrorState error={items.error} onRetry={() => items.refetch()} />;
  else if (visible.length === 0)
    body = (
      <EmptyState
        icon="magnify"
        title={query.trim() ? t('waiter.menu.noResults', { q: query.trim() }) : t('waiter.menu.emptyCategory')}
        action={query.trim() ? { label: t('waiter.menu.clearSearch'), onPress: () => setQuery('') } : undefined}
        testID="menu-empty"
      />
    );
  else
    body = (
      <FlatList
        testID="menu-grid"
        data={padded}
        keyExtractor={(i, idx) => i?.id ?? `pad${idx}`}
        numColumns={2}
        columnWrapperStyle={styles.col}
        contentContainerStyle={styles.grid}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) =>
          !item ? (
            <View style={styles.flex} />
          ) : (
          <MenuItemTile
            testID={`menu-item-${item.id}`}
            name={item.name}
            priceCents={item.price_cents}
            routing={item.routing}
            soldOut={blocked.has(item.id)}
            draftQty={draftQty.get(item.id) ?? 0}
            onPress={() => onItem(item.id)}
            onLongPress={() => router.push(`/ticket/${ticketId}/configure/${item.id}`)}
          />
          )
        }
      />
    );

  return (
    <ScreenScaffold
      testID="screen-menu"
      padded={false}
      header={
        <ScreenHeader
          title={t('waiter.menu.title', { code })}
          subtitle={ticket.data?.customer_name ?? undefined}
          onBack={() => router.back()}
          right={<ConnectionPill />}
        />
      }
      banner={<OfflineBanner />}
      footer={
        draftCount > 0 ? (
          <BottomActionBar primary={{ label: t('waiter.menu.reviewOrder', { n: draftCount }), icon: 'send', onPress: () => router.push(`/ticket/${ticketId}/draft`), testID: 'menu-review-order' }} />
        ) : undefined
      }
    >
      <View style={styles.top}>
        <View style={styles.search}>
          <MaterialCommunityIcons name="magnify" size={24} color={colors.textSecondary} />
          <TextInput
            testID="menu-search"
            accessibilityLabel={t('waiter.menu.search')}
            placeholder={t('waiter.menu.search')}
            placeholderTextColor={colors.textMuted}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            cursorColor={colors.primaryText}
            style={styles.input}
          />
          {query.length > 0 && (
            <Pressable accessibilityRole="button" accessibilityLabel={t('waiter.menu.clearSearch')} hitSlop={touch.hitSlop} onPress={() => setQuery('')} testID="menu-search-clear">
              <MaterialCommunityIcons name="close-circle" size={22} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled" testID="menu-chips">
          <Chip label={t('waiter.menu.all')} selected={category === ALL_CATEGORIES} onPress={() => setCategory(ALL_CATEGORIES)} testID="chip-all" />
          {(categories.data ?? []).map((c) => (
            <Chip key={c.id} label={c.name} selected={category === c.id} onPress={() => setCategory(c.id)} testID={`chip-${c.id}`} />
          ))}
        </ScrollView>
        {offline && (
          <AppText variant="caption" color={colors.warning}>
            {t('waiter.menu.staleStock')}
          </AppText>
        )}
      </View>
      {body}
    </ScreenScaffold>
  );
}

function Chip({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={() => {
        haptic.selection();
        onPress();
      }}
      style={[styles.chip, selected && styles.chipOn]}
    >
      <AppText variant="body" bold color={selected ? colors.textOnAccent : colors.textPrimary}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: { paddingHorizontal: spacing.s4, paddingTop: spacing.s3, gap: spacing.s3 },
  search: {
    minHeight: touch.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    paddingHorizontal: spacing.s3,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    backgroundColor: colors.surfaceRaised,
  },
  input: { flex: 1, minHeight: touch.primary, color: colors.textPrimary, fontSize: fontSizes.body, paddingVertical: 0 },
  chips: { gap: spacing.s2, paddingRight: spacing.s4 },
  chip: { minHeight: touch.min, paddingHorizontal: spacing.s4, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceRaised },
  chipOn: { backgroundColor: colors.primary },
  grid: { padding: spacing.s4, gap: spacing.s2 },
  col: { gap: spacing.s2 },
});
