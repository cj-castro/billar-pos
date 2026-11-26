import { act, fireEvent, screen, userEvent } from '@testing-library/react-native';
import { __resetClockSkew, recordServerDate, useClockOffset } from '../../api/clockSkew';
import { renderWithProviders } from '../../test/utils';
import { KdsTicketCard, type KdsTicket } from '../KdsTicketCard';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const ticket = (sentAt: string): KdsTicket => ({
  code: 'M4',
  oldestSentAt: sentAt,
  items: [
    { id: 'a', quantity: 1, name: 'Alitas', status: 'SENT' },
    { id: 'b', quantity: 2, name: 'Nachos', status: 'IN_PROGRESS' },
  ],
});

beforeEach(() => __resetClockSkew());

describe('M8: stale KDS disables every advance action', () => {
  it('disabled: item rows, "Todo listo" and "Entregado" do nothing', async () => {
    const onAdvance = jest.fn();
    const onAll = jest.fn();
    await renderWithProviders(<KdsTicketCard ticket={ticket('2026-01-01T11:58:00Z')} now={NOW} disabled onAdvanceItem={onAdvance} onAllReady={onAll} testID="card" />);
    const user = userEvent.setup();
    await user.press(screen.getByTestId('kds-item-a'));
    await user.press(screen.getByTestId('kds-all-ready-M4'));
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onAll).not.toHaveBeenCalled();
    expect(screen.getByTestId('kds-item-a').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('kds-all-ready-M4').props.accessibilityState.disabled).toBe(true);
  });

  it('enabled: the same taps go through', async () => {
    const onAdvance = jest.fn();
    await renderWithProviders(<KdsTicketCard ticket={ticket('2026-01-01T11:58:00Z')} now={NOW} onAdvanceItem={onAdvance} onAllReady={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('kds-item-a'));
    expect(onAdvance).toHaveBeenCalledWith('a');
  });
});

describe('M6: server clock-skew correction', () => {
  it('median of the Date header offsets', () => {
    const t = Date.parse('2026-01-01T12:00:00Z');
    recordServerDate(new Date(t - 180_000).toUTCString(), t); // server 3 min behind the device
    recordServerDate(new Date(t - 180_000).toUTCString(), t);
    recordServerDate(new Date(t + 500_000).toUTCString(), t); // outlier
    expect(useClockOffset.getState().offsetMs).toBe(-180_000);
    recordServerDate(undefined);
    recordServerDate('nonsense');
    expect(useClockOffset.getState().offsetMs).toBe(-180_000);
  });

  it('a device clock 3 min fast does not turn the age badge alert early', async () => {
    // device says 12:00:00, server says 11:57:00; item sent 11:56:00 on the server => 1:00 old, not 4:00
    await act(async () => recordServerDate(new Date(NOW - 180_000).toUTCString(), NOW));
    await renderWithProviders(<KdsTicketCard ticket={ticket('2026-01-01T11:56:00Z')} now={NOW} onAdvanceItem={jest.fn()} onAllReady={jest.fn()} />);
    expect(screen.getByTestId('kds-age-text').props.children).toBe('1:00');
  });
});
