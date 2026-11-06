import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { mockServerConfig } from '../../../test/utils';
import { useSendDraft } from '../draft/useSendDraft';
import { selectLines, useDraftStore } from '../draft/draftStore';
import { DraftScreen } from '../draft/DraftScreen';
import { httpError, line, type Call, makeRouter, mockApi, networkError, online, renderScreen, setOnline, testQueryClient, ticket } from '../testing/testkit';

const mockRouter = makeRouter();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const add = (name: string, over: object = {}) =>
  useDraftStore.getState().addLine('t1', { menuItemId: `id-${name}`, name, unitPriceCents: 10000, quantity: 1, modifiers: [], notes: '', ...over });
const lines = () => useDraftStore.getState().byTicket.t1 ?? [];

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  useDraftStore.setState({ byTicket: {}, b1Confirmed: {}, ownerId: null });
});

/** Backend with B1: every add returns the bumped ticket_version. */
function b1Api(overrides: Record<string, never | object> = {}) {
  let version = 3;
  const m = mockApi({
    'GET /tickets/t1': () => ({ data: ticket({ version }) }),
    'POST /tickets/t1/items': (c) => {
      version += 1;
      return { status: 201, data: { ...line({ id: `srv-${version}` }), ticket_version: version, client_request_id: c.headers['Idempotency-Key'] } };
    },
    ...overrides,
  });
  return m;
}
const posts = (m: ReturnType<typeof mockApi>) => m.of('POST', /\/tickets\/t1\/items$/);
const chipOf = (key: string) => screen.getByTestId(`draft-line-${key}-chip`).props.accessibilityLabel as string;

describe('DraftScreen', () => {
  it('shows pending lines, estimated subtotal and "Enviar (n)"', async () => {
    b1Api();
    add('Alitas', { quantity: 2, modifiers: [{ id: 'x', name: 'BBQ', priceCents: 500 }], notes: 'sin picante' });
    add('Nachos');
    await renderScreen(<DraftScreen ticketId="t1" />);
    expect(screen.getByText('2× Alitas')).toBeTruthy();
    expect(screen.getByText('BBQ')).toBeTruthy();
    expect(screen.getByText('sin picante')).toBeTruthy();
    expect(screen.getAllByText('Por enviar').length).toBeGreaterThan(0);
    expect(screen.getByTestId('draft-subtotal').props.children).toBe('$310.00'); // (100+5)*2 + 100
    expect(screen.getByText('Es una estimación. El servidor confirma precios y promociones.')).toBeTruthy();
    expect(screen.getByTestId('draft-send').props.accessibilityLabel).toBe('Enviar (2)');
  });

  it('empty draft shows the empty state', async () => {
    b1Api();
    await renderScreen(<DraftScreen ticketId="t1" />);
    expect(screen.getByTestId('draft-empty')).toBeTruthy();
    expect(screen.getByText('Tu pedido está vacío')).toBeTruthy();
  });

  it('Send posts each line once with its own Idempotency-Key and the chained X-Ticket-Version, clears the draft, returns to the ticket', async () => {
    const m = b1Api();
    const a = add('Alitas');
    const b = add('Nachos', { quantity: 3 });
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(posts(m)).toHaveLength(2));
    expect(posts(m).map((c) => c.headers['Idempotency-Key'])).toEqual([a.key, b.key]);
    expect(posts(m).map((c) => c.headers['X-Ticket-Version'])).toEqual(['3', '4']); // chained from ticket_version of each response
    expect(posts(m)[1].data).toEqual({ menu_item_id: 'id-Nachos', quantity: 3 });
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(await screen.findByText('Pedido enviado a cocina y barra')).toBeTruthy();
    await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith('/ticket/t1'), { timeout: 3000 });
  });

  it('shows the "Enviado" flash for confirmed lines while the draft is already empty in storage', async () => {
    b1Api();
    add('Alitas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(screen.getAllByText('Enviado').length).toBeGreaterThan(0);
  });

  it('is double-tap safe: a second press while sending is ignored (one POST per line)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const m = b1Api({
      'POST /tickets/t1/items': async () => {
        await gate;
        return { status: 201, data: { ...line({}), ticket_version: 4 } };
      },
    });
    add('Alitas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(screen.getByTestId('draft-send').props.accessibilityState.busy).toBe(true));
    await fireEvent.press(screen.getByTestId('draft-send')); // ignored: button is busy
    release();
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(posts(m)).toHaveLength(1);
  });

  it('hook guard: two send() calls in the same tick still post each line once', async () => {
    const m = b1Api();
    add('Alitas');
    const qc = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    mockServerConfig();
    const { result } = await renderHook(() => useSendDraft('t1'), { wrapper });
    await act(async () => {
      result.current.send();
      result.current.send();
    });
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(posts(m)).toHaveLength(1);
  });

  it('network failure on line 2: line 1 sent, line 2 "No se envió" with banner; Reintentar resends ONLY line 2 with the SAME key', async () => {
    let failB = true;
    let version = 3;
    const m = mockApi({
      'GET /tickets/t1': () => ({ data: ticket({ version }) }),
      'POST /tickets/t1/items': (c) => {
        if (c.data && (c.data as { menu_item_id: string }).menu_item_id === 'id-Nachos' && failB) return networkError();
        version += 1;
        return { status: 201, data: { ...line({}), ticket_version: version } };
      },
    });
    const a = add('Alitas');
    const b = add('Nachos');
    const c = add('Papas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));

    await waitFor(() => expect(chipOf(b.key)).toBe('No se envió'));
    expect(lines().map((l) => l.key)).toEqual([b.key, c.key]); // a confirmed and gone
    expect(screen.getByTestId('draft-failed-banner')).toBeTruthy();
    expect(screen.getByText('1 producto no se envió. Revisa la conexión y reintenta.')).toBeTruthy();
    expect(posts(m).map((p) => p.headers['Idempotency-Key'])).toEqual([a.key, b.key]); // c untouched
    expect(screen.getByTestId('draft-send').props.accessibilityLabel).toBe('Reintentar (2)');

    failB = false;
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(lines()).toHaveLength(0));
    const keys = posts(m).map((p) => p.headers['Idempotency-Key']);
    expect(keys).toEqual([a.key, b.key, b.key, c.key]); // b retried with the identical key; a never again
    expect(keys.filter((k) => k === a.key)).toHaveLength(1);
  });

  it('per-line "Reintentar" resends just that line with its key', async () => {
    let fail = true;
    const m = b1Api({ 'POST /tickets/t1/items': () => (fail ? networkError() : { status: 201, data: { ...line({}), ticket_version: 9 } }) });
    const a = add('Alitas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(chipOf(a.key)).toBe('No se envió'));
    fail = false;
    await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-retry`));
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(posts(m).map((p) => p.headers['Idempotency-Key'])).toEqual([a.key, a.key]);
  });

  it('422 OUT_OF_STOCK marks only that line ("Agotado"); the others are still sent', async () => {
    const m = b1Api({
      'POST /tickets/t1/items': (c: Call) =>
        (c.data as { menu_item_id: string }).menu_item_id === 'id-Tacos'
          ? httpError(422, 'OUT_OF_STOCK', 'Insufficient stock')
          : { status: 201, data: { ...line({}), ticket_version: 8 } },
    });
    add('Alitas');
    const tacos = add('Tacos');
    add('Papas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toMatchObject({ key: tacos.key, state: 'FAILED', error: 'OUT_OF_STOCK' });
    expect(screen.getByTestId(`draft-line-${tacos.key}-error`).props.children).toBe('Agotado');
    expect(screen.queryByText(/Insufficient/)).toBeNull(); // no server English leaks
    expect(posts(m)).toHaveLength(3);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('422 FLAVOR_REQUIRED flags the line "Falta elegir sabor"', async () => {
    b1Api({ 'POST /tickets/t1/items': httpError(422, 'FLAVOR_REQUIRED') as never });
    const a = add('Alitas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(screen.getByTestId(`draft-line-${a.key}-error`).props.children).toBe('Falta elegir sabor'));
  });

  it('403 TICKET_CLOSED stops, explains, and keeps the whole draft', async () => {
    const m = b1Api({ 'POST /tickets/t1/items': httpError(403, 'TICKET_CLOSED') as never });
    add('Alitas');
    add('Nachos');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    expect(await screen.findByTestId('draft-closed-banner')).toBeTruthy();
    expect(screen.getByText('Esta cuenta ya no está abierta. Tu pedido sigue aquí.')).toBeTruthy();
    expect(lines()).toHaveLength(2);
    expect(lines().every((l) => l.state === 'PENDING')).toBe(true);
    expect(posts(m)).toHaveLength(1);
  });

  it('409 VERSION_CONFLICT with B1 known: silently refetches and retries once with the same key', async () => {
    let version = 3;
    let conflictOnce = true;
    const m = mockApi({
      'GET /tickets/t1': () => ({ data: ticket({ version }) }),
      'POST /tickets/t1/items': (c) => {
        // the first line succeeds (so B1 is detected); the second hits one conflict
        if ((c.data as { menu_item_id: string }).menu_item_id === 'id-Nachos' && conflictOnce) {
          conflictOnce = false;
          version = 10;
          return httpError(409, 'VERSION_CONFLICT');
        }
        version += 1;
        return { status: 201, data: { ...line({}), ticket_version: version } };
      },
    });
    add('Alitas');
    const b = add('Nachos');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(lines()).toHaveLength(0));
    const nachos = posts(m).filter((p) => p.headers['Idempotency-Key'] === b.key);
    expect(nachos).toHaveLength(2);
    expect(nachos[1].headers['X-Ticket-Version']).toBe('10');
  });

  it('offline: Send is disabled with the explanation and the draft stays editable', async () => {
    b1Api();
    online(false);
    const a = add('Alitas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    expect(screen.getByTestId('draft-send').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Sin conexión. Tu pedido se guarda aquí; envíalo cuando vuelva.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-qty-inc`));
    expect(lines()[0].quantity).toBe(2);
    await setOnline(true);
    await waitFor(() => expect(screen.getByTestId('draft-send').props.accessibilityState.disabled).toBe(false));
  });

  it('quantity stepper and remove edit the draft; removing the last line shows the empty state', async () => {
    b1Api();
    const a = add('Alitas');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-qty-inc`));
    await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-qty-inc`));
    expect(lines()[0].quantity).toBe(3);
    await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-remove`));
    expect(lines()).toHaveLength(0);
    expect(await screen.findByTestId('draft-empty')).toBeTruthy();
  });

  it('"Descartar pedido" asks first, then clears', async () => {
    b1Api();
    add('Alitas');
    add('Nachos');
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-discard'));
    expect(screen.getByText('¿Descartar 2 productos sin enviar?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('discard-dialog-cancel'));
    expect(lines()).toHaveLength(2);
    await fireEvent.press(screen.getByTestId('draft-discard'));
    await fireEvent.press(screen.getByTestId('discard-dialog-confirm'));
    expect(lines()).toHaveLength(0);
  });

  it('draft for another ticket is untouched (per-ticket drafts)', async () => {
    b1Api();
    add('Alitas');
    useDraftStore.getState().addLine('other', { menuItemId: 'x', name: 'Otro', unitPriceCents: 1, quantity: 1, modifiers: [], notes: '' });
    await renderScreen(<DraftScreen ticketId="t1" />);
    await fireEvent.press(screen.getByTestId('draft-send'));
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(selectLines('other')(useDraftStore.getState())).toHaveLength(1);
    await act(async () => {});
  });


  describe('H2: uncertain lines are locked', () => {
    const lose = () => b1Api({ 'POST /tickets/t1/items': () => networkError() });

    it('after a timeout the line has no stepper; only Reintentar and a confirmed Descartar', async () => {
      lose();
      const a = add('Alitas');
      await renderScreen(<DraftScreen ticketId="t1" />);
      expect(screen.getByTestId(`draft-line-${a.key}-qty`)).toBeTruthy(); // never attempted: editable
      await fireEvent.press(screen.getByTestId('draft-send'));
      await waitFor(() => expect(chipOf(a.key)).toBe('No se envió'));

      expect(screen.queryByTestId(`draft-line-${a.key}-qty`)).toBeNull(); // locked
      expect(screen.getByTestId(`draft-line-${a.key}-retry`)).toBeTruthy();
      // the store also refuses a quantity change (defence in depth)
      useDraftStore.getState().setQuantity('t1', a.key, 5);
      expect(lines()[0].quantity).toBe(1);

      await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-remove`));
      expect(lines()).toHaveLength(1); // asked first, nothing removed yet
      expect(screen.getByText('¿Descartar Alitas?')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('drop-dialog-cancel'));
      expect(lines()).toHaveLength(1);
      await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-remove`));
      await fireEvent.press(screen.getByTestId('drop-dialog-confirm'));
      expect(lines()).toHaveLength(0);
    });

    it('a never-attempted line can still be edited and removed without a prompt', async () => {
      b1Api();
      const a = add('Alitas');
      await renderScreen(<DraftScreen ticketId="t1" />);
      await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-qty-inc`));
      expect(lines()[0].quantity).toBe(2);
      await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-remove`));
      expect(lines()).toHaveLength(0);
    });

    it('a definitive rejection (OUT_OF_STOCK) leaves the line editable again', async () => {
      b1Api({ 'POST /tickets/t1/items': httpError(422, 'OUT_OF_STOCK') as never });
      const a = add('Tacos');
      await renderScreen(<DraftScreen ticketId="t1" />);
      await fireEvent.press(screen.getByTestId('draft-send'));
      await waitFor(() => expect(lines()[0]?.error).toBe('OUT_OF_STOCK'));
      expect(lines()[0].firstAttemptVersion).toBeUndefined();
      expect(screen.getByTestId(`draft-line-${a.key}-qty`)).toBeTruthy();
    });
  });

  describe('H1 end to end without B1', () => {
    it('timeout (request landed) then Reintentar: same key AND same X-Ticket-Version, 409 -> verify, exactly one add', async () => {
      let version = 3;
      let adds = 0;
      let lose = true;
      const m = mockApi({
        'GET /tickets/t1': () => ({ data: ticket({ version }) }),
        'POST /tickets/t1/items': (c) => {
          if (Number(c.headers['X-Ticket-Version']) !== version) return httpError(409, 'VERSION_CONFLICT');
          adds += 1;
          version += 1;
          if (lose) {
            lose = false;
            return networkError(); // landed, answer lost
          }
          return { status: 201, data: line({}) }; // no ticket_version: B1 absent
        },
      });
      const a = add('Alitas');
      await renderScreen(<DraftScreen ticketId="t1" />);
      await fireEvent.press(screen.getByTestId('draft-send'));
      await waitFor(() => expect(chipOf(a.key)).toBe('No se envió'));
      await fireEvent.press(screen.getByTestId(`draft-line-${a.key}-retry`));
      await waitFor(() => expect(lines()[0]?.error).toBe('VERIFY'));
      await waitFor(() => expect(screen.getByTestId('draft-verify-banner')).toBeTruthy(), { timeout: 4000 });
      expect(adds).toBe(1);
      const p = posts(m);
      expect(p.map((x) => x.headers['Idempotency-Key'])).toEqual([a.key, a.key]);
      expect(p.map((x) => x.headers['X-Ticket-Version'])).toEqual(['3', '3']);
      expect(lines()[0]).toMatchObject({ state: 'FAILED', error: 'VERIFY' });
      // no automatic resend from the global button, and no per-line Reintentar without B1
      expect(screen.queryByTestId(`draft-line-${a.key}-retry`)).toBeNull();
      expect(screen.getByTestId('draft-send').props.accessibilityState.disabled).toBe(true);
    });
  });
});
