/**
 * Reportes → Personal y riesgos → Cortesías y personal (owner). Batch E5.
 * What was given away — to customers (cortesías) and to staff — why, who
 * authorized it, for whom; at list value and at cost.
 */
import { useQuery } from '@tanstack/react-query'
import client from '../../api/client'
import { formatMXN } from '../../utils/money'
import { QueryState } from '../../components/QueryState'

function Table({ title, rows, kind }: { title: string; rows: any[]; kind?: string }) {
  const list = kind ? rows.filter(r => r.tipo === kind) : rows
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-800 text-sm font-semibold">{title}</div>
      {list.length === 0 ? <div className="p-4 text-sm text-slate-500">—</div> : (
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-slate-400">
            <th className="p-2 text-left"></th>{!kind && <th className="p-2 text-left">Tipo</th>}
            <th className="p-2 text-right">Artículos</th><th className="p-2 text-right">Precio de lista</th>
            <th className="p-2 text-right">Costo</th></tr></thead>
          <tbody>{list.map((r, i) => (
            <tr key={i} className="border-t border-slate-800">
              <td className="p-2">{r.nombre}</td>
              {!kind && <td className="p-2 text-xs text-slate-400">{r.tipo === 'CORTESIA' ? '🎁 Cortesía' : '🍽 Personal'}</td>}
              <td className="p-2 text-right font-mono">{r.unidades ?? r.lineas}</td>
              <td className="p-2 text-right font-mono text-slate-400">{formatMXN(r.valor_lista_cents)}</td>
              <td className="p-2 text-right font-mono">{formatMXN(r.costo_cents)}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  )
}

export default function CompsPanel({ from, to }: { from: string; to: string }) {
  const q = useQuery<any>({
    queryKey: ['an-comps', from, to],
    queryFn: () => client.get('/analytics/comps', { params: { from, to } }).then(r => r.data),
  })
  return (
    <QueryState query={q}>
      {(() => {
        const d = q.data
        if (!d) return null
        const pct = (c: number) => d.ventas_cents ? ` · ${(c / d.ventas_cents * 100).toFixed(1)}% de las ventas` : ''
        const card = (title: string, x: any, tone: string) => (
          <div className={`rounded-xl border p-4 ${tone}`}>
            <div className="text-xs text-slate-300">{title}</div>
            <div className="text-2xl font-bold font-mono mt-1">{formatMXN(x.costo_cents)}</div>
            <div className="text-xs text-slate-400 mt-1">
              a costo · {x.unidades} artículos · precio de lista {formatMXN(x.valor_lista_cents)}{pct(x.valor_lista_cents)}
            </div>
            {x.sin_costo > 0 && <div className="text-xs text-amber-300 mt-1">{x.sin_costo} sin costo registrado: el costo real es mayor</div>}
          </div>
        )
        return (
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              {card('🎁 Cortesías a clientes', d.cortesias, 'bg-pink-950/30 border-pink-800')}
              {card('🍽 Consumo de personal', d.personal, 'bg-teal-950/30 border-teal-800')}
            </div>
            <div className="grid lg:grid-cols-2 gap-3">
              <Table title="🍽 Consumo por empleado" rows={d.por_empleado} kind="PERSONAL" />
              <Table title="🍽 Productos al personal" rows={d.por_producto} kind="PERSONAL" />
              <Table title="🎁 Productos en cortesía" rows={d.por_producto} kind="CORTESIA" />
              <Table title="Por motivo" rows={d.por_motivo} />
              <Table title="Quién autorizó" rows={d.por_autorizo} />
            </div>
            {d.personal_detalle?.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2 border-b border-slate-800 text-sm font-semibold">🍽 Qué consumió cada empleado</div>
                <table className="w-full text-sm">
                  <thead><tr className="text-xs text-slate-400">
                    <th className="p-2 text-left">Empleado</th><th className="p-2 text-left">Producto</th>
                    <th className="p-2 text-right">Artículos</th><th className="p-2 text-right">Precio de lista</th>
                    <th className="p-2 text-right">Costo</th></tr></thead>
                  <tbody>{d.personal_detalle.map((r: any, i: number) => {
                    const first = i === 0 || d.personal_detalle[i - 1].empleado !== r.empleado
                    return (
                      <tr key={i} className={first ? 'border-t border-slate-700' : ''}>
                        <td className="p-2 font-semibold">{first ? r.empleado : ''}</td>
                        <td className="p-2">{r.producto}</td>
                        <td className="p-2 text-right font-mono">{r.unidades}</td>
                        <td className="p-2 text-right font-mono text-slate-400">{formatMXN(r.valor_lista_cents)}</td>
                        <td className="p-2 text-right font-mono">{formatMXN(r.costo_cents)}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-slate-500">
              El costo de cortesías y personal aparece en Rentabilidad como líneas propias (no se esconde en el margen),
              cuenta como consumo en el pronóstico de compras y no como merma.
            </p>
          </div>
        )
      })()}
    </QueryState>
  )
}
