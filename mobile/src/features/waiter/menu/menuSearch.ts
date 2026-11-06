import type { MenuItem } from '../../../domain/types';

const FALLBACK: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n', à: 'a', è: 'e', ì: 'i', ò: 'o', ù: 'u' };

/** Case- and accent-insensitive key: "Piña Colada" -> "pina colada". */
export function normalizeText(s: string): string {
  let out = s.toLowerCase();
  try {
    out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // Hermes build without String.normalize
  }
  return out.replace(/[áéíóúüñàèìòù]/g, (c) => FALLBACK[c] ?? c).replace(/\s+/g, ' ').trim();
}

export const ALL_CATEGORIES = 'ALL';

/** Active items of the chosen category whose name contains every word of the query. */
export function filterMenuItems(items: readonly MenuItem[], categoryId: string, query: string): MenuItem[] {
  const words = normalizeText(query).split(' ').filter(Boolean);
  return items.filter((i) => {
    if (i.is_active === false) return false;
    if (categoryId !== ALL_CATEGORIES && i.category_id !== categoryId) return false;
    if (!words.length) return true;
    const name = normalizeText(i.name);
    return words.every((w) => name.includes(w));
  });
}
