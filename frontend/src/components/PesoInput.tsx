/**
 * Money field typed in PESOS ("166", "166.50"), stored in CENTAVOS.
 *
 * Every price in the database is integer centavos, but nobody thinks in
 * centavos: typing "166" used to save $1.66. This field shows and accepts
 * pesos and hands the parent integer centavos, so call sites keep their
 * existing `*_cents` state and API payloads unchanged.
 *
 * It keeps its own text while the user types, so "166." or "0.5" are not
 * rewritten mid-keystroke; it re-syncs only when the parent's value changes
 * from outside (a form reset, a different row opened).
 */
import { useEffect, useState } from 'react'

const toText = (cents: number | string | null | undefined) => {
  const n = Number(cents)
  if (cents === '' || cents == null || !Number.isFinite(n) || n === 0) return ''
  return String(n / 100)
}
const toCents = (text: string) => {
  const p = parseFloat(text.replace(',', '.'))
  return Number.isFinite(p) && p > 0 ? Math.round(p * 100) : 0
}

export function PesoInput({ cents, onChange, className = '', placeholder = '0.00', autoFocus }: {
  cents: number | string | null | undefined
  onChange: (cents: number) => void
  className?: string
  placeholder?: string
  autoFocus?: boolean
}) {
  const [text, setText] = useState(() => toText(cents))

  useEffect(() => {
    if (toCents(text) !== Number(cents || 0)) setText(toText(cents))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents])

  return (
    <div className={`flex items-center bg-slate-700 border border-slate-600 rounded-lg focus-within:border-sky-500 ${className}`}>
      <span className="pl-3 text-slate-400 select-none">$</span>
      <input type="text" inputMode="decimal" autoFocus={autoFocus} value={text} placeholder={placeholder}
        onChange={e => {
          const v = e.target.value.replace(/[^0-9.,]/g, '')
          setText(v)
          onChange(toCents(v))
        }}
        className="w-full min-w-0 bg-transparent px-2 py-2 font-mono text-right outline-none" />
    </div>
  )
}
