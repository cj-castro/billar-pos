import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError, toApiError } from '../../../api/client';
import { listResources } from '../../../api/endpoints/resources';
import { openTicket } from '../../../api/endpoints/tickets';
import { qk } from '../../../api/queryKeys';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { AppTextField } from '../../../components/AppTextField';
import { useConnectionLevel } from '../../../components/connection';
import { IconButton } from '../../../components/IconButton';
import { colors, spacing } from '../../../theme/tokens';
import { errorMessage } from '../../../utils/errorMessage';
import { haptic } from '../../../utils/haptics';
import { useCashStatus, useResources } from '../queries';
import { Sheet } from '../ui/Sheet';

export const CUSTOMER_NAME_MAX = 40;

type Problem = { kind: 'closed' } | { kind: 'occupied'; ticketId: string | null } | { kind: 'unknown'; ticketId: string | null } | { kind: 'other'; error: unknown };

/** SCR-W-07: confirm sheet to open a table (optional customer name). Double-tap safe, handles BAR_CLOSED / RESOURCE_OCCUPIED / network. */
export function OpenTableScreen({ resourceId }: { resourceId: string }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const qc = useQueryClient();
  const resources = useResources();
  const cash = useCashStatus();
  const offline = useConnectionLevel() === 'offline';
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const busy = useRef(false);

  const resource = resources.data?.find((r) => r.id === resourceId);
  const code = resource?.code ?? '';
  const barClosed = cash.data?.open === false || problem?.kind === 'closed';

  const close = () => (router.canGoBack() ? router.back() : router.replace('/floor'));

  const mutation = useMutation({
    retry: 0,
    mutationFn: () => openTicket({ resource_id: resourceId, ticket_type: 'TABLE', ...(name.trim() ? { customer_name: name.trim().slice(0, CUSTOMER_NAME_MAX) } : {}) }),
    onSuccess: (ticket) => {
      haptic.success();
      void qc.invalidateQueries({ queryKey: qk.resources });
      router.replace(`/ticket/${ticket.id}`);
    },
    onError: async (e) => {
      const err = e instanceof ApiError ? e : toApiError(e);
      // The floor may have changed (or the outcome is unknown after a network loss): resync and look for an existing ticket.
      let existing: string | null = null;
      try {
        const fresh = await qc.fetchQuery({ queryKey: qk.resources, queryFn: () => listResources(), staleTime: 0 });
        existing = fresh.find((r) => r.id === resourceId)?.active_ticket_id ?? null;
      } catch {
        // still offline: keep the generic error
      }
      if (err.status === 403 && err.code === 'BAR_CLOSED') {
        void qc.invalidateQueries({ queryKey: qk.cash });
        setProblem({ kind: 'closed' });
      } else if (err.status === 409 && err.code === 'RESOURCE_OCCUPIED') {
        haptic.warning();
        setProblem({ kind: 'occupied', ticketId: existing });
      } else if (err.isNetwork || err.isTimeout) {
        setProblem({ kind: 'unknown', ticketId: existing });
      } else {
        setProblem({ kind: 'other', error: err });
      }
    },
    onSettled: () => {
      busy.current = false;
    },
  });

  const submit = () => {
    if (busy.current || mutation.isPending) return; // double tap: one request
    busy.current = true;
    setProblem(null);
    mutation.mutate();
  };

  const disabledReason = barClosed ? t('waiter.open.closed') : offline ? t('waiter.open.offline') : undefined;
  const message =
    problem?.kind === 'closed'
      ? t('waiter.open.closed')
      : problem?.kind === 'occupied'
        ? t('waiter.open.occupied')
        : problem?.kind === 'unknown'
          ? problem.ticketId
            ? t('waiter.open.occupied')
            : t('waiter.open.unknown')
          : problem?.kind === 'other'
            ? errorMessage(problem.error)
            : null;
  const existingId = problem && (problem.kind === 'occupied' || problem.kind === 'unknown') ? problem.ticketId : null;

  return (
    <Sheet testID="open-table-sheet" onClose={mutation.isPending ? undefined : close}>
      <View style={styles.head}>
        <AppText variant="headline" accessibilityRole="header" style={styles.title}>
          {t('waiter.open.title', { code })}
        </AppText>
        <IconButton icon="close" accessibilityLabel={t('waiter.open.close')} onPress={close} disabled={mutation.isPending} testID="open-table-close" />
      </View>
      {resource?.type === 'POOL_TABLE' && (
        <AppText variant="label" color={colors.textSecondary}>
          {t('waiter.open.poolNote')}
        </AppText>
      )}
      <AppTextField
        label={t('waiter.open.customer')}
        placeholder={t('waiter.open.customerPlaceholder')}
        value={name}
        onChangeText={setName}
        maxLength={CUSTOMER_NAME_MAX}
        autoCapitalize="words"
        editable={!mutation.isPending}
        returnKeyType="done"
        testID="open-table-name"
      />
      {!!message && (
        <AppText variant="body" bold color={colors.dangerText} accessibilityRole="alert" testID="open-table-error">
          {message}
        </AppText>
      )}
      {!!existingId && <AppButton label={t('waiter.open.openExisting')} variant="secondary" size="lg" onPress={() => router.replace(`/ticket/${existingId}`)} testID="open-table-existing" />}
      {!!disabledReason && (
        <AppText variant="label" color={colors.textSecondary} style={styles.center} testID="open-table-helper">
          {disabledReason}
        </AppText>
      )}
      <AppButton
        label={t('waiter.open.submit')}
        size="lg"
        fullWidth
        loading={mutation.isPending}
        disabled={!!disabledReason || !resource}
        onPress={submit}
        testID="open-table-submit"
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  title: { flex: 1 },
  center: { textAlign: 'center' },
});
