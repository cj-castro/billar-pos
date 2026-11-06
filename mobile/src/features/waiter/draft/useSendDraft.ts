import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { addItemIdem } from '../../../api/endpoints/ticketOps';
import { qk } from '../../../api/queryKeys';
import { haptic } from '../../../utils/haptics';
import { toApiError } from '../../../api/client';
import { getServerUrl } from '../../../config/serverConfig';
import { useAuthStore } from '../../../state/authStore';
import { useFavorites } from '../menu/favoritesStore';
import { fetchTicketVersion } from '../queries';
import { getDraftEpoch, useDraftStore, type DraftLine } from './draftStore';
import { sendDraft, sendableLines, type SendResult } from './sendOrchestrator';

/** Tickets with a send in flight (survives screen unmounts): a second tap is a no-op. */
const inFlight = new Set<string>();

/**
 * Drives the pure orchestrator against the real API + draft store.
 * `mutate()` is safe to call twice: the second call is ignored while the first runs (D6).
 * Global mutation networkMode is 'always': offline must fail fast (-> "No se envió"), never sit paused in a hidden queue (D7).
 */
export function useSendDraft(ticketId: string) {
  const qc = useQueryClient();
  const guard = useRef(false);
  /** Lines confirmed in the current run, kept for the "Enviado" flash (they are already gone from the store). */
  const [sentView, setSentView] = useState<DraftLine[]>([]);

  const mutation = useMutation<SendResult | null>({
    retry: 0,
    mutationFn: async () => {
      if (guard.current || inFlight.has(ticketId)) return null;
      guard.current = true;
      inFlight.add(ticketId);
      try {
        const store = useDraftStore.getState();
        // Run binding: this run may only act for the session + server + draft generation it started in.
        const bound = { epoch: getDraftEpoch(), userId: useAuthStore.getState().user?.id ?? null, server: getServerUrl() };
        const bindingHolds = () => getDraftEpoch() === bound.epoch && (useAuthStore.getState().user?.id ?? null) === bound.userId && getServerUrl() === bound.server;
        const isLive = (key: string) => bindingHolds() && (useDraftStore.getState().byTicket[ticketId] ?? []).some((l) => l.key === key);
        const lines = sendableLines(store.byTicket[ticketId] ?? []);
        if (!lines.length) return null;
        const byKey = new Map(lines.map((l) => [l.key, l]));
        setSentView([]);

        let version: number | null = null;
        try {
          version = await fetchTicketVersion(ticketId);
        } catch (e) {
          if (!bindingHolds()) return null;
          const err = toApiError(e);
          if (err.isNetwork || err.isTimeout) {
            // Offline: nothing was posted. Show the lines as retryable; the waiter must tap Enviar again (nothing resumes on reconnect).
            const s = useDraftStore.getState();
            for (const l of lines) s.patchLine(ticketId, l.key, { state: 'FAILED', error: 'NETWORK', errorDetail: undefined });
            return { sent: [], failed: lines.map((l) => l.key), stopped: 'network', version: null };
          }
          // other read failures: the first POST reports the real failure on its own line
        }
        if (!bindingHolds()) return null;

        const result = await sendDraft({
          ticketId,
          lines: lines.map((l) => ({ key: l.key, menuItemId: l.menuItemId, quantity: l.quantity, modifiers: l.modifiers, notes: l.notes, firstAttemptVersion: l.firstAttemptVersion })),
          version,
          isLive,
          deps: { addItem: addItemIdem, fetchVersion: fetchTicketVersion },
          onUpdate: (key, patch) => {
            const s = useDraftStore.getState();
            if (patch.state === 'SENT') {
              // Remove from the persisted draft immediately: an app kill after this must never resend it.
              const done = byKey.get(key);
              if (done) {
                setSentView((v) => [...v, done]);
                if (bound.userId) useFavorites.getState().record(bound.userId, done.menuItemId); // "Frecuentes"
              }
              s.removeLine(ticketId, key);
            } else if (patch.state === 'FAILED') {
              s.patchLine(ticketId, key, {
                state: 'FAILED',
                error: patch.error,
                errorDetail: patch.errorDetail,
                ...(patch.resetAttempt ? { firstAttemptVersion: undefined } : {}),
              });
            } else {
              // firstAttemptVersion is persisted BEFORE the request leaves (so an app kill mid-flight keeps it).
              s.patchLine(ticketId, key, {
                state: patch.state,
                error: undefined,
                errorDetail: undefined,
                ...(patch.state === 'SENDING' && 'firstAttemptVersion' in patch ? { firstAttemptVersion: patch.firstAttemptVersion } : {}),
              });
            }
          },
        });
        if (result.stopped === 'aborted') return null;
        if (result.sent.length) haptic.light();
        return result;
      } finally {
        inFlight.delete(ticketId);
        guard.current = false;
        void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
        void qc.invalidateQueries({ queryKey: qk.resources });
        void qc.invalidateQueries({ queryKey: ['queue'] });
      }
    },
  });

  return {
    send: () => {
      if (guard.current) return; // L4: a same-frame double tap must not replace the observed mutation
      mutation.mutate();
    },
    isSending: mutation.isPending,
    result: mutation.data ?? null,
    error: mutation.error,
    sentView,
    reset: () => {
      mutation.reset();
      setSentView([]);
    },
  };
}
