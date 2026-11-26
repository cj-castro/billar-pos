import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as cash from '../../../../api/endpoints/cash';
import * as earnings from '../../../../api/endpoints/earnings';
import * as reports from '../../../../api/endpoints/reports';
import * as safe from '../../../../api/endpoints/safe';
import { useAuthStore } from '../../../../state/authStore';
import { mockServerConfig, renderWithProviders } from '../../../../test/utils';
import { ReportsScreen } from '../ReportsScreen';

jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return { Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text> };
});
jest.mock('../../../../api/endpoints/cash');
jest.mock('../../../../api/endpoints/reports');
jest.mock('../../../../api/endpoints/earnings');
jest.mock('../../../../api/endpoints/safe');
jest.mock('../../../../utils/haptics', () => ({
  haptic: { selection: jest.fn(), light: jest.fn(), medium: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const m = (f: unknown) => f as jest.Mock;
const net = async () => within(await screen.findByTestId('tile-total')).findByText('$395.00');

beforeEach(() => {
  jest.clearAllMocks();
  mockServerConfig();
  useAuthStore.setState({ user: { id: 'a', username: 'admin', name: 'Admin', role: 'ADMIN' } });
  m(reports.getSales).mockResolvedValue([
    { item_id: '1', item_name: 'Corona', category: 'Cervezas', routing: 'BAR', units_sold: 3, gross_cents: 10000, discounts_cents: 500 },
    { item_id: '2', item_name: 'Alitas', category: 'Comida', routing: 'KITCHEN', units_sold: 1, gross_cents: 30000, discounts_cents: 0 },
  ]);
  m(reports.getPayments).mockResolvedValue([{ payment_type: 'CASH', ticket_count: 4, total_cents: 39500, tips_cents: 2000, split_count: 0, unique_tickets: 4, split_tickets: 0 }]);
  m(reports.getStaff).mockResolvedValue([]);
  m(reports.getPoolTime).mockResolvedValue([{ table_code: 'P1', sessions: 2, total_seconds: 7200, revenue_cents: 20000 }]);
  m(reports.getPeakHours).mockResolvedValue([{ hour: 21, ticket_count: 5, revenue_cents: 9000, tips_cents: 0, avg_ticket_cents: 1800 }]);
  m(reports.getVoids).mockResolvedValue([
    { ticket_id: 't1', table_code: 'T3', item_name: 'Corona', category: null, quantity: 2, unit_price_cents: 3000, reason: 'Error', voided_at: null, voided_by: 'Ana', ticket_opened_by: 'Ana' },
  ]);
  m(reports.getPromotions).mockResolvedValue([]);
  m(cash.listCashSessions).mockResolvedValue([]);
  m(earnings.getEarnings).mockResolvedValue({ ingresos_cents: 40000, cogs_cents: 10000, ganancia_cents: 30000, margen_pct: 75 });
  m(earnings.getEarningsByCategory).mockResolvedValue({ rows: [] });
  m(safe.listSafe).mockResolvedValue([]);
  m(safe.createSafe).mockResolvedValue({});
});
afterEach(() => useAuthStore.setState({ user: null }));

describe('ReportsScreen', () => {
  it('renders aggregated cards for ADMIN and queries with the Mexico "today" range', async () => {
    await renderWithProviders(<ReportsScreen />);
    expect(await net()).toBeTruthy(); // net sales 10000-500+30000
    expect(screen.getByTestId('tile-tickets')).toBeTruthy();
    expect(await screen.findByTestId('tile-voids-total')).toBeTruthy();
    expect(within(screen.getByTestId('tile-voids-total')).getByText('$60.00')).toBeTruthy();
    expect(await screen.findByTestId('bar-Comida')).toBeTruthy();
    expect(screen.getByTestId('card-earnings')).toBeTruthy();
    expect(screen.getByTestId('card-safe')).toBeTruthy();
    const arg = m(reports.getSales).mock.calls[0][0] as { from: string; to: string };
    expect(arg.from).toBe(arg.to);
    expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('MANAGER does not get earnings / safe cards', async () => {
    useAuthStore.setState({ user: { id: 'm', username: 'm', name: 'M', role: 'MANAGER' } });
    await renderWithProviders(<ReportsScreen />);
    await net();
    expect(screen.queryByTestId('card-earnings')).toBeNull();
    expect(screen.queryByTestId('card-safe')).toBeNull();
    expect(earnings.getEarnings).not.toHaveBeenCalled();
  });

  it('WAITER is sent to /denied', async () => {
    useAuthStore.setState({ user: { id: 'w', username: 'w', name: 'W', role: 'WAITER' } });
    await renderWithProviders(<ReportsScreen />);
    expect(screen.getByTestId('redirect').props.children).toBe('/denied');
    expect(reports.getSales).not.toHaveBeenCalled();
  });

  it('changing the preset refetches with a new range', async () => {
    await renderWithProviders(<ReportsScreen />);
    await net();
    await fireEvent.press(screen.getByTestId('preset-month'));
    await waitFor(() => expect(m(reports.getSales).mock.calls.length).toBeGreaterThan(1));
    const last = m(reports.getSales).mock.calls.at(-1)![0] as { from: string };
    expect(last.from.endsWith('-01')).toBe(true);
  });

  it('safe withdrawal posts amount in cents + notes', async () => {
    await renderWithProviders(<ReportsScreen />);
    await fireEvent.press(await screen.findByTestId('safe-add'));
    await fireEvent.press(screen.getByTestId('safe-pad-5'));
    await fireEvent.press(screen.getByTestId('safe-pad-00'));
    await fireEvent.changeText(screen.getByTestId('safe-notes'), 'Retiro turno');
    await fireEvent.press(screen.getByTestId('safe-save'));
    await waitFor(() => expect(safe.createSafe).toHaveBeenCalledWith({ amount_cents: 50000, notes: 'Retiro turno' }));
  });
});
