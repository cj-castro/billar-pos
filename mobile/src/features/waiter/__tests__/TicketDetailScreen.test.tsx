import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useAuthStore } from '../../../state/authStore';
import { useDraftStore } from '../draft/draftStore';
import { TicketDetailScreen } from '../ticket/TicketDetailScreen';
import { httpError, line, makeRouter, mockApi, online, renderScreen, resource, setOnline, ticket } from '../testing/testkit';

const mockRouter = makeRouter();
const mockJoin = jest.fn();
const mockLeave = jest.fn();
jest.mock('expo-router', () => {
  const React = jest.requireActual('react');
  return { useRouter: () => mockRouter, useFocusEffect: (cb: () => void | (() => void)) => React.useEffect(cb, [cb]) };
});
jest.mock('../../../realtime/socket', () => ({
  ...jest.requireActual('../../../realtime/socket'),
  joinTicket: (id: string) => mockJoin(id),
  leaveTicket: (id: string) => mockLeave(id),
}));

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  useDraftStore.setState({ byTicket: {} });
  useAuthStore.setState({ user: { id: 'u-waiter', username: 'waiter1', name: 'Mariana', role: 'WAITER' } });
});

const resources = [resource({ id: 'r1', code: 'T1', status: 'IN_USE', active_ticket_id: 't1' }), resource({ id: 'bt1', code: 'BT1', type: 'POOL_TABLE', status: 'IN_USE', active_ticket_id: 't1' })];

const richTicket = () =>
  ticket({
    customer_name: 'Fam. Ruiz',
    subtotal_cents: 26000,
    total_cents: 24000,
    discount_cents: 2000,
    line_items: [
      line({ id: 'a', menu_item_name: 'Alitas BBQ', status: 'IN_PROGRESS', modifiers: [{ id: 'x', modifier_id: 'm', name: 'Búfalo', price_cents: 0 }], net_cents: 14500 }),
      line({ id: 'b', menu_item_name: 'Hamburguesa', status: 'SENT', notes: 'sin cebolla', net_cents: 11900 }),
      line({ id: 'c', menu_item_name: 'Papas', status: 'READY', net_cents: 6500 }),
      line({ id: 'd', menu_item_name: 'Coca', status: 'VOIDED', net_cents: 3500 }),
      line({ id: 'e', menu_item_name: 'Michelada', status: 'SERVED', net_cents: 6500 }),
    ],
  });

const api = (t = richTicket(), extra: Record<string, never | object> = {}) =>
  mockApi({
    'GET /tickets/t1': () => ({ data: t }),
    'GET /resources': { data: resources },
    'PATCH /queue/[^/]+/status': { data: { item_id: 'c', status: 'SERVED' } },
    'POST /tickets/t1/request-payment': { data: { ok: true, total_cents: t.total_cents } },
    'POST /tickets/t1/cancel': { data: { ok: true } },
    ...extra,
  });

describe('TicketDetailScreen', () => {
  it('shows lines with status chips, modifiers, notes, voided struck and server totals', async () => {
    api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByTestId('ticket-line-a')).toBeTruthy();
    expect(screen.getByText('Mesa T1')).toBeTruthy();
    expect(screen.getByTestId('ticket-line-a').props.accessibilityLabel).toContain('En preparación');
    expect(screen.getByTestId('ticket-line-a').props.accessibilityLabel).toContain('Búfalo');
    expect(screen.getByTestId('ticket-line-b').props.accessibilityLabel).toContain('Enviado');
    expect(screen.getByTestId('ticket-line-b').props.accessibilityLabel).toContain('sin cebolla');
    expect(screen.getByTestId('ticket-line-c').props.accessibilityLabel).toContain('Listo');
    expect(screen.getByTestId('ticket-line-d').props.accessibilityLabel).toContain('Cancelado');
    expect(screen.getByTestId('ticket-line-e').props.accessibilityLabel).toContain('Servido');
    expect(screen.getByTestId('ticket-subtotal').props.children).toBe('$260.00');
    expect(screen.getByTestId('ticket-discount').props.children).toBe('-$20.00');
    expect(screen.getByTestId('ticket-total').props.children).toBe('$240.00');
  });

  it('pool ticket: running timer labelled estimado + estimated pool time, never added locally', async () => {
    const t = ticket({
      id: 't1',
      resource_id: 'bt1',
      resource_code: 'BT1',
      line_items: [],
      subtotal_cents: 0,
      pool_time_cents: 16600,
      total_cents: 16600,
      timer_sessions: [{ id: 's1', start_time: new Date(Date.now() - 3_725_000).toISOString(), end_time: null, status: 'ACTIVE' }],
    });
    api(t);
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByTestId('ticket-timer')).toBeTruthy();
    expect(screen.getByText(/Tiempo de mesa · estimado/)).toBeTruthy();
    expect(screen.getByTestId('ticket-timer').props.children).toMatch(/^1:02:0\d$/);
    expect(screen.getByTestId('ticket-pool').props.children).toBe('≈ $166.00');
    expect(screen.getByText('Billar BT1')).toBeTruthy();
  });

  it('joins the ticket socket room while mounted/focused and leaves on exit', async () => {
    api();
    const view = await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await screen.findByTestId('ticket-line-a');
    expect(mockJoin).toHaveBeenCalledWith('t1');
    await view.unmount();
    expect(mockLeave).toHaveBeenCalledWith('t1');
  });

  it('"Pedir cuenta" asks for confirmation, warns about the pool timer, then POSTs request-payment', async () => {
    const t = ticket({ resource_id: 'bt1', resource_code: 'BT1', timer_sessions: [{ id: 's1', start_time: new Date().toISOString(), end_time: null, status: 'ACTIVE' }] });
    const m = api(t);
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-request-bill'));
    expect(screen.getByText('¿Pedir la cuenta de BT1?')).toBeTruthy();
    expect(screen.getByText(/El tiempo de mesa se detiene y la mesa queda libre/)).toBeTruthy();
    expect(m.of('POST', /request-payment/)).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('bill-dialog-confirm'));
    await waitFor(() => expect(m.of('POST', /request-payment/)).toHaveLength(1));
    expect(await screen.findByText('Cuenta solicitada. Avisamos a caja.')).toBeTruthy();
  });

  it('non-pool table: no timer warning in the confirmation', async () => {
    api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-request-bill'));
    expect(screen.queryByText(/se detiene/)).toBeNull();
  });

  it('cancelling the confirmation sends nothing', async () => {
    const m = api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-request-bill'));
    await fireEvent.press(screen.getByTestId('bill-dialog-cancel'));
    expect(m.of('POST', /request-payment/)).toHaveLength(0);
  });

  it('blocks "Pedir cuenta" while the draft has unsent lines', async () => {
    const m = api();
    useDraftStore.getState().addLine('t1', { menuItemId: 'm', name: 'Nachos', unitPriceCents: 9500, quantity: 2, modifiers: [], notes: '' });
    useDraftStore.getState().addLine('t1', { menuItemId: 'm2', name: 'Papas', unitPriceCents: 6500, quantity: 1, modifiers: [], notes: '' });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByTestId('ticket-draft-bar')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ticket-request-bill'));
    expect(screen.getByText('Tienes 2 productos por enviar. Envíalos o descártalos primero.')).toBeTruthy();
    expect(m.of('POST', /request-payment/)).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('draft-block-dialog-confirm'));
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/t1/draft');
  });

  it('draft hint bar opens the draft', async () => {
    api();
    useDraftStore.getState().addLine('t1', { menuItemId: 'm', name: 'Nachos', unitPriceCents: 9500, quantity: 1, modifiers: [], notes: '' });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByText('1 producto por enviar')).toBeTruthy(); // the hint bar renders the unsent count
    await fireEvent.press(await screen.findByTestId('ticket-draft-bar'));
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/t1/draft');
  });

  it('"Agregar productos" goes to the menu', async () => {
    api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-add-products'));
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/t1/menu');
  });

  it('"Marcar servido" appears on READY lines only and PATCHes SERVED', async () => {
    const m = api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await screen.findByTestId('ticket-line-c');
    expect(screen.queryByTestId('ticket-serve-a')).toBeNull();
    expect(screen.queryByTestId('ticket-serve-e')).toBeNull();
    await fireEvent.press(screen.getByTestId('ticket-serve-c'));
    await waitFor(() => expect(m.of('PATCH', /\/queue\/c\/status/)).toHaveLength(1));
    expect(m.of('PATCH', /\/queue\/c\/status/)[0].data).toEqual({ status: 'SERVED' });
  });

  it('voided meanwhile (409 ITEM_VOIDED) shows a clear message', async () => {
    api(richTicket(), { 'PATCH /queue/[^/]+/status': httpError(409, 'ITEM_VOIDED') as never });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-serve-c'));
    expect(await screen.findByText('Este producto fue anulado.')).toBeTruthy();
  });

  it('"Cancelar mesa" only for an empty ticket, then POSTs cancel and returns to the floor', async () => {
    const full = api();
    const view = await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await screen.findByTestId('ticket-line-a');
    expect(screen.queryByTestId('ticket-cancel')).toBeNull();
    await view.unmount();

    const empty = ticket({ line_items: [line({ status: 'VOIDED' })], timer_sessions: [], subtotal_cents: 0, total_cents: 0 });
    const m = api(empty);
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-cancel'));
    await fireEvent.press(screen.getByTestId('cancel-dialog-confirm'));
    await waitFor(() => expect(m.of('POST', /cancel/)).toHaveLength(1));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/floor'));
    expect(full.of('POST', /cancel/)).toHaveLength(0);
  });

  it('never offers cancel when the table has timer sessions', async () => {
    api(ticket({ line_items: [], timer_sessions: [{ id: 's', start_time: new Date().toISOString(), end_time: null, status: 'ACTIVE' }] }));
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await screen.findByTestId('ticket-empty');
    expect(screen.queryByTestId('ticket-cancel')).toBeNull();
  });

  it('empty open ticket shows the empty state', async () => {
    api(ticket({ line_items: [], total_cents: 0, subtotal_cents: 0 }));
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByText('Aún no hay productos')).toBeTruthy();
  });

  it('closed ticket is read-only: no actions', async () => {
    api(ticket({ status: 'CLOSED' }));
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByTestId('ticket-closed')).toBeTruthy();
    expect(screen.queryByTestId('ticket-actions')).toBeNull();
    expect(screen.queryByTestId('ticket-extras')).toBeNull();
  });

  it('bill already requested: state chip says so and the button is disabled', async () => {
    api(ticket({ payment_requested: true }));
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    const chip = await screen.findByTestId('ticket-state');
    expect(chip.props.accessibilityLabel).toBe('Cuenta solicitada');
    expect(screen.getByTestId('ticket-request-bill').props.accessibilityState.disabled).toBe(true);
  });

  it('manager mode: no "Agregar productos"; discount action present', async () => {
    api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="manager" />);
    await screen.findByTestId('ticket-line-a');
    expect(screen.queryByTestId('ticket-add-products')).toBeNull();
    expect(screen.getByTestId('ticket-request-bill')).toBeTruthy();
    expect(screen.getByTestId('ticket-discount-btn')).toBeTruthy();
  });

  it('waiter mode has no discount action', async () => {
    api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await screen.findByTestId('ticket-line-a');
    expect(screen.queryByTestId('ticket-discount-btn')).toBeNull();
  });

  it('offline: cached ticket stays, "Pedir cuenta" is disabled with the reason, adding products still works', async () => {
    api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await screen.findByTestId('ticket-line-a');
    await setOnline(false);
    await waitFor(() => expect(screen.getByTestId('ticket-request-bill').props.accessibilityState.disabled).toBe(true));
    expect(screen.getByText('Sin conexión. Necesitas conexión para pedir la cuenta.')).toBeTruthy();
    expect(screen.getByTestId('ticket-add-products').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('ticket-line-a')).toBeTruthy();
  });

  it('404 shows "Ticket no encontrado" with a way back', async () => {
    mockApi({ 'GET /tickets/t1': { status: 404, data: '<html>' }, 'GET /resources': { data: [] } });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByText('Ticket no encontrado')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ticket-not-found-action'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/floor');
  });

  it('server error shows ErrorState with retry', async () => {
    mockApi({ 'GET /tickets/t1': httpError(500, 'X'), 'GET /resources': { data: [] } });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    expect(await screen.findByTestId('error-state', {}, { timeout: 4000 })).toBeTruthy();
  });
});
