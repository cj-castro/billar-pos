import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useDraftStore } from '../draft/draftStore';
import { MenuScreen } from '../menu/MenuScreen';
import { OpenTableScreen } from '../openTable/OpenTableScreen';
import { httpError, makeRouter, mockApi, menuItem, networkError, online, renderScreen, resource, setOnline, ticket } from '../testing/testkit';

const mockRouter = makeRouter();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  useDraftStore.setState({ byTicket: {} });
});

describe('OpenTableScreen', () => {
  const base = (over: Record<string, never | object> = {}, resources = [resource({ id: 'r1', code: 'T2' })], cashOpen = true) =>
    mockApi({
      'GET /resources': () => ({ data: resources }),
      'GET /cash/status': { data: { open: cashOpen, session: null, open_tickets_count: 0, ghost_tickets_count: 0 } },
      'POST /tickets': { status: 201, data: ticket({ id: 'new1' }) },
      ...over,
    });

  it('opens the table with the optional customer name and goes to the ticket', async () => {
    const m = base();
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    expect(await screen.findByText('Abrir T2')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('open-table-name'), '  Carlos ');
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/ticket/new1'));
    expect(m.of('POST', /^\/tickets$/)[0].data).toEqual({ resource_id: 'r1', ticket_type: 'TABLE', customer_name: 'Carlos' });
  });

  it('omits customer_name when empty and warns that pool time starts on open', async () => {
    const m = base({}, [resource({ id: 'r1', code: 'BT1', type: 'POOL_TABLE' })]);
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    expect(await screen.findByText('El tiempo de billar empieza al abrir la mesa.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    await waitFor(() => expect(m.of('POST', /^\/tickets$/)).toHaveLength(1));
    expect(m.of('POST', /^\/tickets$/)[0].data).toEqual({ resource_id: 'r1', ticket_type: 'TABLE' });
  });

  it('is double-tap safe: one POST', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const m = base({ 'POST /tickets': async () => (await gate, { status: 201, data: ticket({ id: 'new1' }) }) });
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    await screen.findByText('Abrir T2');
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    await waitFor(() => expect(screen.getByTestId('open-table-submit').props.accessibilityState.busy).toBe(true));
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    release();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledTimes(1));
    expect(m.of('POST', /^\/tickets$/)).toHaveLength(1);
  });

  it('403 BAR_CLOSED: explains, creates nothing, keeps the button disabled afterwards', async () => {
    base({ 'POST /tickets': httpError(403, 'BAR_CLOSED') as never });
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    await screen.findByText('Abrir T2');
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    expect(await screen.findByTestId('open-table-error')).toBeTruthy();
    expect(screen.getByTestId('open-table-error').props.children).toBe('La caja está cerrada. Pide a un gerente que abra turno.');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('open-table-submit').props.accessibilityState.disabled).toBe(true);
  });

  it('cash closed up front: button disabled with the reason', async () => {
    base({}, undefined, false);
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    await waitFor(() => expect(screen.getByTestId('open-table-helper')).toBeTruthy());
    expect(screen.getByTestId('open-table-submit').props.accessibilityState.disabled).toBe(true);
  });

  it('409 RESOURCE_OCCUPIED: refetches the floor and offers the existing ticket', async () => {
    let occupied = false;
    base({
      'GET /resources': () => ({ data: [resource({ id: 'r1', code: 'T2', status: occupied ? 'IN_USE' : 'AVAILABLE', active_ticket_id: occupied ? 'existing9' : null })] }),
      'POST /tickets': () => {
        occupied = true;
        return httpError(409, 'RESOURCE_OCCUPIED', 'T2 ya está en uso');
      },
    });
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    await screen.findByText('Abrir T2');
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    expect(await screen.findByText('Alguien más ya abrió esta mesa.')).toBeTruthy();
    await fireEvent.press(await screen.findByTestId('open-table-existing'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/ticket/existing9');
  });

  it('network loss: outcome unknown message, can retry', async () => {
    let fail = true;
    const m = base({ 'POST /tickets': () => (fail ? networkError() : { status: 201, data: ticket({ id: 'new1' }) }) });
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    await screen.findByText('Abrir T2');
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    expect(await screen.findByText('No pudimos confirmar si se abrió. Revisa e inténtalo de nuevo.')).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByTestId('open-table-submit'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/ticket/new1'));
    expect(m.of('POST', /^\/tickets$/)).toHaveLength(2);
  });

  it('offline: disabled with "Necesitas conexión"', async () => {
    base();
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    await screen.findByText('Abrir T2');
    await setOnline(false);
    await waitFor(() => expect(screen.getByTestId('open-table-submit').props.accessibilityState.disabled).toBe(true));
    expect(screen.getByText('Necesitas conexión para abrir la mesa.')).toBeTruthy();
  });

  it('close goes back', async () => {
    base();
    await renderScreen(<OpenTableScreen resourceId="r1" />);
    await fireEvent.press(await screen.findByTestId('open-table-close'));
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('MenuScreen', () => {
  const groups = [{ id: 'g1', name: 'Salsa', is_mandatory: true, min_selections: 1, max_selections: 1, allow_multiple: false, modifiers: [] }];
  const items = [
    menuItem({ id: 'beer', name: 'Cerveza Corona', price_cents: 4500, category_id: 'c1' }),
    menuItem({ id: 'wings', name: 'Alitas BBQ', price_cents: 14500, category_id: 'c2', routing: 'KITCHEN', modifier_groups: groups }),
    menuItem({ id: 'pina', name: 'Piña Colada', price_cents: 8500, category_id: 'c1' }),
    menuItem({ id: 'tacos', name: 'Tacos al pastor', price_cents: 9500, category_id: 'c2', routing: 'KITCHEN' }),
  ];
  const api = () =>
    mockApi({
      'GET /menu/categories': { data: [{ id: 'c1', name: 'Bebidas', routing: 'BAR', sort_order: 1 }, { id: 'c2', name: 'Comida', routing: 'KITCHEN', sort_order: 2 }] },
      'GET /menu/items': { data: items },
      'GET /inventory/stock-check': { data: { blocked_items: ['tacos'], blocked_modifiers: [], low_stock_item_ids: [], remaining_by_item: {}, low_stock_items: [] } },
      'GET /tickets/t1': { data: ticket({ customer_name: 'Carlos M.' }) },
    });

  it('shows category chips and the item grid; sold-out items are greyed out with "Agotado"', async () => {
    api();
    await renderScreen(<MenuScreen ticketId="t1" />);
    expect(await screen.findByTestId('menu-item-beer')).toBeTruthy();
    expect(screen.getByText('Agregar a T1')).toBeTruthy();
    expect(screen.getByText('Bebidas')).toBeTruthy();
    expect(screen.getByText('Comida')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('menu-item-tacos').props.accessibilityState.disabled).toBe(true));
    expect(screen.getByText('Agotado')).toBeTruthy();
    expect(screen.getByTestId('menu-item-beer').props.accessibilityState.disabled).toBe(false);
  });

  it('category chips filter the grid', async () => {
    api();
    await renderScreen(<MenuScreen ticketId="t1" />);
    await screen.findByTestId('menu-item-beer');
    await fireEvent.press(screen.getByTestId('chip-c2'));
    expect(screen.queryByTestId('menu-item-beer')).toBeNull();
    expect(screen.getByTestId('menu-item-wings')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('chip-all'));
    expect(screen.getByTestId('menu-item-beer')).toBeTruthy();
  });

  it('search ignores case and accents', async () => {
    api();
    await renderScreen(<MenuScreen ticketId="t1" />);
    await screen.findByTestId('menu-item-beer');
    await fireEvent.changeText(screen.getByTestId('menu-search'), 'PINA');
    expect(screen.getByTestId('menu-item-pina')).toBeTruthy();
    expect(screen.queryByTestId('menu-item-beer')).toBeNull();
  });

  it('empty search shows "No encontramos" and Limpiar búsqueda restores the list', async () => {
    api();
    await renderScreen(<MenuScreen ticketId="t1" />);
    await screen.findByTestId('menu-item-beer');
    await fireEvent.changeText(screen.getByTestId('menu-search'), 'zzz');
    expect(screen.getByText('No encontramos "zzz"')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('menu-empty-action'));
    expect(await screen.findByTestId('menu-item-beer')).toBeTruthy();
  });

  it('item with options opens the configurator; plain item quick-adds one to the draft; long press configures', async () => {
    api();
    await renderScreen(<MenuScreen ticketId="t1" />);
    await screen.findByTestId('menu-item-beer');
    await fireEvent.press(screen.getByTestId('menu-item-wings'));
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/t1/configure/wings');
    mockRouter.push.mockClear();

    await fireEvent.press(screen.getByTestId('menu-item-beer'));
    await fireEvent.press(screen.getByTestId('menu-item-beer'));
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(useDraftStore.getState().byTicket.t1).toHaveLength(1);
    expect(useDraftStore.getState().byTicket.t1[0]).toMatchObject({ menuItemId: 'beer', quantity: 2, unitPriceCents: 4500 });
    expect(screen.getByTestId('menu-item-beer').props.accessibilityLabel).toContain('2 en el pedido');

    await fireEvent(screen.getByTestId('menu-item-beer'), 'longPress');
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/t1/configure/beer');
  });

  it('"Revisar pedido (n)" appears once the draft has lines and opens the draft', async () => {
    api();
    await renderScreen(<MenuScreen ticketId="t1" />);
    await screen.findByTestId('menu-item-beer');
    expect(screen.queryByTestId('menu-review-order')).toBeNull();
    await fireEvent.press(screen.getByTestId('menu-item-beer'));
    await fireEvent.press(await screen.findByTestId('menu-review-order'));
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/t1/draft');
    expect(screen.getByTestId('menu-review-order').props.accessibilityLabel).toBe('Revisar pedido (1)');
  });

  it('offline: cached menu still usable, with the stock warning', async () => {
    api();
    await renderScreen(<MenuScreen ticketId="t1" />);
    await screen.findByTestId('menu-item-beer');
    await setOnline(false);
    expect(await screen.findByText('Sin conexión: el inventario podría estar desactualizado.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('menu-item-beer'));
    expect(useDraftStore.getState().byTicket.t1).toHaveLength(1);
    await act(async () => {});
  });

  it('menu load failure with no cache -> ErrorState', async () => {
    mockApi({ 'GET /menu/categories': httpError(500, 'X'), 'GET /menu/items': httpError(500, 'X'), 'GET /inventory/stock-check': { data: {} }, 'GET /tickets/t1': { data: ticket({}) } });
    await renderScreen(<MenuScreen ticketId="t1" />);
    expect(await screen.findByTestId('error-state', {}, { timeout: 4000 })).toBeTruthy();
  });
});
