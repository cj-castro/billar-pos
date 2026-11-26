import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { BottomActionBar } from '../../../components/BottomActionBar';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { useConnectionLevel } from '../../../components/connection';
import { DraftLineRow } from '../../../components/DraftLineRow';
import { EmptyState } from '../../../components/EmptyState';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { useToast } from '../../../components/Toast';
import { colors, spacing } from '../../../theme/tokens';
import { haptic } from '../../../utils/haptics';
import { formatMXN } from '../../../utils/money';
import { useTicketQuery } from '../queries';
import { draftSubtotalCents, isUncertain, lineEstimateCents, selectLines, useDraftStore, type DraftLine } from './draftStore';
import { failedLines, isSending, sendableLines } from './sendOrchestrator';
import { useSendDraft } from './useSendDraft';

const AUTO_RETURN_MS = 1200;

/** SCR-W-05 "Pedido por enviar": review the local draft, send it line by line with idempotency keys. */
export function DraftScreen({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const toast = useToast();
  const offline = useConnectionLevel() === 'offline';
  const ticket = useTicketQuery(ticketId);
  const lines = useDraftStore(selectLines(ticketId));
  const { setQuantity, removeLine, patchLine, clearTicket } = useDraftStore.getState();
  const { send, isSending: running, result, sentView } = useSendDraft(ticketId);
  const [discard, setDiscard] = useState(false);
  /** Uncertain line the waiter wants to drop: confirm they checked the ticket first (H2). */
  const [dropLine, setDropLine] = useState<DraftLine | null>(null);

  const sending = running || isSending(lines);
  const sendable = sendableLines(lines);
  const failed = failedLines(lines);
  const retryMode = failed.some((l) => l.error === 'NETWORK' || l.error === 'SERVER');
  const allDone = !!result && result.stopped === null && result.failed.length === 0 && result.sent.length > 0 && lines.length === 0;

  // Success: confirmation, then back to the ticket after a beat (matrix W-05).
  useEffect(() => {
    if (!allDone) return;
    haptic.success();
    toast.show({ tone: 'success', title: t('waiter.draft.sentOk') });
    const id = setTimeout(() => router.dismissTo(`/ticket/${ticketId}`), AUTO_RETURN_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per completed run
  }, [allDone]);

  const errorText = (l: DraftLine): string | null => {
    if (l.state !== 'FAILED') return null;
    switch (l.error) {
      case 'OUT_OF_STOCK':
        return t('waiter.draft.errOutOfStock');
      case 'FLAVOR_REQUIRED':
        return t('waiter.draft.errFlavor');
      case 'INVALID_QUANTITY':
        return t('waiter.draft.errQuantity');
      case 'NETWORK':
        return t('waiter.draft.errNetwork');
      case 'SERVER':
        return t('waiter.draft.errServer');
      case 'VERIFY':
        return t('waiter.draft.errVerify');
      case 'CONFLICT':
        return t('waiter.draft.errConflict');
      default:
        return t('waiter.draft.errUnknown');
    }
  };

  const retryLine = (l: DraftLine) => {
    // Same key (never regenerated): the server replays it, so no duplicates.
    patchLine(ticketId, l.key, { state: 'PENDING', error: undefined, errorDetail: undefined });
    if (!offline) send();
  };

  const banners = (
    <View>
      <OfflineBanner />
      {failed.length > 0 && !sending && (
        <Banner testID="draft-failed-banner" text={failed.length === 1 ? t('waiter.draft.bannerFailed', { n: 1 }) : t('waiter.draft.bannerFailedMany', { n: failed.length })} />
      )}
      {result?.stopped === 'closed' && <Banner testID="draft-closed-banner" text={t('waiter.draft.closed')} />}
      {result?.stopped === 'unauthorized' && <Banner testID="draft-auth-banner" text={t('waiter.draft.unauthorized')} />}
      {result?.stopped === 'verify' && <Banner testID="draft-verify-banner" text={t('waiter.draft.verify')} />}
    </View>
  );

  const code = ticket.data?.resource_code ?? '';
  const subtitle = [code, ticket.data?.customer_name].filter(Boolean).join(' · ');
  const nothing = lines.length === 0 && sentView.length === 0;

  const subtotal = (
    <View style={styles.subtotal}>
      <View style={styles.subRow}>
        <AppText variant="body" color={colors.textSecondary}>
          {t('waiter.draft.subtotal')}
        </AppText>
        <AppText variant="body" bold testID="draft-subtotal">
          {formatMXN(draftSubtotalCents(lines))}
        </AppText>
      </View>
      <AppText variant="caption" color={colors.textMuted}>
        {t('waiter.draft.estimateNote')}
      </AppText>
    </View>
  );

  const n = sendable.length;
  const footer = nothing ? undefined : (
    <View>
      {subtotal}
      <BottomActionBar
        testID="draft-actions"
        helper={offline ? t('waiter.draft.offline') : undefined}
        primary={{
          label: retryMode ? t('waiter.draft.retry', { n }) : t('waiter.draft.send', { n }),
          icon: retryMode ? 'refresh' : 'send',
          loading: sending,
          disabled: offline || n === 0,
          onPress: send,
          testID: 'draft-send',
        }}
      />
    </View>
  );

  return (
    <ScreenScaffold
      testID="screen-draft"
      padded={false}
      header={<ScreenHeader title={t('waiter.draft.title')} subtitle={subtitle || undefined} onBack={() => router.back()} right={<ConnectionPill />} />}
      banner={banners}
      footer={footer}
    >
      {nothing ? (
        <EmptyState
          icon="clipboard-text-outline"
          title={t('waiter.draft.empty')}
          message={t('waiter.draft.emptyBody')}
          action={{ label: t('waiter.draft.addProducts'), onPress: () => router.back() }}
          testID="draft-empty"
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content} testID="draft-list">
          {sentView.map((l) => (
            <DraftLineRow key={`sent-${l.key}`} testID={`draft-line-${l.key}`} quantity={l.quantity} name={l.name} modifiers={l.modifiers.map((m) => m.name)} note={l.notes} status="SENT" />
          ))}
          {lines.map((l) => (
            <DraftLineRow
              key={l.key}
              testID={`draft-line-${l.key}`}
              quantity={l.quantity}
              name={l.name}
              modifiers={l.modifiers.map((m) => m.name)}
              note={l.notes}
              status={l.state}
              errorText={errorText(l)}
              estimateCents={lineEstimateCents(l)}
              retryLabel={t('waiter.draft.lineRetry', { name: l.name })}
              removeLabel={t('waiter.draft.removeLine', { name: l.name })}
              onQuantityChange={sending || isUncertain(l) ? undefined : (q) => setQuantity(ticketId, l.key, q)}
              onRemove={sending ? undefined : () => (isUncertain(l) ? setDropLine(l) : removeLine(ticketId, l.key))}
              onRetry={sending || offline ? undefined : () => retryLine(l)}
            />
          ))}
          {lines.length > 0 && !sending && (
            <AppButton label={t('waiter.draft.discard')} variant="ghost" icon="close-circle" onPress={() => setDiscard(true)} testID="draft-discard" />
          )}
        </ScrollView>
      )}
      <ConfirmDialog
        visible={!!dropLine}
        title={t('waiter.draft.dropTitle', { name: dropLine?.name ?? '' })}
        message={t('waiter.draft.dropBody')}
        confirmLabel={t('waiter.draft.dropConfirm')}
        cancelLabel={t('cancel')}
        destructive
        onCancel={() => setDropLine(null)}
        onConfirm={() => {
          if (dropLine) removeLine(ticketId, dropLine.key);
          setDropLine(null);
        }}
        testID="drop-dialog"
      />
      <ConfirmDialog
        visible={discard}
        title={t('waiter.draft.discardTitle', { n: lines.length })}
        message={lines.some(isUncertain) ? t('waiter.draft.dropBody') : undefined}
        confirmLabel={t('waiter.draft.discardConfirm')}
        cancelLabel={t('cancel')}
        destructive
        onCancel={() => setDiscard(false)}
        onConfirm={() => {
          clearTicket(ticketId);
          setDiscard(false);
        }}
        testID="discard-dialog"
      />
    </ScreenScaffold>
  );
}

function Banner({ text, testID }: { text: string; testID: string }) {
  return (
    <View testID={testID} accessibilityRole="alert" accessible accessibilityLabel={text} style={styles.banner}>
      <MaterialCommunityIcons name="alert-circle-outline" size={20} color={colors.dangerText} />
      <AppText variant="label" bold color={colors.dangerText} style={styles.bannerText}>
        {text}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.s4, paddingBottom: spacing.s6 },
  subtotal: { backgroundColor: colors.surface, paddingHorizontal: spacing.s4, paddingTop: spacing.s3, gap: 2 },
  subRow: { flexDirection: 'row', justifyContent: 'space-between' },
  banner: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingHorizontal: spacing.s4, paddingVertical: spacing.s2, backgroundColor: colors.dangerTint },
  bannerText: { flex: 1 },
});
