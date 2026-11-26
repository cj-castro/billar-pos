import { lastRoundLines } from '../ticket/ticketRules';
import { line, ticket } from '../testing/testkit';

describe('lastRoundLines', () => {
  it('copies only the newest sent batch, skipping voided lines', () => {
    const t = ticket({
      line_items: [
        line({ id: 'a', menu_item_id: 'm1', sent_at: '2026-01-01T10:00:00+00:00' }),
        line({ id: 'b', menu_item_id: 'm2', quantity: 2, notes: 'sin hielo', sent_at: '2026-01-01T10:30:00+00:00', modifiers: [{ id: 'x', modifier_id: 'mod1', name: 'Limón', price_cents: 500 }] }),
        line({ id: 'c', menu_item_id: 'm3', sent_at: '2026-01-01T10:30:02+00:00' }),
        line({ id: 'd', menu_item_id: 'm4', status: 'VOIDED', sent_at: '2026-01-01T10:30:03+00:00' }),
      ],
    });
    const out = lastRoundLines(t);
    expect(out.map((l) => l.menuItemId)).toEqual(['m2', 'm3']);
    expect(out[0]).toMatchObject({ quantity: 2, notes: 'sin hielo', modifiers: [{ id: 'mod1', name: 'Limón', priceCents: 500 }] });
  });
  it('empty when nothing was sent', () => {
    expect(lastRoundLines(ticket({ line_items: [line({ sent_at: null })] }))).toEqual([]);
    expect(lastRoundLines(ticket({ line_items: [] }))).toEqual([]);
  });
});
