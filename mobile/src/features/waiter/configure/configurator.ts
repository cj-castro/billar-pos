import type { MenuItem, ModifierGroup } from '../../../domain/types';
import { validateModifierSelection, type ModifierRule } from '../../../utils/modifiers';
import type { NewDraftLine } from '../draft/draftStore';

export const NOTE_MAX = 120;
export type Selections = Record<string, string[]>;

/** Groups attached to the item: GET /menu/items embeds them (MenuItem.to_dict(with_modifiers=True)), active modifiers only. */
export const groupsForItem = (item: MenuItem): ModifierGroup[] => item.modifier_groups ?? [];

export const ruleOf = (g: ModifierGroup): ModifierRule => ({
  isMandatory: g.is_mandatory,
  min: g.min_selections,
  max: g.max_selections,
  allowMultiple: g.allow_multiple,
});

export interface SelectionCheck {
  valid: boolean;
  invalidGroupIds: string[];
}

/** Applies the same rules as the web POS (the server does not, rule K.136), via `validateModifierSelection`. */
export function checkSelections(groups: readonly ModifierGroup[], selections: Selections): SelectionCheck {
  const invalidGroupIds = groups.filter((g) => !validateModifierSelection(ruleOf(g), (selections[g.id] ?? []).length).valid).map((g) => g.id);
  return { valid: invalidGroupIds.length === 0, invalidGroupIds };
}

/** Item needs the configurator (tap) instead of a quick-add: it has options or requires a flavor. */
export const needsConfigurator = (item: MenuItem) => (item.modifier_groups?.length ?? 0) > 0 || !!item.requires_flavor;

export function buildDraftLine(item: MenuItem, groups: readonly ModifierGroup[], selections: Selections, notes: string, quantity: number): NewDraftLine {
  const modifiers = groups.flatMap((g) =>
    (selections[g.id] ?? []).flatMap((id) => {
      const m = g.modifiers.find((x) => x.id === id);
      return m ? [{ id: m.id, name: m.name, priceCents: m.price_cents ?? 0 }] : [];
    }),
  );
  return {
    menuItemId: item.id,
    name: item.name,
    unitPriceCents: item.price_cents,
    quantity,
    modifiers,
    notes: notes.trim().slice(0, NOTE_MAX),
  };
}

/** Quick-add for items without options. */
export const quickLine = (item: MenuItem): NewDraftLine => buildDraftLine(item, [], {}, '', 1);
