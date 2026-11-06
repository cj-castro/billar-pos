import AsyncStorage from '@react-native-async-storage/async-storage';
import { draftSubtotalCents, useDraftStore, type NewDraftLine } from '../draft/draftStore';

const line = (over: Partial<NewDraftLine> = {}): NewDraftLine => ({
  menuItemId: 'm1',
  name: 'Alitas',
  unitPriceCents: 14500,
  quantity: 1,
  modifiers: [{ id: 'mod1', name: 'BBQ', priceCents: 0 }],
  notes: '',
  ...over,
});

beforeEach(async () => {
  await AsyncStorage.clear();
  useDraftStore.setState({ byTicket: {} });
});

describe('draft store', () => {
  it('gives every line its own stable UUID key', () => {
    const a = useDraftStore.getState().addLine('t1', line());
    const b = useDraftStore.getState().addLine('t1', line({ menuItemId: 'm2', name: 'Nachos' }));
    expect(a.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.key).not.toBe(b.key);
    // editing / patching never changes the key (it is the Idempotency-Key)
    useDraftStore.getState().setQuantity('t1', a.key, 5);
    useDraftStore.getState().patchLine('t1', a.key, { state: 'FAILED', error: 'NETWORK', key: 'hacked' } as never);
    const stored = useDraftStore.getState().byTicket.t1.find((l) => l.name === 'Alitas')!;
    expect(stored.key).toBe(a.key);
    expect(stored.quantity).toBe(5);
  });

  it('merges an identical pending line (same item, options, note) instead of duplicating', () => {
    const a = useDraftStore.getState().addLine('t1', line());
    const b = useDraftStore.getState().addLine('t1', line({ quantity: 2 }));
    expect(b.key).toBe(a.key);
    expect(useDraftStore.getState().byTicket.t1).toHaveLength(1);
    expect(useDraftStore.getState().byTicket.t1[0].quantity).toBe(3);
    // different note -> separate line
    useDraftStore.getState().addLine('t1', line({ notes: 'sin picante' }));
    expect(useDraftStore.getState().byTicket.t1).toHaveLength(2);
  });

  it('does not merge into a line that already failed (its key may be on the server)', () => {
    const a = useDraftStore.getState().addLine('t1', line());
    useDraftStore.getState().patchLine('t1', a.key, { state: 'FAILED', error: 'NETWORK' });
    const b = useDraftStore.getState().addLine('t1', line());
    expect(b.key).not.toBe(a.key);
  });

  it('clamps quantity to 1..99', () => {
    const a = useDraftStore.getState().addLine('t1', line({ quantity: 500 }));
    expect(a.quantity).toBe(99);
    useDraftStore.getState().setQuantity('t1', a.key, 0);
    expect(useDraftStore.getState().byTicket.t1[0].quantity).toBe(1);
  });

  it('keeps drafts per ticket and drops empty tickets', () => {
    const a = useDraftStore.getState().addLine('t1', line());
    useDraftStore.getState().addLine('t2', line());
    useDraftStore.getState().removeLine('t1', a.key);
    expect(useDraftStore.getState().byTicket.t1).toBeUndefined();
    expect(useDraftStore.getState().byTicket.t2).toHaveLength(1);
    useDraftStore.getState().clearTicket('t2');
    expect(useDraftStore.getState().byTicket).toEqual({});
  });

  it('persists to AsyncStorage and restores with the SAME keys after a restart', async () => {
    const a = useDraftStore.getState().addLine('t1', line());
    const raw = await AsyncStorage.getItem('bola8.waiter.drafts');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.byTicket.t1[0].key).toBe(a.key);

    // simulate a cold start: in-memory state gone, storage as it was left
    useDraftStore.setState({ byTicket: {} });
    await AsyncStorage.setItem('bola8.waiter.drafts', raw!);
    await useDraftStore.persist.rehydrate();
    const restored = useDraftStore.getState().byTicket.t1;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ key: a.key, name: 'Alitas', state: 'PENDING' });
  });

  it('a line caught mid-send by an app kill comes back as "not sent", key intact (never "sending")', async () => {
    const a = useDraftStore.getState().addLine('t1', line());
    useDraftStore.getState().patchLine('t1', a.key, { state: 'SENDING' });
    const raw = await AsyncStorage.getItem('bola8.waiter.drafts');
    expect(JSON.parse(raw!).state.byTicket.t1[0].state).toBe('SENDING'); // persisted as it was
    useDraftStore.setState({ byTicket: {} });
    await AsyncStorage.setItem('bola8.waiter.drafts', raw!);
    await useDraftStore.persist.rehydrate();
    expect(useDraftStore.getState().byTicket.t1[0]).toMatchObject({ key: a.key, state: 'FAILED', error: 'NETWORK' });
  });

  it('estimates subtotal with modifier prices (display only)', () => {
    useDraftStore.getState().addLine('t1', line({ quantity: 2, modifiers: [{ id: 'x', name: 'Extra', priceCents: 1000 }] }));
    expect(draftSubtotalCents(useDraftStore.getState().byTicket.t1)).toBe((14500 + 1000) * 2);
  });
});
