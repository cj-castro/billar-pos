/**
 * Reportes → Inventario → Conteos de barra (owner). Batch E2, step 2.
 * What is open right now (with the system's estimate per bottle) and every
 * bar count in the range, with its differences in units and pesos.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import client from '../../api/client'
import { formatMXN } from '../../utils/money'
import { QueryState } from '../../components/QueryState'

const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1)
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function BarCountsPanel({ from, to }: { from: string; to: string }) {
  const q = useQuery<any>({
    queryKey: ['bar-counts', from, to],
    queryFn: () => client.get('/inventory/bar-counts', { params: { from, to } }).then(r => r.data),
  })
  const [open, setOpen] = useState<string | null>(null)

  return (
    <QueryState query={q}>
      {(() => {
        const d = q.data ?? { counts: [], now: [] }
        const total = d.counts.reduce((a: number, c: any) => a + c.total_variance_cents, 0)
        return (
          <div className="space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm text-slate-400">
                {d.counts.length} conteo(s) en el periodo · diferencia total{' '}
                <span className={`font-mono font-bold ${total < 0 ? 'text-red-400' : 'text-emerald-300'}`}>{formatMXN(total)}</span>
              </div>
              <Link to="/manager/bar-count" className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-sm font-semibold">🍾 Hacer conteo</Link>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
              <div className="px-4 py-2 border-b border-slate-800 text-sm font-semibold">Ahora en la barra (según el sistema)</div>
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-slate-400">
                  <th className="p-2 text-left">Licor</th><th className="p-2 text-left">Botellas abiertas (estimado)</th>
                  <th className="p-2 text-right">Abierto</th><th className="p-2 text-right">Cerradas</th></tr></thead>
                <tbody>{d.now.map((s: any) => (
                  <tr key={s.shot_item_id} className="border-t border-slate-800">
                    <td className="p-2">{s.name}</td>
                    <td className="p-2 text-xs text-slate-300">
                      {s.open_bottles.length === 0 ? <span className="text-slate-500">—</span>
                        : s.open_bottles.map((b: any) => `${fmt(b.expected_ml)}/${fmt(b.size_ml)} ml`).join(' · ')}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {fmt(s.pooled_ml)} ml{s.pour_ml ? <span className="text-slate-500 text-xs"> ({Math.floor(s.pooled_ml / s.pour_ml)} shots)</span> : null}
                    </td>
                    <td className="p-2 text-right font-mono">{fmt(s.sealed)}</td>
                  </tr>))}</tbody>
              </table>
            </div>

            {d.counts.length === 0
              ? <div className="text-slate-500 text-sm p-6 text-center">Sin conteos de barra en este periodo.</div>
              : <div className="space-y-2">{d.counts.map((c: any) => (
                  <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-xl">
                    <button onClick={() => setOpen(open === c.id ? null : c.id)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left">
                      <span className="text-sm">{when(c.counted_at)} · <span className="text-slate-400">{c.counted_by ?? '—'}</span>
                        {c.notes ? <span className="text-slate-500"> · {c.notes}</span> : null}</span>
                      <span className={`font-mono font-bold ${c.total_variance_cents < 0 ? 'text-red-400' : c.total_variance_cents > 0 ? 'text-emerald-300' : 'text-slate-400'}`}>
                        {formatMXN(c.total_variance_cents)}
                      </span>
                    </button>
                    {open === c.id && (
                      <table className="w-full text-sm border-t border-slate-800">
                        <thead><tr className="text-xs text-slate-400">
                          <th className="p-2 text-left">Artículo</th><th className="p-2 text-right">Sistema</th>
                          <th className="p-2 text-right">Contado</th><th className="p-2 text-right">Diferencia</th>
                          <th className="p-2 text-right">$</th></tr></thead>
                        <tbody>{c.lines.map((l: any, i: number) => (
                          <tr key={i} className="border-t border-slate-800">
                            <td className="p-2">{l.name}</td>
                            <td className="p-2 text-right font-mono">{fmt(l.expected)} {l.unit}</td>
                            <td className="p-2 text-right font-mono">{fmt(l.counted)} {l.unit}</td>
                            <td className={`p-2 text-right font-mono ${l.variance < 0 ? 'text-red-400' : l.variance > 0 ? 'text-emerald-300' : 'text-slate-500'}`}>
                              {l.variance > 0 ? '+' : ''}{fmt(l.variance)} {l.unit}</td>
                            <td className="p-2 text-right font-mono">{formatMXN(l.variance_cents)}</td>
                          </tr>))}</tbody>
                      </table>
                    )}
                  </div>))}
                </div>}
          </div>
        )
      })()}
    </QueryState>
  )
}
