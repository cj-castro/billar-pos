import { FAVORITES_DAYS, rankFavorites, useFavorites } from '../menu/favoritesStore';

const DAY = 86_400_000;
const NOW = Date.parse('2026-02-01T12:00:00Z');

describe('rankFavorites', () => {
  it('orders by count, ties by most recent, max 8', () => {
    const e = [
      { id: 'a', at: NOW - 3 * DAY },
      { id: 'b', at: NOW - 1 * DAY },
      { id: 'b', at: NOW - 2 * DAY },
      { id: 'c', at: NOW - 1 * DAY }, // ties with a at one sent line: c is more recent
    ];
    expect(rankFavorites(e, NOW)).toEqual(['b', 'c', 'a']);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, at: NOW - i * 1000 }));
    expect(rankFavorites(many, NOW)).toHaveLength(8);
  });
  it('ignores lines older than 30 days', () => {
    expect(rankFavorites([{ id: 'old', at: NOW - (FAVORITES_DAYS + 1) * DAY }, { id: 'new', at: NOW - DAY }], NOW)).toEqual(['new']);
  });
});

describe('useFavorites', () => {
  beforeEach(() => useFavorites.setState({ byUser: {} }));
  it('records per user and prunes stale entries on write', () => {
    const { record } = useFavorites.getState();
    record('u1', 'old', NOW - 40 * DAY);
    record('u1', 'x', NOW);
    record('u2', 'y', NOW);
    const s = useFavorites.getState().byUser;
    expect(s.u1.map((e) => e.id)).toEqual(['x']);
    expect(s.u2.map((e) => e.id)).toEqual(['y']);
  });
});
