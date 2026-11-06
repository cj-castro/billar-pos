import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { addItemIdem } from '../../../api/endpoints/ticketOps';
import { qk } from '../../../api/queryKeys';
import { haptic } from '../../../utils/haptics';
import { useFetchTicketVersion } from '../queries';
import { useDraftStore, type DraftLine } from './draftStore';
import { sendDraft, sendableLines, type SendResult } from './sendOrchestrator';

/** B1 seen in this app session (a response carried `ticket_version`): enables the VERSION_CONFLICT auto-retry. */
let b1Known = false;
/** Tickets with a send in flight (survives screen unmounts): a second tap is a no-op. */
const inFlight = new Set<string>();

/**
 * Drives the pure orchestrator against the real API + draft store.
 * `mutate()` is safe to call twice: the second call is ignored while the first runs (D6).
 * networkMode 'always': offline must fail fast (-> "No se envió"), never sit paused in a hidden queue (D7).
 */
export function useSendDraft(ticketId: string) {
  const qc = useQueryClient();
  const fetchVersion = useFetchTicketVersion();
  const guard = useRef(false);
  /** Lines confirmed in the current run, kept for the "Enviado" flash (they are already gone from the store). */
  const [sentView, setSentView] = useState<DraftLine[]>([]);

  const mutation = useMutation<SendResult | null>({
    networkMode: 'always',
    retry: 0,
    mutationFn: async () => {
      if (guard.current || inFlight.has(ticketId)) return null;
      guard.current = true;
      inFlight.add(ticketId);
      try {
        const store = useDraftStore.getState();
        const lines = sendableLines(store.byTicket[ticketId] ?? []);
        if (!lines.length) return null;
        const byKey = new Map(lines.map((l) => [l.key, l]));
        setSentView([]);

        let version: number | null = null;
        try {
          version = await fetchVersion(ticketId);
        } catch {
          // unreadable (offline?): the first POST reports the real failure on its own line
        }

        const result = await sendDraft({
          ticketId,
          lines: lines.map((l) => ({ key: l.key, menuItemId: l.menuItemId, quantity: l.quantity, modifiers: l.modifiers, notes: l.notes })),
          version,
          b1Known,
          deps: { addItem: addItemIdem, fetchVersion },
          onUpdate: (key, patch) => {
            const s = useDraftStore.getState();
            if (patch.state === 'SENT') {
              // Remove from the persisted draft immediately: an app kill after this must never resend it.
              const done = byKey.get(key);
              if (done) setSentView((v) => [...v, done]);
              s.removeLine(ticketId, key);
            } else if (patch.state === 'FAILED') {
              s.patchLine(ticketId, key, { state: 'FAILED', error: patch.error, errorDetail: patch.errorDetail });
            } else {
              s.patchLine(ticketId, key, { state: patch.state, error: undefined, errorDetail: undefined });
            }
          },
        });
        b1Known = b1Known || result.b1;
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
    send: () => mutation.mutate(),
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
