import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useAuthStore } from '../../../state/authStore';
import { PayScreen } from '../pay/PayScreen';
import { usePayAttemptStore } from '../pay/payAttemptStore';
import { httpError, makeRouter, mockApi, online, renderScreen, resource, setOnline, ticket } from '../testing/testkit';

const mockRouter = makeRouter();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  usePayAttemptStore.setState({ keys: {} });
  useAuthStore.setState({ user: { id: 'u', username: 'w', name: 'Mariana', role: 'WAITER' } });
});

const t0 = () => ticket({ total_cents: 14500, subtotal_cents: 14500 });
const closed = () => ({ ...t0(), status: 'CLOSED', change_due: 500 });

describe('PayScreen', () => {
  it('cash exact: Efectivo, exacto, Cobrar, Confirmar -> POST close with idempotency key, then success state', async () => {
    const m = mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': { data: { ...closed(), change_due: 0 } } });
    await renderScreen(<PayScreen ticketId="t1" />);
    // Efectivo is pre-selected for non-delivery tickets: Cobrar, exacto, Cobrar, Confirmar.
    await screen.findByTestId('pay-exact');
    expect(screen.getByTestId('pay-submit').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    expect(screen.getByText('Cobrar $145.00 en efectivo · Cambio $0.00')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    await waitFor(() => expect(m.of('POST', /close/)).toHaveLength(1));
    const call = m.of('POST', /close/)[0];
    expect(call.data).toEqual({ payment_type: 'CASH', tendered_cents: 14500, tip_cents: 0, tip_source: 'CASH', expected_total_cents: 14500 });
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(await screen.findByTestId('pay-success')).toBeTruthy();
    expect(screen.getByText('Mesa T1 cerrada')).toBeTruthy();
    expect(usePayAttemptStore.getState().keys.t1).toBeUndefined();
  });

  it('shows change due on success when the server reports it', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': { data: closed() } });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-chip-200'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect((await screen.findByTestId('pay-change-due')).props.children).toBe('$5.00');
  });

  it('INSUFFICIENT_PAYMENT: refetches, shows the server total and resets the tendered amount', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': httpError(422, 'INSUFFICIENT_PAYMENT') as never });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect(await screen.findByText('El total es $145.00. Revisa el monto recibido.')).toBeTruthy();
    expect(screen.getByTestId('pay-cash-value').props.children).toBe('$0.00');
    expect(screen.queryByTestId('pay-success')).toBeNull();
  });

  it('INSUFFICIENT_PAYMENT: uses details.total_cents from the error body (no refetch needed for the message)', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': { status: 422, data: { error: 'INSUFFICIENT_PAYMENT', total_cents: 16000 } } as never });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect(await screen.findByText('El total es $160.00. Revisa el monto recibido.')).toBeTruthy();
  });

  it('manager returns to the tickets list after paying', async () => {
    useAuthStore.setState({ user: { id: 'u', username: 'm', name: 'Ana', role: 'MANAGER' } });
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': { data: closed() } });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    await fireEvent.press(await screen.findByTestId('pay-back'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/tickets');
  });

  it('AMOUNT_MISMATCH (idempotent close) is handled the same way', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': httpError(422, 'AMOUNT_MISMATCH') as never });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect(await screen.findByText('El total es $145.00. Revisa el monto recibido.')).toBeTruthy();
  });

  it('TICKET_NOT_OPEN is an error: toast with status, refetch, back to the ticket (no success screen)', async () => {
    const m = mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': { status: 409, data: { error: 'TICKET_NOT_OPEN', status: 'CLOSED' } } as never });
    mockRouter.canGoBack.mockReturnValue(true);
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect(await screen.findByText('El ticket ya no está abierto (estado CLOSED)')).toBeTruthy();
    expect(screen.queryByTestId('pay-success')).toBeNull();
    expect(mockRouter.back).toHaveBeenCalled();
    await waitFor(() => expect(m.of('GET', /tickets\/t1$/).length).toBeGreaterThan(1));
  });

  it('PIN_LOCKED shows the lockout message', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': httpError(429, 'PIN_LOCKED') as never });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect(await screen.findByText('PIN bloqueado, espera 10 min')).toBeTruthy();
  });

  it('success without change_due shows no change line (never computed locally)', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': { data: { ...t0(), status: 'CLOSED' } } });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-chip-200'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    await screen.findByTestId('pay-success');
    expect(screen.queryByTestId('pay-change-due')).toBeNull();
  });

  it('422 with a tip: message uses details.total_cents and shows the tip separately', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() }, 'POST /tickets/t1/close': { status: 422, data: { error: 'INSUFFICIENT_PAYMENT', total_cents: 20000, expected_total_cents: 23000 } } as never });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-tip-10'));
    await fireEvent.press(screen.getByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect(await screen.findByText('El total es $200.00 más propina $20.00. Revisa el monto recibido.')).toBeTruthy();
  });

  it('running pool timer: due is the "≈" estimate, close still sends the fetched total', async () => {
    const start = new Date(Date.now() - 3600_000).toISOString();
    const tk = ticket({ total_cents: 0, subtotal_cents: 0, pool_time_cents: 0, timer_sessions: [{ id: 's1', start_time: start, end_time: null, status: 'ACTIVE' }] as never });
    mockApi({
      'GET /tickets/t1': { data: tk },
      'GET /resources': { data: [resource({ type: 'POOL_TABLE', pool_config: { billing_mode: 'PER_HOUR', rate_cents: 12000 } as never })] },
    });
    await renderScreen(<PayScreen ticketId="t1" />);
    await waitFor(() => expect(screen.getByTestId('pay-due').props.children).toBe('≈ $120.00'));
  });

  it('custom tip over 50% asks for confirmation first', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() } });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-tip-custom'));
    for (const k of ['1', '0', '0']) await fireEvent.press(screen.getByTestId(`cash-pad-${k}`));
    await fireEvent.press(screen.getByTestId('pay-chip-250'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    expect(screen.getByTestId('pay-tip-dialog')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('pay-tip-dialog-confirm'));
    expect(screen.getByTestId('pay-dialog')).toBeTruthy();
  });

  it('PIN_REQUIRED opens the PIN pad and resends with manager_pin and the same key', async () => {
    let n = 0;
    const m = mockApi({
      'GET /tickets/t1': { data: t0() },
      'POST /tickets/t1/close': () => (n++ === 0 ? (httpError(403, 'PIN_REQUIRED') as never) : { data: closed() }),
    });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    await fireEvent.press(screen.getByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    expect(await screen.findByTestId('pin-pad')).toBeTruthy();
    for (const d of '1234') await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
    await waitFor(() => expect(m.of('POST', /close/)).toHaveLength(2));
    const [first, second] = m.of('POST', /close/);
    expect((second.data as { manager_pin: string }).manager_pin).toBe('1234');
    expect(second.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  });

  it('offline disables Cobrar', async () => {
    mockApi({ 'GET /tickets/t1': { data: t0() } });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-exact'));
    expect(screen.getByTestId('pay-submit').props.accessibilityState.disabled).toBe(false);
    await setOnline(false);
    await waitFor(() => expect(screen.getByTestId('pay-submit').props.accessibilityState.disabled).toBe(true));
  });

  it('DELIVERY tickets pay externally with no tendered amount', async () => {
    const m = mockApi({
      'GET /tickets/t1': { data: ticket({ ticket_type: 'DELIVERY', total_cents: 9000, resource_id: null }) },
      'POST /tickets/t1/close': { data: { ...t0(), status: 'CLOSED' } },
    });
    await renderScreen(<PayScreen ticketId="t1" />);
    await fireEvent.press(await screen.findByTestId('pay-submit'));
    await fireEvent.press(screen.getByTestId('pay-dialog-confirm'));
    await waitFor(() => expect(m.of('POST', /close/)).toHaveLength(1));
    expect(m.of('POST', /close/)[0].data).toEqual({ payment_type: 'EXTERNAL', tip_cents: 0, expected_total_cents: 9000 });
  });
});
