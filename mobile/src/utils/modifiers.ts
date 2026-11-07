/**
 * Modifier-group selection rules (pure; the server does NOT validate these, rule K.136).
 * Mirrors the web POS AddItemModal:
 *  - single-select group (allow_multiple=false): exactly 0..1 picks; required iff is_mandatory.
 *  - allow_multiple group: needs at least `min_selections` picks (web ignores is_mandatory here) and at
 *    most `max_selections`; a max <= 0 means "no limit".
 */
export interface ModifierRule {
  isMandatory: boolean;
  min: number;
  max: number;
  allowMultiple: boolean;
}

export interface ModifierValidation {
  min: number;
  /** Infinity = unlimited. */
  max: number;
  required: boolean;
  count: number;
  valid: boolean;
  error: 'min' | 'max' | null;
  /** More options may still be selected (false => disable the unselected rows). */
  canAddMore: boolean;
}

export function effectiveBounds(rule: ModifierRule): { min: number; max: number } {
  if (!rule.allowMultiple) return { min: rule.isMandatory ? 1 : 0, max: 1 };
  const min = Math.max(0, Math.floor(rule.min || 0));
  const max = rule.max > 0 ? Math.max(Math.floor(rule.max), min) : Infinity;
  return { min, max };
}

export function validateModifierSelection(rule: ModifierRule, selectedCount: number): ModifierValidation {
  const { min, max } = effectiveBounds(rule);
  const count = Math.max(0, selectedCount);
  const error = count < min ? 'min' : count > max ? 'max' : null;
  return { min, max, required: min > 0, count, valid: error === null, error, canAddMore: count < max };
}

/** Next selection after tapping option `id`. Single-select replaces (and deselects if optional). */
export function toggleModifier(rule: ModifierRule, selectedIds: readonly string[], id: string): string[] {
  const has = selectedIds.includes(id);
  if (!rule.allowMultiple) {
    if (has) return rule.isMandatory ? [...selectedIds] : [];
    return [id];
  }
  if (has) return selectedIds.filter((x) => x !== id);
  const { max } = effectiveBounds(rule);
  return selectedIds.length >= max ? [...selectedIds] : [...selectedIds, id];
}
