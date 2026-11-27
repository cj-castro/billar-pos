import { forwardRef, useId, useImperativeHandle, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMXN } from '../utils/money'
import { denomLabel, parseQty, totalCents, type CountLines, type Denom } from '../utils/cashCount'

/**
 * Count grid: one row per bill / coin, the manager types how many of each.
 * Built for speed at 5 am: numeric keypad, Enter or Tab goes to the next row,
 * the row subtotals and the total update while typing.
 *
 * `max` (optional) caps each row, e.g. "what stays in the drawer" can't be more
 * than what was counted. A row whose max is 0 is greyed out and skipped.
 * The grid never shows expected cash: it only knows what was typed.
 */
export interface CashCountGridProps {
  denoms: Denom[]
  value: CountLines
  onChange: (next: CountLines) => void
  max?: CountLines
  autoFocus?: boolean
  /** Enter on the last row (e.g. jump to the next grid). */
  onDone?: () => void
  /** Row the server refused (error `key`), shown in red. */
  errorKey?: string | null
  /** The server refused this whole grid (error `field`). */
  invalid?: boolean
}

export interface CashCountGridHandle {
  /** Focus the first row that can be typed in. Returns false if there is none. */
  focusFirst: () => boolean
}

const CashCountGrid = forwardRef<CashCountGridHandle, CashCountGridProps>(function CashCountGrid(
  { denoms, value, onChange, max, autoFocus, onDone, errorKey, invalid }, ref,
) {
  const { t } = useTranslation()
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const gridId = useId()   // two grids on one screen must not share input ids

  const rowMax = (key: string): number | undefined => (max ? (max[key] || 0) : undefined)

  const focusFrom = (start: number): boolean => {
    for (let j = start; j < inputs.current.length; j++) {
      const el = inputs.current[j]
      if (el && !el.disabled) { el.focus(); return true }
    }
    return false
  }

  useImperativeHandle(ref, () => ({ focusFirst: () => focusFrom(0) }))

  const setQty = (key: string, text: string) => {
    let q = parseQty(text)
    if (q === null) return // decimal or other text: keep the previous value
    const m = rowMax(key)
    if (m !== undefined && q > m) q = m
    const next = { ...value }
    if (q > 0) next[key] = q
    else delete next[key]
    onChange(next)
  }

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (!focusFrom(i + 1)) onDone?.()
  }

  const firstEnabled = denoms.findIndex(d => rowMax(d.key) !== 0)
  const total = totalCents(value, denoms)

  return (
    <div className={`rounded-xl border ${invalid ? 'border-red-500' : 'border-slate-700'} bg-slate-900 overflow-hidden`}>
      <div className="grid grid-cols-[1fr_7rem_7rem] gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
        <span>{t('cash.count.denomination')}</span>
        <span className="text-center">{t('cash.count.quantity')}</span>
        <span className="text-right">{t('cash.count.subtotal')}</span>
      </div>
      {denoms.map((d, i) => {
        const qty = value[d.key] || 0
        const m = rowMax(d.key)
        const disabled = m === 0
        const bad = errorKey === d.key
        const newKind = i > 0 && denoms[i - 1].kind !== d.kind
        return (
          <div key={d.key}
            className={`grid grid-cols-[1fr_7rem_7rem] gap-2 items-center px-3 py-1.5
              ${newKind ? 'border-t border-slate-700' : ''} ${bad ? 'bg-red-900/40' : ''} ${disabled ? 'opacity-40' : ''}`}>
            <label htmlFor={`${gridId}-${i}`} className="flex items-baseline gap-2 min-w-0">
              <span className="font-mono font-bold text-base">{denomLabel(d.cents)}</span>
              <span className="text-xs text-slate-400 truncate">
                {d.kind === 'COIN' ? t('cash.count.coin') : t('cash.count.bill')}
              </span>
            </label>
            <div className="flex items-center gap-1">
              <input
                id={`${gridId}-${i}`}
                ref={el => { inputs.current[i] = el }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                enterKeyHint={i === denoms.length - 1 ? 'done' : 'next'}
                autoFocus={autoFocus && i === firstEnabled}
                disabled={disabled}
                value={qty ? String(qty) : ''}
                placeholder="0"
                onFocus={e => e.currentTarget.select()}
                onChange={e => setQty(d.key, e.target.value)}
                onKeyDown={onKeyDown(i)}
                className={`w-full bg-slate-700 border rounded-lg px-2 py-2 text-lg font-mono text-center
                  ${bad ? 'border-red-500' : 'border-slate-600'} disabled:cursor-not-allowed`}
              />
              {m !== undefined && m > 0 && (
                <span className="text-[10px] text-slate-500 w-8 shrink-0">{t('cash.count.ofMax', { n: m })}</span>
              )}
            </div>
            <span className="text-right font-mono text-sm text-slate-300">
              {qty ? formatMXN(qty * d.cents) : ''}
            </span>
          </div>
        )
      })}
      <div className="flex justify-between px-3 py-2 border-t border-slate-700 bg-slate-800 font-bold">
        <span>{t('cash.count.total')}</span>
        <span className="font-mono text-lg">{formatMXN(total)}</span>
      </div>
    </div>
  )
})

export default CashCountGrid
