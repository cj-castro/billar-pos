import { formatUnitCost } from '../utils/money'

/**
 * Enter a cost the way the item is BOUGHT: "Costo por caja (24 botellas)" — and
 * see what that means per unit before saving. The backend does the real
 * division (exactly, 4 decimals of a centavo); the preview here is display only.
 *
 * Two cases:
 *  - bought in the same unit it is stocked in (Caja / Caja, or no purchase
 *    unit): just "Costo por caja" — no pack size.
 *  - bought in a different unit (stocked by Botella, bought by Caja): "how many
 *    botellas per caja" is REQUIRED and starts empty. It used to default to 1,
 *    which silently turned a $380 case into "$380 por botella".
 *
 * Used by: new inventory item, Analítica → Costos (first cost and corrections).
 * Reabastecer has its own equivalent fields.
 */

const plural = (w: string, n: number) =>
  n === 1 || !w || w.endsWith('s') || w === 'ml' ? w : w + (/[aeiouáéó]$/.test(w) ? 's' : 'es')

/** True when the units differ and the pack size is missing or not a real count. */
export function packMissing(baseKey?: string | null, purchaseKey?: string | null, packSize?: string | number | null) {
  if (!purchaseKey || !baseKey || purchaseKey === baseKey) return false
  const n = parseFloat(String(packSize ?? ''))
  return !(n > 1)
}

export function CostEntry({
  pricePesos, onPrice,
  packSize, onPackSize,
  baseUnitName, purchaseUnitName,
  baseUnitKey, purchaseUnitKey,
  autoFocus, compact,
}: {
  pricePesos: string
  onPrice: (v: string) => void
  /** units of the base unit in one purchase unit (24 botellas por caja, 3780 ml por garrafa) */
  packSize: string
  /** omit to make the pack size read-only */
  onPackSize?: (v: string) => void
  baseUnitName: string
  purchaseUnitName?: string | null
  /** keys, to tell "same unit" apart reliably (names are only for display) */
  baseUnitKey?: string | null
  purchaseUnitKey?: string | null
  autoFocus?: boolean
  compact?: boolean
}) {
  const sameUnit = !purchaseUnitName
    || (baseUnitKey && purchaseUnitKey ? baseUnitKey === purchaseUnitKey
        : purchaseUnitName.toLowerCase() === baseUnitName.toLowerCase())
  const pack = parseFloat(packSize)
  const packOk = pack > 1
  const byPack = !sameUnit
  const price = parseFloat(pricePesos)
  const perUnitCents = price > 0 && packOk ? (price * 100) / pack : null
  const base = baseUnitName.toLowerCase()
  const purchase = (purchaseUnitName ?? '').toLowerCase()

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2' : 'space-y-1'}>
      {!compact && (
        <label className="text-xs text-slate-400 block">
          {byPack
            ? `Costo por ${purchase}${packOk ? ` (${pack} ${plural(base, pack)})` : ''}`
            : `Costo por ${sameUnit && purchase ? purchase : base}`}
        </label>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-slate-500">$</span>
        <input type="number" min={0} step={0.01} inputMode="decimal" autoFocus={autoFocus}
          value={pricePesos} onChange={e => onPrice(e.target.value)} placeholder="0.00"
          className={`${compact ? 'w-24' : 'w-32'} bg-slate-700 border border-slate-600 rounded px-2 py-1 font-mono`} />
        {byPack && (
          <span className="text-xs text-slate-400 flex items-center gap-1">
            por {purchase} de
            {onPackSize ? (
              <input type="number" min={2} step={1} value={packSize} placeholder="¿?"
                onChange={e => onPackSize(e.target.value)}
                className={`w-16 bg-slate-700 border rounded px-1 py-0.5 font-mono text-slate-100 ${
                  packOk ? 'border-slate-600' : 'border-amber-500'}`} />
            ) : <b className="text-slate-200">{packOk ? pack : '?'}</b>}
            {plural(base, packOk ? pack : 2)}
          </span>
        )}
        {!byPack && compact && <span className="text-xs text-slate-500">por {sameUnit && purchase ? purchase : base}</span>}
      </div>
      {byPack && !packOk && (
        <div className="text-xs text-amber-300">¿Cuántas {plural(base, 2)} trae {/^[aeiou]/.test(purchase) ? 'el' : 'la'} {purchase}? (obligatorio)</div>
      )}
      {perUnitCents != null && byPack && (
        <div className="text-xs text-emerald-300">= {formatUnitCost(perUnitCents)} por {base}</div>
      )}
    </div>
  )
}
