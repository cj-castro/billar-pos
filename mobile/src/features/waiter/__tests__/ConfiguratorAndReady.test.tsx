import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useAuthStore } from '../../../state/authStore';
import { ConfiguratorScreen } from '../configure/ConfiguratorScreen';
import { useDraftStore } from '../draft/draftStore';
import { ReadyScreen } from '../ready/ReadyScreen';
import { useReadyNotifications } from '../ready/useReadyNotifications';
import { httpError, makeRouter, mockApi, menuItem, online, renderScreen, ticket } from '../testing/testkit';

const mockRouter = makeRouter();
const mockHandlers: Record<string, (p: Record<string, unknown>) => void> = {};
const mockJoin = jest.fn();
const mockLeave = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../../realtime/socket', () => {
  const React = jest.requireActual('react');
  return {
    ...jest.requireActual('../../../realtime/socket'),
    joinRoom: (r: string) => mockJoin(r),
    leaveRoom: (r: string) => mockLeave(r),
    useRealtimeEvent: (ev: string, h: (p: Record<string, unknown>) => void) => {
      React.useEffect(() => {
        mockHandlers[ev] = h;
      }, [ev, h]);
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  useDraftStore.setState({ byTicket: {} });
  useAuthStore.setState({ user: { id: 'u-waiter', username: 'waiter1', name: 'Mariana', role: 'WAITER' } });
});

describe('ConfiguratorScreen', () => {
  const mod = (id: string, name: string, price = 0) => ({ id, name, price_cents: price, modifier_group_id: 'g', is_active: true });
  const wings = menuItem({
    id: 'wings',
    name: 'Alitas BBQ',
    price_cents: 14500,
    modifier_groups: [
      { id: 'g-sauce', name: 'Salsa', is_mandatory: true, min_selections: 1, max_selections: 1, allow_multiple: false, modifiers: [mod('bbq', 'BBQ'), mod('buf', 'Búfalo', 500)] },
      { id: 'g-extra', name: 'Extras', is_mandatory: false, min_selections: 0, max_selections: 2, allow_multiple: true, modifiers: [mod('e1', 'Queso'), mod('e2', 'Tocino'), mod('e3', 'Cebolla')] },
    ],
  });
  const api = (blocked: { items?: string[]; mods?: string[] } = {}) =>
    mockApi({
      'GET /menu/items': { data: [wings, menuItem({ id: 'plain', name: 'Agua' })] },
      'GET /inventory/stock-check': { data: { blocked_items: blocked.items ?? [], blocked_modifiers: blocked.mods ?? [], low_stock_item_ids: [], remaining_by_item: {}, low_stock_items: [] } },
    });

  it('mandatory group blocks "Agregar" until chosen and explains why', async () => {
    api();
    await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="wings" />);
    expect(await screen.findByText('Alitas BBQ')).toBeTruthy();
    const add = screen.getByTestId('configure-add');
    expect(add.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('configure-helper').props.children).toBe('Elige las opciones obligatorias para continuar.');
    await fireEvent.press(screen.getByTestId('group-g-sauce-buf'));
    expect(screen.getByTestId('configure-add').props.accessibilityState.disabled).toBe(false);
    expect(screen.queryByTestId('configure-helper')).toBeNull();
  });

  it('single-select replaces; at the max of a multi group the others are disabled', async () => {
    api();
    await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="wings" />);
    await screen.findByText('Alitas BBQ');
    await fireEvent.press(screen.getByTestId('group-g-sauce-bbq'));
    await fireEvent.press(screen.getByTestId('group-g-sauce-buf'));
    expect(screen.getByTestId('group-g-sauce-bbq').props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId('group-g-sauce-buf').props.accessibilityState.checked).toBe(true);
    await fireEvent.press(screen.getByTestId('group-g-extra-e1'));
    await fireEvent.press(screen.getByTestId('group-g-extra-e2'));
    expect(screen.getByTestId('group-g-extra-e3').props.accessibilityState.disabled).toBe(true);
  });

  it('adds the configured line (modifiers, note, quantity, estimated price) to the local draft and closes', async () => {
    const m = api();
    await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="wings" />);
    await screen.findByText('Alitas BBQ');
    await fireEvent.press(screen.getByTestId('group-g-sauce-buf'));
    await fireEvent.press(screen.getByTestId('group-g-extra-e1'));
    await fireEvent.changeText(screen.getByTestId('configure-notes'), 'bien doradas');
    await fireEvent.press(screen.getByTestId('configure-qty-inc'));
    expect(screen.getByTestId('configure-add').props.accessibilityLabel).toBe('Agregar al pedido · $300.00'); // (145 + 5) * 2
    await fireEvent.press(screen.getByTestId('configure-add'));
    const [l] = useDraftStore.getState().byTicket.t1;
    expect(l).toMatchObject({ menuItemId: 'wings', quantity: 2, notes: 'bien doradas', state: 'PENDING', unitPriceCents: 14500 });
    expect(l.modifiers.map((x) => x.id)).toEqual(['buf', 'e1']);
    expect(mockRouter.back).toHaveBeenCalled();
    expect(m.calls.filter((c) => c.method === 'POST')).toHaveLength(0); // nothing is sent to the server
  });

  it('quantity is bounded 1..99', async () => {
    api();
    await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="plain" />);
    await screen.findByText('Agua');
    expect(screen.getByTestId('configure-qty-dec').props.accessibilityState.disabled).toBe(true);
    for (let i = 0; i < 3; i++) await fireEvent.press(screen.getByTestId('configure-qty-inc'));
    expect(screen.getByTestId('configure-add').props.accessibilityLabel).toContain('$180.00'); // 4 x 45
  });

  it('item without options: only notes + quantity, can add straight away', async () => {
    api();
    await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="plain" />);
    await screen.findByText('Agua');
    expect(screen.queryByTestId('configure-helper')).toBeNull();
    await fireEvent.press(screen.getByTestId('configure-add'));
    expect(useDraftStore.getState().byTicket.t1[0].menuItemId).toBe('plain');
  });

  it('sold-out item cannot be added; blocked modifier is disabled', async () => {
    api({ items: ['plain'], mods: ['bbq'] });
    const view = await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="plain" />);
    await waitFor(() => expect(screen.getByText('Este producto está agotado.')).toBeTruthy());
    expect(screen.getByTestId('configure-add').props.accessibilityState.disabled).toBe(true);
    await view.unmount();
    await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="wings" />);
    await screen.findByText('Alitas BBQ');
    await waitFor(() => expect(screen.getByTestId('group-g-sauce-bbq').props.accessibilityState.disabled).toBe(true));
  });

  it('unknown item shows an error with retry; close goes back', async () => {
    api();
    await renderScreen(<ConfiguratorScreen ticketId="t1" itemId="nope" />);
    expect(await screen.findByTestId('configure-error')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('configure-close'));
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('ReadyScreen', () => {
  const q = (id: string, ticketId: string, code: string, status: string, sent: string, name = id, qty = 1) =>
    ({ id, ticket_id: ticketId, resource_code: code, menu_item_name: name, quantity: qty, status, sent_at: sent, routing_dest: 'KITCHEN', modifiers: [{ id: 'm', modifier_id: 'm', name: 'BBQ', price_cents: 0 }], notes: null }) as never;
  const api = (over: Record<string, never | object> = {}) =>
    mockApi({
      'GET /queue/kitchen': { data: [q('k1', 'tMine', 'T4', 'READY', '2026-01-01T10:00:00+00:00', 'Alitas', 2), q('k2', 'tMine', 'T4', 'READY', '2026-01-01T10:02:00+00:00', 'Papas'), q('k3', 'tMine', 'T4', 'IN_PROGRESS', '2026-01-01T10:03:00+00:00')] },
      'GET /queue/bar': { data: [q('b1', 'tOther', 'B1', 'READY', '2026-01-01T10:01:00+00:00', 'Corona')] },
      'GET /tickets': { data: [ticket({ id: 'tMine', opened_by: 'u-waiter', customer_name: 'Sofía' }), ticket({ id: 'tOther', opened_by: 'someone', resource_code: 'B1' })] },
      'PATCH /queue/[^/]+/status': { data: { item_id: 'x', status: 'SERVED' } },
      ...over,
    });

  it('groups READY lines per table (mine first) with "Marcar servido"; others are listed read-only', async () => {
    api();
    await renderScreen(<ReadyScreen />);
    expect(await screen.findByTestId('ready-card-tMine')).toBeTruthy();
    expect(screen.getByText('2 productos esperando')).toBeTruthy(); // mine only
    expect(screen.getByTestId('ready-line-k1')).toBeTruthy();
    expect(screen.queryByTestId('ready-line-k3')).toBeNull(); // IN_PROGRESS is not ready
    expect(screen.getByTestId('ready-serve-k1')).toBeTruthy();
    expect(screen.getByText('DE OTROS MESEROS')).toBeTruthy();
    expect(screen.getByTestId('ready-line-b1')).toBeTruthy();
    expect(screen.queryByTestId('ready-serve-b1')).toBeNull();
    expect(screen.getByTestId('ready-serve-all-tMine')).toBeTruthy();
    expect(screen.getByText('Servir todo (2)')).toBeTruthy();
  });

  it('"Marcar servido" PATCHes SERVED for that line only', async () => {
    const m = api();
    await renderScreen(<ReadyScreen />);
    await fireEvent.press(await screen.findByTestId('ready-serve-k2'));
    await waitFor(() => expect(m.of('PATCH', /\/queue\/k2\/status/)).toHaveLength(1));
    expect(m.of('PATCH', /\/queue\/k2\/status/)[0].data).toEqual({ status: 'SERVED' });
    expect(m.of('PATCH', /\/queue\/k1\/status/)).toHaveLength(0);
  });

  it('"Servir todo (n)" serves every line of the table', async () => {
    const m = api();
    await renderScreen(<ReadyScreen />);
    await fireEvent.press(await screen.findByTestId('ready-serve-all-tMine'));
    await waitFor(() => expect(m.of('PATCH', /\/queue\/.*\/status/)).toHaveLength(2));
  });

  it('voided meanwhile (409 ITEM_VOIDED) shows a message', async () => {
    api({ 'PATCH /queue/[^/]+/status': httpError(409, 'ITEM_VOIDED') as never });
    await renderScreen(<ReadyScreen />);
    await fireEvent.press(await screen.findByTestId('ready-serve-k1'));
    expect(await screen.findByText('Este producto fue anulado.')).toBeTruthy();
  });

  it('empty state when nothing is ready', async () => {
    api({ 'GET /queue/kitchen': { data: [] }, 'GET /queue/bar': { data: [] } });
    await renderScreen(<ReadyScreen />);
    expect(await screen.findByTestId('ready-empty')).toBeTruthy();
    expect(screen.getByText('Tus pedidos listos aparecen aquí.')).toBeTruthy();
  });

  it('offline: buttons disabled', async () => {
    api();
    online(false);
    await renderScreen(<ReadyScreen />);
    await screen.findByTestId('ready-serve-k1');
    expect(screen.getByTestId('ready-serve-k1').props.accessibilityState.disabled).toBe(true);
  });
});

describe('useReadyNotifications', () => {
  function Probe() {
    useReadyNotifications();
    return null;
  }
  const ev = { item_id: 'a', status: 'READY', ticket_id: 'tMine', resource_code: 'T4', menu_item_name: 'Alitas BBQ 10 pz', quantity: 1, opened_by: 'u-waiter' };

  it('joins the kitchen and bar rooms and leaves them on unmount', async () => {
    mockApi({});
    const view = await renderScreen(<Probe />);
    expect(mockJoin).toHaveBeenCalledWith('kitchen');
    expect(mockJoin).toHaveBeenCalledWith('bar');
    await view.unmount();
    expect(mockLeave).toHaveBeenCalledWith('kitchen');
    expect(mockLeave).toHaveBeenCalledWith('bar');
  });

  it('READY on my ticket -> toast "Listo: {nombre} · {mesa}" with a "Ver" action to the ticket', async () => {
    mockApi({});
    await renderScreen(<Probe />);
    await act(async () => mockHandlers['kitchen:item_update'](ev));
    expect(await screen.findByText('Listo: Alitas BBQ 10 pz · T4')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('toast-action'));
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/tMine');
  });

  it('works for bar events too, once per item (duplicate delivery ignored)', async () => {
    mockApi({});
    await renderScreen(<Probe />);
    await act(async () => mockHandlers['bar:item_update']({ ...ev, item_id: 'b9', menu_item_name: 'Corona' }));
    expect(await screen.findByText('Listo: Corona · T4')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('toast-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('toast')).toBeNull());
    await act(async () => mockHandlers['bar:item_update']({ ...ev, item_id: 'b9', menu_item_name: 'Corona' }));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('ignores other waiters, other statuses; refetches when the payload has no B2 fields', async () => {
    const m = mockApi({});
    const { queryClient } = await renderScreen(<Probe />);
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    await act(async () => mockHandlers['kitchen:item_update']({ ...ev, item_id: 'o1', opened_by: 'someone' }));
    await act(async () => mockHandlers['kitchen:item_update']({ ...ev, item_id: 'o2', status: 'IN_PROGRESS' }));
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    await act(async () => mockHandlers['kitchen:item_update']({ item_id: 'o3', status: 'READY' }));
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['queue'] });
    expect(m.calls).toHaveLength(0);
  });
});
