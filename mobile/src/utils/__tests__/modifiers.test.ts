import { effectiveBounds, toggleModifier, validateModifierSelection, type ModifierRule } from '../modifiers';

const single = (isMandatory: boolean): ModifierRule => ({ isMandatory, min: 1, max: 1, allowMultiple: false });
const multi = (min: number, max: number, isMandatory = true): ModifierRule => ({ isMandatory, min, max, allowMultiple: true });

describe('validateModifierSelection', () => {
  it('single mandatory: needs exactly one', () => {
    expect(validateModifierSelection(single(true), 0)).toMatchObject({ valid: false, error: 'min', required: true, canAddMore: true });
    expect(validateModifierSelection(single(true), 1)).toMatchObject({ valid: true, error: null, canAddMore: false });
    expect(validateModifierSelection(single(true), 2)).toMatchObject({ valid: false, error: 'max' });
  });
  it('single optional: 0 or 1', () => {
    expect(validateModifierSelection(single(false), 0)).toMatchObject({ valid: true, required: false, min: 0 });
    expect(validateModifierSelection(single(false), 1).valid).toBe(true);
  });
  it('single ignores min/max numbers from the server', () => {
    expect(effectiveBounds({ isMandatory: true, min: 3, max: 5, allowMultiple: false })).toEqual({ min: 1, max: 1 });
  });
  it('multi: between min and max inclusive', () => {
    const r = multi(2, 3);
    expect(validateModifierSelection(r, 1)).toMatchObject({ valid: false, error: 'min' });
    expect(validateModifierSelection(r, 2)).toMatchObject({ valid: true, canAddMore: true });
    expect(validateModifierSelection(r, 3)).toMatchObject({ valid: true, canAddMore: false });
    expect(validateModifierSelection(r, 4)).toMatchObject({ valid: false, error: 'max' });
  });
  it('multi with min 0 is optional even if flagged mandatory (web parity)', () => {
    expect(validateModifierSelection(multi(0, 2, true), 0)).toMatchObject({ valid: true, required: false });
  });
  it('multi with max <= 0 is unlimited; max below min is lifted to min', () => {
    expect(validateModifierSelection(multi(1, 0), 50)).toMatchObject({ valid: true, canAddMore: true, max: Infinity });
    expect(effectiveBounds(multi(3, 1))).toEqual({ min: 3, max: 3 });
  });
  it('negative counts are clamped', () => {
    expect(validateModifierSelection(multi(1, 2), -3).count).toBe(0);
  });
});

describe('toggleModifier', () => {
  it('single: replaces the choice', () => {
    expect(toggleModifier(single(true), ['a'], 'b')).toEqual(['b']);
  });
  it('single mandatory: re-tapping keeps the selection; optional clears it', () => {
    expect(toggleModifier(single(true), ['a'], 'a')).toEqual(['a']);
    expect(toggleModifier(single(false), ['a'], 'a')).toEqual([]);
  });
  it('multi: adds up to max then ignores', () => {
    const r = multi(1, 2);
    expect(toggleModifier(r, [], 'a')).toEqual(['a']);
    expect(toggleModifier(r, ['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleModifier(r, ['a', 'b'], 'c')).toEqual(['a', 'b']);
  });
  it('multi: tapping a selected option removes it', () => {
    expect(toggleModifier(multi(1, 3), ['a', 'b'], 'a')).toEqual(['b']);
  });
});
