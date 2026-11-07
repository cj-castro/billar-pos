import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Ticket } from '../../../domain/types';
import { useAuthStore } from '../../../state/authStore';
import { httpError, mockApi, online, renderScreen } from '../../waiter/testing/testkit';
import { ManagerActions } from '../ManagerActions';

const base = { id: 't1', status: 'OPEN', payment_type: 'CASH', tendered_cents: 20000, tip_cents: 1000, timer_sessions: [], available_promotions: [], edited_after_close: false };
const tk = (over: Record<string, unknown> = {}) => ({ ...base, ...over }) as unknown as Ticket;
const as = (role: string) => useAuthStore.setState({ user: { id: 'u1', username: 'u', name: 'U', role } as never });
const press = async (id: string) => fireEvent.press(await screen.findByTestId(id));
const show = (t: Ticket, onGone = jest.fn()) => renderScreen(<ManagerActions ticket={t} offline={false} onGone={onGone} />);

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
});

describe('ManagerActions gating', () => {
  it('renders nothing for a waiter', async () => {
    as('WAITER');
    await show(tk());
    expect(screen.queryByTestId('manager-actions')).toBeNull();
  });

  it('OPEN ticket (manager): Cerrar forzado + Aplicar promocion + Reimprimir; no Reabrir / Editar pago', async () => {
    as('MANAGER');
    await show(tk());
    expect(screen.getByText('Acciones de gerente')).toBeTruthy();
    for (const id of ['mgr-force-close', 'mgr-promos', 'mgr-reprint']) expect(screen.getByTestId(id)).toBeTruthy();
    for (const id of ['mgr-reopen', 'mgr-edit-payment', 'mgr-void-timer', 'mgr-edit-timer']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('CLOSED ticket (admin): Reabrir + Editar pago; no Cerrar forzado', async () => {
    as('ADMIN');
    mockApi({ 'GET /tickets/t1/edit-history': { data: [] } });
    await show(tk({ status: 'CLOSED' }));
    expect(screen.getByTestId('mgr-reopen')).toBeTruthy();
    expect(screen.getByTestId('mgr-edit-payment')).toBeTruthy();
    expect(screen.queryByTestId('mgr-force-close')).toBeNull();
  });

  it('POOL ticket with a running timer adds Anular tiempo and Corregir tiempo', async () => {
    as('MANAGER');
    await show(tk({ timer_sessions: [{ id: 's1', status: 'ACTIVE', start_time: '2026-11-06T01:00:00Z', end_time: null }] }));
    expect(screen.getByTestId('mgr-void-timer')).toBeTruthy();
    expect(screen.getByTestId('mgr-edit-timer')).toBeTruthy();
  });
});

describe('ManagerActions flows', () => {
  it('force close needs a reason, then posts it and leaves the screen', async () => {
    as('MANAGER');
    const api = mockApi({ 'POST /tickets/t1/force-close': { data: {} } });
    const onGone = jest.fn();
    await show(tk(), onGone);
    await press('mgr-force-close');
    expect((await screen.findByTestId('force-close-sheet-confirm')).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('force-close-sheet-reason'), 'Cliente se fue');
    await press('force-close-sheet-confirm');
    await waitFor(() => expect(api.of('POST', /force-close/)).toHaveLength(1));
    expect(api.of('POST', /force-close/)[0].data).toEqual({ reason: 'Cliente se fue' });
    await waitFor(() => expect(onGone).toHaveBeenCalled());
  });

  it('reopen explains a closed cash session (409 CASH_SESSION_CLOSED)', async () => {
    as('MANAGER');
    mockApi({ 'GET /tickets/t1/edit-history': { data: [] }, 'POST /tickets/t1/reopen': httpError(409, 'CASH_SESSION_CLOSED') });
    await show(tk({ status: 'CLOSED' }));
    await press('mgr-reopen');
    await press('reopen-sheet-confirm'); // reason is optional
    expect(await screen.findByText('No se puede reabrir: la caja de ese turno ya está cerrada.')).toBeTruthy();
  });

  it('edit payment: prefilled sheet, reason required, then the PIN goes in the body', async () => {
    as('MANAGER');
    const api = mockApi({ 'GET /tickets/t1/edit-history': { data: [] }, 'POST /tickets/t1/edit-payment': { data: {} } });
    await show(tk({ status: 'CLOSED' }));
    await press('mgr-edit-payment');
    expect(screen.getByTestId('pay-edit-tendered').props.value).toBe('200.00');
    await press('pay-edit-type-CARD');
    await fireEvent.changeText(screen.getByTestId('pay-edit-reason'), 'Era tarjeta');
    await press('pay-edit-next');
    for (const k of '1234') await press(`pin-key-${k}`);
    await waitFor(() => expect(api.of('POST', /edit-payment/)).toHaveLength(1));
    expect(api.of('POST', /edit-payment/)[0].data).toEqual({ payment_type: 'CARD', pin: '1234', reason: 'Era tarjeta' });
  });

  it('wrong PIN keeps the pad open with an error', async () => {
    as('MANAGER');
    mockApi({ 'GET /tickets/t1/edit-history': { data: [] }, 'POST /tickets/t1/edit-payment': httpError(401, 'INVALID_PIN') });
    await show(tk({ status: 'CLOSED' }));
    await press('mgr-edit-payment');
    await press('pay-edit-type-CARD');
    await fireEvent.changeText(screen.getByTestId('pay-edit-reason'), 'x');
    await press('pay-edit-next');
    for (const k of '1234') await press(`pin-key-${k}`);
    expect(await screen.findByText('PIN incorrecto. Intenta de nuevo.')).toBeTruthy();
    expect(screen.getByTestId('pin-sheet')).toBeTruthy();
  });

  it('reprint sends the current user as manager_id', async () => {
    as('MANAGER');
    const api = mockApi({ 'POST /tickets/t1/reprint': { data: { ok: true } } });
    await show(tk());
    await press('mgr-reprint');
    await press('reprint-dialog-confirm');
    await waitFor(() => expect(api.of('POST', /reprint/)).toHaveLength(1));
    expect(api.of('POST', /reprint/)[0].data).toEqual({ manager_id: 'u1' });
  });

  it('void timer: confirm, then reports that the ticket became Rapido', async () => {
    as('MANAGER');
    const api = mockApi({ 'POST /tickets/t1/void-timer': { data: { ok: true, ticket_closed: false } } });
    await show(tk({ timer_sessions: [{ id: 's1', status: 'ACTIVE', start_time: '2026-11-06T01:00:00Z', end_time: null }] }));
    await press('mgr-void-timer');
    expect(api.of('POST', /void-timer/)).toHaveLength(0);
    await press('void-timer-dialog-confirm');
    expect(await screen.findByText('Tiempo anulado: el ticket pasó a Rápido')).toBeTruthy();
  });

  it('promotions: lists the offers and posts the decision', async () => {
    as('MANAGER');
    const api = mockApi({ 'POST /tickets/t1/promotions/p1': { data: {} } });
    await show(tk({ available_promotions: [{ promotion_id: 'p1', name: '2x1 Cervezas', promo_type: 'BOGO', discount_cents: 4500 }] }));
    await press('mgr-promos');
    expect(await screen.findByText('2x1 Cervezas')).toBeTruthy();
    await press('promo-accept-p1');
    await waitFor(() => expect(api.of('POST', /promotions\/p1/)).toHaveLength(1));
    expect(api.of('POST', /promotions\/p1/)[0].data).toEqual({ decision: 'ACCEPTED' });
  });

  it('correct timer: validates HH:MM before calling the API', async () => {
    as('MANAGER');
    const api = mockApi({ 'PATCH /tickets/t1/timer/s1': { data: {} } });
    await show(tk({ timer_sessions: [{ id: 's1', status: 'ACTIVE', start_time: '2026-11-06T01:00:00Z', end_time: null }] }));
    await press('mgr-edit-timer');
    expect(screen.getByTestId('timer-start').props.value).toBe('19:00');
    await fireEvent.changeText(screen.getByTestId('timer-start'), '99:99');
    await fireEvent.changeText(screen.getByTestId('timer-reason'), 'Se olvido iniciar');
    await press('timer-save');
    expect(api.of('PATCH', /timer/)).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('timer-start'), '18:30');
    await press('timer-save');
    await waitFor(() => expect(api.of('PATCH', /timer\/s1/)).toHaveLength(1));
    expect(api.of('PATCH', /timer\/s1/)[0].data).toMatchObject({ start_time: '2026-11-05T18:30:00', reason: 'Se olvido iniciar' });
  });
});
