/**
 * Reportes → Inventario → Porcionado (owner). Batch E8.
 * Yield per raw product and every portioning batch: kg in, packs out, waste,
 * yield, cost per pack, who.
 */
import { useQuery } from '@tanstack/react-query'
import client from '../../api/client'
import { formatMXN, formatUnitCost } from '../../utils/money'
import { QueryState } from '../../components/QueryState'

const kg = (g: number) => `${(Math.round(g / 10) / 100).toLocaleString()} kg`
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function PortioningPanel({ from, to }: { from: string; to: string }) {
  const q = useQuery<any>({
    queryKey: ['portioning', from, to],
    queryFn: () => client.get('/inventory/portioning', { params: { from, to } }).then(r => r.data),
  })
  return (
    <QueryState query={q}>
      {(() => {
        const d = q.data ?? { lotes: [], por_producto: [] }
        return (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
              <div className="px-4 py-2 border-b border-slate-800 text-sm font-semibold">Rendimiento por producto</div>
              {d.por_producto.length === 0 ? <div className="p-4 text-sm text-slate-500">Sin porcionados en este periodo. Se registran en Inventario → 🔪 Porcionar.</div> : (
                <table className="w-full text-sm">
                  <thead><tr className="text-xs text-slate-400">
                    <th className="p-2 text-left">Crudo</th><th className="p-2 text-right">Lotes</th>
                    <th className="p-2 text-right">Entró</th><th className="p-2 text-right">En paquetes</th>
                    <th className="p-2 text-right">Merma</th><th className="p-2 text-right">Rendimiento</th></tr></thead>
                  <tbody>{d.por_producto.map((p: any) => (
                    <tr key={p.raw} className="border-t border-slate-800">
                      <td className="p-2">{p.raw}</td><td className="p-2 text-right">{p.lotes}</td>
                      <td className="p-2 text-right font-mono">{kg(p.used_g)}</td>
                      <td className="p-2 text-right font-mono">{kg(p.output_g)}</td>
                      <td className="p-2 text-right font-mono text-amber-300">{kg(p.used_g - p.output_g)}</td>
                      <td className={`p-2 text-right font-mono font-bold ${p.yield_pct < 85 ? 'text-amber-300' : 'text-emerald-300'}`}>{p.yield_pct}%</td>
                    </tr>))}</tbody>
                </table>
              )}
            </div>
            <div className="space-y-2">{d.lotes.map((b: any) => (
              <div key={b.id} className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-sm">
                <div className="flex justify-between flex-wrap gap-2">
                  <span><b>#{b.batch_number} · {b.raw}</b> <span className="text-slate-400">· {when(b.created_at)} · {b.por}</span></span>
                  <span className="font-mono">{kg(b.raw_used_g)} → {kg(b.output_g)} · merma {kg(b.waste_g)} ·{' '}
                    <b className={b.yield_pct < 85 ? 'text-amber-300' : 'text-emerald-300'}>{b.yield_pct}%</b> · costo {formatMXN(b.input_cost_cents)}</span>
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {b.salidas.map((o: any) => `${o.packs} × ${o.name} (${formatUnitCost(o.pack_cost_cents)} c/u)`).join(' · ')}
                  {b.notes ? ` · ${b.notes}` : ''}
                </div>
              </div>))}
            </div>
          </div>
        )
      })()}
    </QueryState>
  )
}
