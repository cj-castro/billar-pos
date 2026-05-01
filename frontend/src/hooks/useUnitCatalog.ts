import { useQuery } from '@tanstack/react-query'
import client from '../api/client'
import { useLanguage } from './useLanguage'

export interface UnitEntry {
  key: string
  name_es: string
  name_en: string
  active: boolean
}

/**
 * Fetches the unit catalog once (staleTime: Infinity) and exposes:
 * - `units`       — full array of UnitEntry
 * - `getUnitName` — resolves a unit key to its display name in the current language
 *
 * All unit name displays in the app should call getUnitName(key) so they
 * automatically update when the user toggles the language.
 */
export function useUnitCatalog() {
  const { lang } = useLanguage()

  const { data: units = [] } = useQuery<UnitEntry[]>({
    queryKey: ['unit-catalog'],
    queryFn: () => client.get('/inventory/units').then(r => r.data),
    staleTime: Infinity,
  })

  const getUnitName = (key: string): string => {
    if (!key) return '—'
    const unit = units.find(u => u.key === key)
    if (!unit) return key
    return lang === 'es' ? unit.name_es : unit.name_en
  }

  return { units, getUnitName }
}
