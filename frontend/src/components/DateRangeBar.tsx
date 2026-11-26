import { useSearchParams } from 'react-router-dom'
import { presetRange, RangePreset } from '../utils/dates'

const PRESETS: [RangePreset, string][] = [
  ['hoy', 'Hoy'], ['ayer', 'Ayer'], ['semana', 'Esta semana'], ['mes', 'Este mes'],
  ['mes_pasado', 'Mes pasado'], ['7d', '7 días'], ['30d', '30 días'], ['90d', '90 días'],
]
const KEY = 'billar.range'

/**
 * Date range shared by the report screens (batch C).
 *
 * Lives in the URL (?from=&to=) so a reload or a shared link keeps it, and in
 * sessionStorage so moving from Analítica to Reportes keeps the same range
 * instead of each screen starting on its own default (they used to: today,
 * 30 days and month-to-date). Dates are bar-local (utils/dates).
 */
export function useDateRange(defaultPreset: RangePreset = '30d') {
  const [params, setParams] = useSearchParams()
  const stored = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch { return null } })()
  const [dFrom, dTo] = presetRange(defaultPreset)
  const from = params.get('from') || stored?.from || dFrom
  const to = params.get('to') || stored?.to || dTo

  const setRange = (f: string, t: string) => {
    if (f > t) [f, t] = [t, f]
    sessionStorage.setItem(KEY, JSON.stringify({ from: f, to: t }))
    const next = new URLSearchParams(params)
    next.set('from', f); next.set('to', t)
    setParams(next, { replace: true })
  }
  return { from, to, setRange }
}

export function DateRangeBar({ from, to, onChange, note }: {
  from: string; to: string; onChange: (from: string, to: string) => void; note?: string
}) {
  const active = PRESETS.find(([p]) => { const [f, t] = presetRange(p); return f === from && t === to })?.[0]
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4 bg-slate-900 p-3 rounded-xl border border-slate-800">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(([p, label]) => (
          <button key={p} onClick={() => onChange(...presetRange(p))}
            className={`text-xs rounded px-3 py-1.5 border transition-colors ${active === p
              ? 'bg-sky-600 border-sky-500 text-white font-semibold'
              : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'}`}>{label}</button>
        ))}
      </div>
      <label className="text-sm">
        <span className="block text-xs text-slate-400 mb-1">Desde</span>
        <input type="date" value={from} onChange={e => e.target.value && onChange(e.target.value, to)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1" />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-slate-400 mb-1">Hasta</span>
        <input type="date" value={to} onChange={e => e.target.value && onChange(from, e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1" />
      </label>
      {note && <span className="text-xs text-slate-500">{note}</span>}
    </div>
  )
}
