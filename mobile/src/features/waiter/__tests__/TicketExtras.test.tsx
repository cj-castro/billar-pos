import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useAuthStore } from '../../../state/authStore';
import { useDraftStore } from '../draft/draftStore';
import { PIN_COOLDOWN_MS, resetPinGuard } from '../ticket/TicketExtras';
import { TicketDetailScreen } from '../ticket/TicketDetailScreen';
import { httpError, line, makeRouter, mockApi, online, renderScreen, resource, ticket } from '../testing/testkit';

const mockRouter = makeRouter();
jest.mock('expo-router', () => {
  const React = jest.requireActual('react');
  return { useRouter: () => mockRouter, useFocusEffect: (cb: () => void | (() => void)) => React.useEffect(cb, [cb]) };
});

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  useDraftStore.setState({ byTicket: {} });
  useAuthStore.setState({ user: { id: 'u', username: 'w', name: 'Mariana', role: 'WAITER' }, accessToken: 'A', refreshToken: 'R' });
});

const t0 = () => ticket({ line_items: [line({ id: 'a', menu_item_name: 'Alitas', quantity: 2, status: 'SENT' })] });
const api = (over: Record<string, never | object> = {}) =>
  mockApi({
    'GET /tickets/t1': () => ({ data: t0() }),
    'GET /resources': {
      data: [resource({ id: 'r1', code: 'T1', status: 'IN_USE', active_ticket_id: 't1' }), resource({ id: 'r2', code: 'T2' }), resource({ id: 'r3', code: 'T3', status: 'IN_USE', active_ticket_id: 'x' })],
    },
    'DELETE /tickets/t1/items/a': { data: { message: 'Item voided' } },
    'PATCH /tickets/t1/items/a': { data: line({ id: 'a' }) },
    'POST /auth/refresh': { data: { access_token: 'A2' } },
    ...over,
  });
const pin = async (digits: string) => {
  for (const d of digits) await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
};
const openLine = async () => {
  await fireEvent(await screen.findByTestId('ticket-line-a'), 'longPress');
};

describe('P1 ticket actions', () => {
  it('void: long-press -> Anular -> confirmation -> manager PIN -> DELETE {pin, reason}', async () => {
    const m = api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await openLine();
    await fireEvent.press(screen.getByTestId('line-action-void'));
    expect(screen.getByText('¿Anular Alitas?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('void-dialog-confirm'));
    await pin('1234');
    await waitFor(() => expect(m.of('DELETE', /items\/a$/)).toHaveLength(1));
    expect(m.of('DELETE', /items\/a$/)[0].data).toEqual({ pin: '1234', reason: 'mobile' });
    expect(await screen.findByText('Producto anulado')).toBeTruthy();
  });

  it('void: wrong PIN (401 INVALID_PIN) keeps the pad open with an error and does not log the user out', async () => {
    api({ 'DELETE /tickets/t1/items/a': httpError(401, 'INVALID_PIN') as never });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await openLine();
    await fireEvent.press(screen.getByTestId('line-action-void'));
    await fireEvent.press(screen.getByTestId('void-dialog-confirm'));
    await pin('9999');
    expect(await screen.findByText('PIN incorrecto. Intenta de nuevo.')).toBeTruthy();
    expect(screen.getByTestId('pin-pad')).toBeTruthy();
    expect(useAuthStore.getState().user).not.toBeNull();
  });

  it('void: cancelling at the confirmation sends nothing', async () => {
    const m = api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await openLine();
    await fireEvent.press(screen.getByTestId('line-action-void'));
    await fireEvent.press(screen.getByTestId('void-dialog-cancel'));
    expect(m.of('DELETE', /items/)).toHaveLength(0);
  });

  it('voided lines have no actions', async () => {
    api({ 'GET /tickets/t1': (() => ({ data: ticket({ line_items: [line({ id: 'a', status: 'VOIDED' })] }) })) as never });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent(await screen.findByTestId('ticket-line-a'), 'longPress');
    expect(screen.queryByTestId('line-actions')).toBeNull();
  });

  it('quantity: increase needs no PIN', async () => {
    const m = api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await openLine();
    await fireEvent.press(screen.getByTestId('line-action-qty'));
    await fireEvent.press(screen.getByTestId('qty-stepper-inc'));
    await fireEvent.press(screen.getByTestId('qty-apply'));
    await waitFor(() => expect(m.of('PATCH', /items\/a$/)).toHaveLength(1));
    expect(m.of('PATCH', /items\/a$/)[0].data).toEqual({ quantity: 3 });
  });

  it('quantity: decrease asks for the manager PIN and sends it', async () => {
    const m = api();
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await openLine();
    await fireEvent.press(screen.getByTestId('line-action-qty'));
    await fireEvent.press(screen.getByTestId('qty-stepper-dec'));
    expect(screen.getByText('Para bajar la cantidad se pide el PIN de un gerente.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('qty-apply'));
    expect(m.of('PATCH', /items\/a$/)).toHaveLength(0);
    await pin('4321');
    await waitFor(() => expect(m.of('PATCH', /items\/a$/)).toHaveLength(1));
    expect(m.of('PATCH', /items\/a$/)[0].data).toEqual({ quantity: 1, pin: '4321' });
  });

  it('customer name edit PATCHes the trimmed name', async () => {
    const m = api({ 'PATCH /tickets/t1/customer-name': { data: ticket({ customer_name: 'Ana' }) } });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-edit-name'));
    await fireEvent.changeText(screen.getByTestId('name-input'), '  Ana ');
    await fireEvent.press(screen.getByTestId('name-save'));
    await waitFor(() => expect(m.of('PATCH', /customer-name/)).toHaveLength(1));
    expect(m.of('PATCH', /customer-name/)[0].data).toEqual({ customer_name: 'Ana' });
  });

  it('transfer lists only free tables and POSTs the target', async () => {
    const m = api({ 'POST /tickets/t1/transfer': { data: ticket({ resource_code: 'T2' }) } });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await screen.findByTestId('ticket-line-a');
    await fireEvent.press(await screen.findByTestId('ticket-transfer'));
    expect(await screen.findByTestId('transfer-T2')).toBeTruthy();
    expect(screen.queryByTestId('transfer-T3')).toBeNull(); // occupied
    expect(screen.queryByTestId('transfer-T1')).toBeNull(); // itself
    await fireEvent.press(screen.getByTestId('transfer-T2'));
    await waitFor(() => expect(m.of('POST', /transfer/)).toHaveLength(1));
    expect(m.of('POST', /transfer/)[0].data).toEqual({ target_resource_id: 'r2' });
  });

  it('transfer to a table that got taken (409) explains', async () => {
    api({ 'POST /tickets/t1/transfer': httpError(409, 'RESOURCE_OCCUPIED') as never });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-transfer'));
    await fireEvent.press(await screen.findByTestId('transfer-T2'));
    expect(await screen.findByText('Esa mesa ya está ocupada.')).toBeTruthy();
  });

  it('print pre-bill: POST with ?unpaid=true', async () => {
    const m = api({ 'POST /tickets/t1/print': { data: { ok: true, job_id: 'j1' } } });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-print'));
    await waitFor(() => expect(m.of('POST', /print$/)).toHaveLength(1));
    expect(m.of('POST', /print$/)[0].params).toEqual({ unpaid: true });
    expect(await screen.findByText('Pre-cuenta enviada a la impresora')).toBeTruthy();
  });

  it('print pre-bill 503 -> "Impresora no disponible"', async () => {
    api({ 'POST /tickets/t1/print': { status: 503, data: { ok: false, error: 'Print agent not running. Start it on the Windows host.' } } });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await fireEvent.press(await screen.findByTestId('ticket-print'));
    expect(await screen.findByText('Impresora no disponible.')).toBeTruthy();
  });

  it('manager discount: pick %, then PATCH /discount directly (no PIN sheet)', async () => {
    const m = api({ 'PATCH /tickets/t1/discount': { data: ticket({ manual_discount_pct: 10 }) } });
    useAuthStore.setState({ user: { id: 'm1', username: 'manager', name: 'Rodrigo', role: 'MANAGER' } });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="manager" />);
    await fireEvent.press(await screen.findByTestId('ticket-discount-btn'));
    await fireEvent.press(screen.getByTestId('discount-10'));
    await fireEvent.press(screen.getByTestId('discount-apply'));
    await waitFor(() => expect(m.of('PATCH', /discount/)).toHaveLength(1));
    expect(m.of('POST', /verify-pin/)).toHaveLength(0);
    expect(screen.queryByTestId('pin-sheet')).toBeNull();
    expect(m.of('PATCH', /discount/)[0].data).toEqual({ pct: 10, reason: 'mobile' });
    expect(await screen.findByText('Descuento aplicado')).toBeTruthy();
  });

  it('SEC-07: 3 consecutive INVALID_PIN lock the pad for 30 s with a countdown; no request while locked', async () => {
    resetPinGuard();
    const m = api({ 'DELETE /tickets/t1/items/a': httpError(401, 'INVALID_PIN') as never });
    await renderScreen(<TicketDetailScreen ticketId="t1" mode="waiter" />);
    await openLine();
    await fireEvent.press(screen.getByTestId('line-action-void'));
    await fireEvent.press(screen.getByTestId('void-dialog-confirm'));
    await pin('1111');
    expect(await screen.findByText('PIN incorrecto. Intenta de nuevo.')).toBeTruthy();
    await pin('2222');
    await waitFor(() => expect(m.of('DELETE', /items\/a$/)).toHaveLength(2));
    await pin('3333');
    await waitFor(() => expect(m.of('DELETE', /items\/a$/)).toHaveLength(3));
    expect(await screen.findByText(/Demasiados intentos.*\(30 s\)/)).toBeTruthy();
    // locked: keys are dead, a 4th attempt sends nothing
    await pin('4444');
    expect(m.of('DELETE', /items\/a$/)).toHaveLength(3);
    expect(PIN_COOLDOWN_MS).toBe(30_000);
    resetPinGuard();
  });
});

