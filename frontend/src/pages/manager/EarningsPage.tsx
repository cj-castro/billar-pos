import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import { formatMXN } from '../../utils/money'

type Tab = 'summary' | 'category' | 'staff'

function today() {
  return new Date().toISOString().slice(0, 10)
}

function firstOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function pct(n: number, total: number) {
  if (!total) return '—'
  return (n / total * 100).toFixed(1) + '%'
}

function MarginBadge({ pct: p }: { pct: number }) {
  const color = p >= 60 ? 'text-emerald-400' : p >= 40 ? 'text-yellow-400' : 'text-red-400'
  return <span className={`font-mono font-bold ${color}`}>{p.toFixed(1)}%</span>
}

export default function EarningsPage() {
  const [tab, setTab] = useState<Tab>('summary')
  const [from, setFrom] = useState(firstOfMonth())
  const [to, setTo] = useState(today())

  const params = { from, to }

  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ['earnings-summary', from, to],
    queryFn: () => client.get('/reports/earnings', { params }).then(r => r.data),
  })

  const { data: byCategory, isLoading: loadingCat } = useQuery({
    queryKey: ['earnings-category', from, to],
    queryFn: () => client.get('/reports/earnings/by-category', { params }).then(r => r.data),
    enabled: tab === 'category',
  })

  const { data: byStaff, isLoading: loadingStaff } = useQuery({
    queryKey: ['earnings-staff', from, to],
    queryFn: () => client.get('/reports/earnings/by-staff', { params }).then(r => r.data),
    enabled: tab === 'staff',
  })

  const tabCls = (t: Tab) =>
    `px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
      tab === t ? 'bg-violet-700 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
    }`

  return (
    <div className="min-h-screen bg-slate-950 page-root pb-24">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-3xl mx-auto p-4">
        <h1 className="text-xl font-bold mb-4">💹 Reporte de Ganancias</h1>

        {/* Date filter */}
        <div className="flex flex-wrap gap-3 mb-4 items-end">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Desde</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Hasta</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>

        {/* Missing cost warning */}
        {summary?.items_sin_costo_count > 0 && (
          <div className="mb-4 bg-amber-950/60 border border-amber-700 rounded-xl p-3 flex items-start gap-3">
            <span className="text-amber-400 text-lg mt-0.5">⚠</span>
            <div className="flex-1 text-sm">
              <span className="font-semibold text-amber-300">
                {summary.items_sin_costo_count} producto{summary.items_sin_costo_count !== 1 ? 's' : ''} sin costo configurado
              </span>
              <span className="text-amber-400/80"> — el margen mostrado es parcial.</span>
              <Link to="/manager/inventory" className="ml-2 underline text-amber-300 hover:text-amber-200">
                Ir a Inventario →
              </Link>
              {summary.items_sin_costo?.length > 0 && (
                <div className="text-xs text-amber-500 mt-1">
                  {summary.items_sin_costo.slice(0, 5).join(', ')}
                  {summary.items_sin_costo.length > 5 ? ` +${summary.items_sin_costo.length - 5} más` : ''}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Summary cards */}
        {loadingSummary ? (
          <div className="text-center text-slate-400 py-8">Cargando…</div>
        ) : summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Ingresos</div>
              <div className="font-bold text-white font-mono text-sm">{formatMXN(summary.ingresos_cents)}</div>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Costo de Ventas</div>
              <div className="font-bold text-red-400 font-mono text-sm">{formatMXN(summary.cogs_cents)}</div>
            </div>
            <div className="bg-slate-800 border border-emerald-800 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Ganancia Bruta</div>
              <div className="font-bold text-emerald-400 font-mono text-sm">{formatMXN(summary.ganancia_cents)}</div>
            </div>
            <div className="bg-slate-800 border border-violet-800 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Margen</div>
              <div className="text-lg font-bold">
                <MarginBadge pct={summary.margen_pct} />
              </div>
            </div>
          </div>
        )}

        {summary?.pool_cents > 0 && (
          <p className="text-xs text-slate-500 mb-4">
            * Barra incluye {formatMXN(summary.pool_cents)} de tiempo de billar (sin costo de insumos).
          </p>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          <button onClick={() => setTab('summary')} className={tabCls('summary')}>Resumen</button>
          <button onClick={() => setTab('category')} className={tabCls('category')}>Por Categoría</button>
          <button onClick={() => setTab('staff')} className={tabCls('staff')}>Por Personal</button>
        </div>

        {/* Summary tab — top items with no cost */}
        {tab === 'summary' && summary && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 border-b border-slate-700">
                  <th className="text-left px-4 py-3">Concepto</th>
                  <th className="text-right px-4 py-3">Monto</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-700/50">
                  <td className="px-4 py-3 text-slate-200">Ventas Barra (caja + terminal)</td>
                  <td className="px-4 py-3 text-right font-mono">{formatMXN(summary.ingresos_barra_cents - summary.pool_cents)}</td>
                </tr>
                {summary.ingresos_rappi_cents > 0 && (
                  <tr className="border-b border-slate-700/50">
                    <td className="px-4 py-3 text-slate-200">🛵 Ventas Rappi</td>
                    <td className="px-4 py-3 text-right font-mono text-orange-300">{formatMXN(summary.ingresos_rappi_cents)}</td>
                  </tr>
                )}
                {summary.pool_cents > 0 && (
                  <tr className="border-b border-slate-700/50">
                    <td className="px-4 py-3 text-slate-200">Ingresos por tiempo de billar</td>
                    <td className="px-4 py-3 text-right font-mono">{formatMXN(summary.pool_cents)}</td>
                  </tr>
                )}
                <tr className="border-b border-slate-700/50">
                  <td className="px-4 py-3 text-slate-200">Costo de Ventas (COGS)</td>
                  <td className="px-4 py-3 text-right font-mono text-red-400">({formatMXN(summary.cogs_cents)})</td>
                </tr>
                <tr className="bg-slate-700/40 font-bold">
                  <td className="px-4 py-3 text-emerald-300">Ganancia Bruta</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-300">{formatMXN(summary.ganancia_cents)}</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 text-slate-400 text-xs">Margen bruto</td>
                  <td className="px-4 py-3 text-right">
                    <MarginBadge pct={summary.margen_pct} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* By category tab */}
        {tab === 'category' && (
          loadingCat ? (
            <div className="text-center text-slate-400 py-8">Cargando…</div>
          ) : byCategory && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-400 border-b border-slate-700">
                    <th className="text-left px-4 py-3">Categoría</th>
                    <th className="text-right px-3 py-3">Ingresos</th>
                    <th className="text-right px-3 py-3">COGS</th>
                    <th className="text-right px-3 py-3">Ganancia</th>
                    <th className="text-right px-4 py-3">Margen</th>
                  </tr>
                </thead>
                <tbody>
                  {byCategory.rows.map((r: any) => (
                    <tr key={r.category} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                      <td className="px-4 py-3 font-medium">
                        {r.category}
                        {r.note && <span className="text-xs text-slate-500 ml-2">({r.note})</span>}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs">{formatMXN(r.ingresos_cents)}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-red-400">
                        {r.cogs_cents > 0 ? formatMXN(r.cogs_cents) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-emerald-400">{formatMXN(r.ganancia_cents)}</td>
                      <td className="px-4 py-3 text-right text-xs">
                        {r.cogs_cents > 0
                          ? <MarginBadge pct={r.ingresos_cents > 0 ? r.ganancia_cents / r.ingresos_cents * 100 : 0} />
                          : <span className="text-slate-500">—</span>}
                      </td>
                    </tr>
                  ))}
                  {/* Totals */}
                  <tr className="bg-slate-700/50 font-bold border-t border-slate-600">
                    <td className="px-4 py-3">TOTAL</td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{formatMXN(byCategory.total.ingresos_cents)}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-red-400">{formatMXN(byCategory.total.cogs_cents)}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-emerald-400">{formatMXN(byCategory.total.ganancia_cents)}</td>
                    <td className="px-4 py-3 text-right">
                      <MarginBadge pct={byCategory.total.margen_pct} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        )}

        {/* By staff tab */}
        {tab === 'staff' && (
          loadingStaff ? (
            <div className="text-center text-slate-400 py-8">Cargando…</div>
          ) : byStaff && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-400 border-b border-slate-700">
                    <th className="text-left px-4 py-3">Personal</th>
                    <th className="text-right px-3 py-3">Ingresos</th>
                    <th className="text-right px-3 py-3">COGS</th>
                    <th className="text-right px-3 py-3">Ganancia</th>
                    <th className="text-right px-4 py-3">Margen</th>
                  </tr>
                </thead>
                <tbody>
                  {byStaff.rows.map((r: any) => (
                    <tr key={r.user_id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                      <td className="px-4 py-3 font-medium">{r.staff_name}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs">{formatMXN(r.ingresos_cents)}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-red-400">
                        {r.cogs_cents > 0 ? formatMXN(r.cogs_cents) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-emerald-400">{formatMXN(r.ganancia_cents)}</td>
                      <td className="px-4 py-3 text-right">
                        <MarginBadge pct={r.margen_pct} />
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-700/50 font-bold border-t border-slate-600">
                    <td className="px-4 py-3">TOTAL</td>
                    <td className="px-3 py-3 text-right font-mono text-xs">{formatMXN(byStaff.total.ingresos_cents)}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-red-400">{formatMXN(byStaff.total.cogs_cents)}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-emerald-400">{formatMXN(byStaff.total.ganancia_cents)}</td>
                    <td className="px-4 py-3 text-right">
                      <MarginBadge pct={byStaff.total.margen_pct} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  )
}
