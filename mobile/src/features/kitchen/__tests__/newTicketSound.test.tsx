import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { QueueItem } from '../../../domain/types';
import { playChime } from '../../waiter/ready/readyAlerts';
import { qi } from '../testFixtures';
import { useNewTicketSound } from '../useKdsSettings';

jest.mock('../../waiter/ready/readyAlerts', () => ({ playChime: jest.fn() }));
jest.mock('../../../api/endpoints/settings', () => ({ getSetting: jest.fn().mockRejectedValue(new Error('403')) }));

const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe('useNewTicketSound', () => {
  it('chimes for a new SENT line, but not when the station (queue) changes', async () => {
    const k = [qi({ id: 'a', status: 'SENT' })];
    const bar = [qi({ id: 'b', status: 'SENT' }), qi({ id: 'c', status: 'SENT' })];
    const { rerender } = await renderHook((p: { items: QueueItem[]; station: string }) => useNewTicketSound(p.items, p.station), { wrapper: wrap, initialProps: { items: k, station: 'KITCHEN' } });
    await rerender({ items: bar, station: 'BAR' });
    expect(playChime).not.toHaveBeenCalled();
    await rerender({ items: [...bar, qi({ id: 'd', status: 'SENT' })], station: 'BAR' });
    expect(playChime).toHaveBeenCalledTimes(1);
  });
});
