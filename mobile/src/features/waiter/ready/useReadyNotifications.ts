import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { AppState } from 'react-native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { listTickets } from '../../../api/endpoints/tickets';
import { useTranslation } from 'react-i18next';
import { qk } from '../../../api/queryKeys';
import { useToast } from '../../../components/Toast';
import { joinRoom, leaveRoom, useRealtimeEvent } from '../../../realtime/socket';
import { useAuthStore } from '../../../state/authStore';
import { haptic } from '../../../utils/haptics';
import { wqk } from '../queries';
import { notifyReady, onNotificationTap, playChime, useAlertPrefs } from './readyAlerts';
import { classifyReadyEvent, type ItemEvent } from './readyEvents';

/**
 * Mounted once for the whole waiter group (any screen): joins the public `kitchen` and `bar` rooms (WAITER does
 * not get them from `roomsForRole`) and turns READY events of MY tickets into a toast + haptic (OV-02).
 */
export function useReadyNotifications() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const seen = useRef(new Set<string>());
  // SEC-05: ownership is NOT in the (public) socket payload: "mine" = ticket in my OPEN tickets. The list sits under
  // qk.resources, so every floor:update refreshes it.
  const open = useQuery({ queryKey: wqk.openTickets, queryFn: () => listTickets({ status: 'OPEN' }), staleTime: 10_000 });
  const mine = useMemo(() => (open.data && userId ? new Set(open.data.filter((tk) => tk.opened_by === userId).map((tk) => tk.id)) : null), [open.data, userId]);

  useEffect(() => {
    joinRoom('kitchen');
    joinRoom('bar');
    return () => {
      leaveRoom('kitchen');
      leaveRoom('bar');
    };
  }, []);

  const onEvent = useCallback(
    (payload: Record<string, unknown> | undefined) => {
      const d = classifyReadyEvent(payload as ItemEvent | undefined, mine, seen.current);
      if (d.action === 'refetch') {
        // B2 absent or my tickets not loaded yet: refresh the lists (badge + Listos tab follow).
        void qc.invalidateQueries({ queryKey: ['queue'] });
        void qc.invalidateQueries({ queryKey: [...qk.resources, 'open-tickets'] });
      } else if (d.action === 'notify') {
        haptic.success();
        const prefs = useAlertPrefs.getState();
        if (prefs.sound) void playChime();
        // Background: a local notification (needs the JS runtime alive; a killed app misses it, no push server).
        if (prefs.alerts && AppState.currentState !== 'active') void notifyReady(t('waiter.ready.notifTitle', { code: d.code, name: d.name }), d.ticketId);
        toast.show({
          tone: 'success',
          title: t('waiter.ready.toastTitle', { name: d.name, code: d.code }),
          action: { label: t('waiter.ready.toastView'), onPress: () => router.push(`/ticket/${d.ticketId}`) },
        });
      }
    },
    [mine, qc, toast, t, router],
  );

  useEffect(() => onNotificationTap((route) => router.push(route as never)), [router]);

  useRealtimeEvent('kitchen:item_update', onEvent);
  useRealtimeEvent('bar:item_update', onEvent);
}
