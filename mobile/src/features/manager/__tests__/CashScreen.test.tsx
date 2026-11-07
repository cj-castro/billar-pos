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
});
