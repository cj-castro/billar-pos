import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useAuthStore } from '../../../state/authStore';
import { httpError, mockApi, online, renderScreen } from '../../waiter/testing/testkit';
import { CashScreen } from '../cash/CashScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const session = { id: 's1', date: '2026-11-05', status: 'OPEN', opening_fund_cents: 50000, closing_cash_counted_cents: null, opened_by: 'm', closed_by: null, opened_at: '2026-11-05T20:00:00+00:00', closed_at: null, notes: null };
const summary = (over: Record<string, unknown> = {}) => ({
  ticket_count: 2,
  total_sales_cents: 80000,
  total_tips_cents: 6000,
  cash_sales_cents: 50000,
  card_sales_cents: 30000,
  cash_tips_cents: 2000,
  card_tips_cents: 4000,
  total_expenses_cents: 5000,
  cash_expenses_cents: 5000,
  card_expenses_cents: 0,
  tip_payout_cents: 6000,
  opening_fund_cents: 50000,
  expected_cash_cents: 91000,
  closing_cash_counted_cents: null,
  cash_over_short_cents: null,
  expenses: [{ id: 'e1', session_id: 's1', amount_cents: 5000, payment_method: 'CASH', payee: 'Hielera', description: 'Hielo', created_by: 'm', created_at: '2026-11-05T21:00:00+00:00' }],
  tip_distribution: { floor_pct: 50, bar_pct: 30, kitchen_pct: 20 },
  ...over,
});

const press = async (id: string) => fireEvent.press(await screen.findByTestId(id));

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  useAuthStore.setState({ user: { id: 'm', username: 'manager', name: 'Gerente', role: 'MANAGER' } });
});

describe('CashScreen', () => {
  it('closed register -> Abrir caja with the numpad posts opening_fund_cents and shows the open summary', async () => {
    let opened = false;
    const api = mockApi({
      'GET /cash/current/summary': () => (opened ? { data: { session, summary: summary() } } : httpError(404, 'NO_OPEN_SESSION')),
      'POST /cash/open': () => {
        opened = true;
        return { status: 201, data: session };
      },
    });
    await renderScreen(<CashScreen />);
    expect(await screen.findByTestId('cash-closed')).toBeTruthy();
    await press('cash-open-btn');
    await fireEvent.changeText(screen.getByTestId('fund-pad'), '500.50');
    expect(screen.getByTestId('fund-pad-amount').props.children).toBe('$500.50');
    await press('open-cash-confirm');
    await waitFor(() => expect(api.of('POST', /\/cash\/open/)).toHaveLength(1));
    expect(api.of('POST', /\/cash\/open/)[0].data).toEqual({ opening_fund_cents: 50050 });
    expect(await screen.findByTestId('cash-summary')).toBeTruthy();
    expect(screen.getByTestId('line-expected').props.accessibilityLabel).toBe('Esperado en caja: $910.00');
    expect(screen.getByTestId('line-fund').props.accessibilityLabel).toBe('Fondo: $500.00');
    expect(screen.getByTestId('tip-distribution')).toBeTruthy();
  });

  it('open register -> Cerrar caja shows the difference vs expected and posts the count', async () => {
    let closed = false;
    const api = mockApi({
      'GET /cash/current/summary': () => (closed ? httpError(404, 'NO_OPEN_SESSION') : { data: { session, summary: summary() } }),
      'POST /cash/close': () => {
        closed = true;
        return { data: { session: { ...session, status: 'CLOSED' }, summary: summary({ closing_cash_counted_cents: 90000, cash_over_short_cents: -1000 }) } };
      },
    });
    await renderScreen(<CashScreen />);
    await press('cash-close-btn');
    expect(screen.getByTestId('close-expected').props.accessibilityLabel).toBe('Esperado en caja: $910.00');
    expect(screen.getByTestId('close-cash-confirm').props.accessibilityState.disabled).toBe(true); // no count yet
    await fireEvent.changeText(screen.getByTestId('count-pad'), '900.25');
    expect(screen.getByTestId('close-diff').props.accessibilityLabel).toBe('Diferencia: -$9.75');
    expect(screen.getByText('Faltante')).toBeTruthy();
    await press('close-cash-confirm');
    await waitFor(() => expect(api.of('POST', /\/cash\/close/)).toHaveLength(1));
    expect(api.of('POST', /\/cash\/close/)[0].data).toEqual({ closing_cash_counted_cents: 90025, notes: null });
    expect(await screen.findByTestId('cash-closed-summary')).toBeTruthy();
    expect(screen.getByTestId('cash-closed-diff').props.accessibilityLabel).toBe('Diferencia: -$10.00');
  });

  it('409 OPEN_TICKETS shows the count and a link to Tickets', async () => {
    mockApi({
      'GET /cash/current/summary': { data: { session, summary: summary() } },
      'POST /cash/close': httpError(409, 'OPEN_TICKETS', 'No se puede cerrar la caja: hay 3 cuentas abiertas pendientes. Ciérralas primero.'),
    });
    await renderScreen(<CashScreen />);
    await press('cash-close-btn');
    await fireEvent.changeText(screen.getByTestId('count-pad'), '910');
    await press('close-cash-confirm');
    expect(await screen.findByText('Hay 3 cuentas abiertas. Ciérralas antes de cerrar la caja.')).toBeTruthy();
    await press('close-go-tickets');
    expect(mockPush).toHaveBeenCalledWith('/tickets');
  });

  it('adds an expense (concepto -> description) and validates required fields', async () => {
    const api = mockApi({
      'GET /cash/current/summary': { data: { session, summary: summary() } },
      'POST /cash/current/expenses': { status: 201, data: {} },
    });
    await renderScreen(<CashScreen />);
    await press('cash-add-expense');
    await press('expense-save');
    expect(await screen.findByTestId('expense-error')).toBeTruthy();
    expect(api.of('POST', /expenses/)).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('expense-description'), 'Limones');
    await fireEvent.changeText(screen.getByTestId('expense-payee'), 'Mercado');
    await fireEvent.changeText(screen.getByTestId('expense-amount'), '120.50');
    await press('expense-method-CARD');
    await press('expense-save');
    await waitFor(() => expect(api.of('POST', /expenses/)).toHaveLength(1));
    expect(api.of('POST', /expenses/)[0].data).toEqual({ amount_cents: 12050, payee: 'Mercado', description: 'Limones', payment_method: 'CARD' });
    await waitFor(() => expect(screen.queryByTestId('expense-sheet')).toBeNull());
  });

  it('deleting an expense asks for confirmation first', async () => {
    const api = mockApi({
      'GET /cash/current/summary': { data: { session, summary: summary() } },
      'DELETE /cash/expenses/e1': { data: { ok: true } },
    });
    await renderScreen(<CashScreen />);
    await press('expense-delete-e1');
    expect(api.of('DELETE', /expenses/)).toHaveLength(0);
    await press('delete-expense-dialog-confirm');
    await waitFor(() => expect(api.of('DELETE', /expenses\/e1/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('delete-expense-dialog')).toBeNull());
  });

  describe('count by denomination (flag on)', () => {
    const denominations = [
      { key: 'B500', cents: 50000, kind: 'BILL' },
      { key: 'B20', cents: 2000, kind: 'BILL' },
      { key: 'C10', cents: 1000, kind: 'COIN' },
    ];
    const status = (open: boolean) => ({ open, session: open ? session : null, open_tickets_count: 0, ghost_tickets_count: 0, denominations, fund_target_cents: 200000, count_by_denomination: true });

    it('open: grid sends {count} (no legacy fund) and shows the live total', async () => {
      let opened = false;
      const api = mockApi({
        'GET /cash/status': () => ({ data: status(opened) }),
        'GET /cash/current/summary': () => (opened ? { data: { session, summary: summary() } } : httpError(404, 'NO_OPEN_SESSION')),
        'POST /cash/open': () => {
          opened = true;
          return { status: 201, data: session };
        },
      });
      await renderScreen(<CashScreen />);
      await press('cash-open-btn');
      await fireEvent.changeText(await screen.findByTestId('open-count-B500'), '4');
      await fireEvent.changeText(screen.getByTestId('open-count-C10'), '3');
      expect(screen.getByTestId('open-count-total').props.accessibilityLabel).toContain('$2,030.00');
      await press('open-cash-confirm');
      await waitFor(() => expect(api.of('POST', /\/cash\/open/)).toHaveLength(1));
      expect(api.of('POST', /\/cash\/open/)[0].data).toEqual({ count: [{ key: 'B500', qty: 4 }, { key: 'C10', qty: 3 }] });
    });

    it('close is blind, then count -> what stays -> note rule -> sends {count, drawer_left, notes} and shows the envelope number', async () => {
      let closed = false;
      const api = mockApi({
        'GET /cash/status': () => ({ data: status(!closed) }),
        'GET /cash/current/summary': () => (closed ? httpError(404, 'NO_OPEN_SESSION') : { data: { session, summary: summary() } }),
        'POST /cash/close': () => {
          closed = true;
          return { data: { session: { ...session, status: 'CLOSED' }, summary: summary({ closing_cash_counted_cents: 250000, cash_over_short_cents: 0 }), envelope: { number: 17, declared_cents: 50000, lines: [{ key: 'B500', qty: 1 }] }, slip_drawer_left: { total_cents: 200000, lines: [{ key: 'B500', qty: 4 }] } } };
        },
      });
      await renderScreen(<CashScreen />);
      // blind: the summary card does not show the expected cash either
      expect(screen.queryByTestId('line-expected')).toBeNull();
      await press('cash-close-btn');
      expect(screen.getByText('Paga las propinas y registra todos los gastos antes de contar')).toBeTruthy();
      expect(screen.queryByTestId('close-expected')).toBeNull();
      await press('close-reminder-ok');
      await fireEvent.changeText(await screen.findByTestId('close-count-B500'), '5');
      expect(screen.queryByTestId('close-diff')).toBeNull();
      await press('close-count-next');
      expect(screen.getByText('¿Qué se queda en caja?')).toBeTruthy();
      await fireEvent.changeText(screen.getByTestId('left-count-B500'), '9'); // row max = counted qty (5)
      expect(screen.getByTestId('left-count-B500').props.value).toBe('5');
      await fireEvent.changeText(screen.getByTestId('left-count-B500'), '3');
      expect(screen.getByTestId('left-gap').props.accessibilityLabel).toContain('Faltan');
      expect(screen.getByTestId('left-gap').props.accessibilityLabel).toContain('$500.00');
      expect(screen.getByTestId('close-cash-confirm').props.accessibilityState.disabled).toBe(true); // note required
      await fireEvent.changeText(screen.getByTestId('close-notes'), 'Falta fondo, gasto pendiente');
      expect(screen.getByTestId('close-cash-confirm').props.accessibilityState.disabled).toBe(false);
      expect(screen.getByTestId('envelope-total').props.accessibilityLabel).toContain('$1,000.00');
      await press('close-cash-confirm');
      await waitFor(() => expect(api.of('POST', /\/cash\/close/)).toHaveLength(1));
      expect(api.of('POST', /\/cash\/close/)[0].data).toEqual({ count: [{ key: 'B500', qty: 5 }], drawer_left: [{ key: 'B500', qty: 3 }], notes: 'Falta fondo, gasto pendiente' });
      expect(await screen.findByTestId('cash-closed-envelope')).toBeTruthy();
      expect(screen.getByText('Sobre n.º 17')).toBeTruthy();
      expect(screen.getByText('Imprime los comprobantes del sobre desde el POS (Caja) antes de abrir.')).toBeTruthy();
      // After the close is submitted the manager sees the close result too
      // (expected / counted / difference), next to the envelope card. Before the
      // final review this line asserted the opposite; spec 5.1 step 5 requires it.
      expect(screen.getByTestId('cash-closed-summary')).toBeTruthy();
      expect(screen.getByTestId('cash-closed-diff').props.accessibilityLabel).toBe('Diferencia: $0.00');
    });

    it('left equal to the fund target needs no note', async () => {
      mockApi({
        'GET /cash/status': { data: status(true) },
        'GET /cash/current/summary': { data: { session, summary: summary() } },
      });
      await renderScreen(<CashScreen />);
      await press('cash-close-btn');
      await press('close-reminder-ok');
      await fireEvent.changeText(await screen.findByTestId('close-count-B500'), '5');
      await press('close-count-next');
      await fireEvent.changeText(screen.getByTestId('left-count-B500'), '4');
      expect(screen.getByTestId('close-cash-confirm').props.accessibilityState.disabled).toBe(false);
    });

    it('zero open count asks for confirmation, sends nothing until confirmed, then sends {count: []}', async () => {
      const api = mockApi({
        'GET /cash/status': { data: status(false) },
        'GET /cash/current/summary': httpError(404, 'NO_OPEN_SESSION'),
        'POST /cash/open': { status: 201, data: session },
      });
      await renderScreen(<CashScreen />);
      await press('cash-open-btn');
      await press('open-cash-confirm');
      expect(await screen.findByText('¿Abrir con la caja vacía ($0)?')).toBeTruthy();
      expect(api.of('POST', /\/cash\/open/)).toHaveLength(0);
      await press('zero-count-dialog-confirm');
      await waitFor(() => expect(api.of('POST', /\/cash\/open/)).toHaveLength(1));
      expect(api.of('POST', /\/cash\/open/)[0].data).toEqual({ count: [] });
    });

    it('zero open count: cancel sends nothing', async () => {
      const api = mockApi({
        'GET /cash/status': { data: status(false) },
        'GET /cash/current/summary': httpError(404, 'NO_OPEN_SESSION'),
        'POST /cash/open': { status: 201, data: session },
      });
      await renderScreen(<CashScreen />);
      await press('cash-open-btn');
      await press('open-cash-confirm');
      await press('zero-count-dialog-cancel');
      expect(api.of('POST', /\/cash\/open/)).toHaveLength(0);
    });

    it('non-zero open count sends without confirmation', async () => {
      const api = mockApi({
        'GET /cash/status': { data: status(false) },
        'GET /cash/current/summary': httpError(404, 'NO_OPEN_SESSION'),
        'POST /cash/open': { status: 201, data: session },
      });
      await renderScreen(<CashScreen />);
      await press('cash-open-btn');
      await fireEvent.changeText(await screen.findByTestId('open-count-B20'), '2');
      await press('open-cash-confirm');
      await waitFor(() => expect(api.of('POST', /\/cash\/open/)).toHaveLength(1));
      expect(screen.queryByText('¿Abrir con la caja vacía ($0)?')).toBeNull();
    });

    it('zero close count asks before going to the what-stays step', async () => {
      mockApi({
        'GET /cash/status': { data: status(true) },
        'GET /cash/current/summary': { data: { session, summary: summary() } },
      });
      await renderScreen(<CashScreen />);
      await press('cash-close-btn');
      await press('close-reminder-ok');
      await press('close-count-next');
      expect(await screen.findByText('¿Cerrar con $0 contado?')).toBeTruthy();
      expect(screen.queryByText('¿Qué se queda en caja?')).toBeNull();
      await press('zero-count-dialog-confirm');
      expect(await screen.findByText('¿Qué se queda en caja?')).toBeTruthy();
    });
  });

  it('flag off (status says count_by_denomination false) keeps the legacy bodies', async () => {
    const api = mockApi({
      'GET /cash/status': { data: { open: true, session, open_tickets_count: 0, ghost_tickets_count: 0, denominations: [], fund_target_cents: 200000, count_by_denomination: false } },
      'GET /cash/current/summary': { data: { session, summary: summary() } },
      'POST /cash/close': { data: { session, summary: summary() } },
    });
    await renderScreen(<CashScreen />);
    await press('cash-close-btn');
    expect(screen.getByTestId('close-expected')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('count-pad'), '910');
    await press('close-cash-confirm');
    await waitFor(() => expect(api.of('POST', /\/cash\/close/)).toHaveLength(1));
    expect(api.of('POST', /\/cash\/close/)[0].data).toEqual({ closing_cash_counted_cents: 91000, notes: null });
  });
});
