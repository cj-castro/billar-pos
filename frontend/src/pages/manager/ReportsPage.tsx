import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, Line, PieChart, Pie, Cell,
} from 'recharts'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import { formatMXN, formatMXNFromPesos } from '../../utils/money'

const cents = formatMXN  // backwards-compatible alias for inline JSX

/** YYYY-MM-DD in the bar's local timezone (Mexico). Avoids the UTC-rollover
 *  bug where after 6pm local the default-day jumps to "tomorrow" with zero data. */
function localToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
}

const ROLE_LABELS: Record<string, string> = {
  WAITER: '🏃 Mesero', BAR_STAFF: '🍹 Bar', KITCHEN_STAFF: '🍳 Cocina',
  MANAGER: '👔 Gerente', ADMIN: '🔑 Admin',
}

export default function ReportsPage() {
  const today = localToday()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [tab, setTab] = useState<'sales' | 'pool' | 'payments' | 'modifiers' | 'staff' | 'voids' | 'peak-hours' | 'inv-deletions' | 'menu-deletions' | 'charts' | 'cigarettes'>('sales')
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL')

  const params = { from: `${from}T00:00:00`, to: `${to}T23:59:59` }

  const { data: sales } = useQuery({ queryKey: ['report-sales', from, to], queryFn: () => client.get('/reports/sales', { params }).then(r => r.data), enabled: tab === 'sales' })
  const { data: pool } = useQuery({ queryKey: ['report-pool', from, to], queryFn: () => client.get('/reports/pool-time', { params }).then(r => r.data), enabled: tab === 'pool' || tab === 'charts' })
  const { data: payments } = useQuery({ queryKey: ['report-payments', from, to], queryFn: () => client.get('/reports/payments', { params }).then(r => r.data), enabled: tab === 'payments' })
  const { data: modifiers } = useQuery({ queryKey: ['report-modifiers', from, to], queryFn: () => client.get('/reports/modifiers', { params }).then(r => r.data), enabled: tab === 'modifiers' })
  const { data: staff } = useQuery({ queryKey: ['report-staff', from, to], queryFn: () => client.get('/reports/staff', { params }).then(r => r.data), enabled: tab === 'staff' })
  const { data: voids } = useQuery({ queryKey: ['report-voids', from, to], queryFn: () => client.get('/reports/voids', { params }).then(r => r.data), enabled: tab === 'voids' })
  const { data: peakHours } = useQuery({ queryKey: ['report-peak-hours', from, to], queryFn: () => client.get('/reports/peak-hours', { params }).then(r => r.data), enabled: tab === 'peak-hours' })
  const { data: menuDeletions } = useQuery({ queryKey: ['report-menu-deletions', from, to], queryFn: () => client.get('/reports/menu-deletions', { params }).then(r => r.data), enabled: tab === 'menu-deletions' })
  const { data: invDeletions } = useQuery({ queryKey: ['report-inv-deletions', from, to], queryFn: () => client.get('/reports/inventory-deletions', { params }).then(r => r.data), enabled: tab === 'inv-deletions' })
  const { data: cigData } = useQuery({ queryKey: ['report-cigarettes', from, to], queryFn: () => client.get('/reports/cigarettes', { params }).then(r => r.data), enabled: tab === 'cigarettes' })
  const { data: chartsData } = useQuery({ queryKey: ['report-charts', from, to], queryFn: () => client.get('/reports/charts-data', { params }).then(r => r.data), enabled: tab === 'charts' || tab === 'sales' || tab === 'pool' || tab === 'staff' })

  // Derive unique categories from sales data
  const categories = useMemo(() => {
    if (!sales) return []
    return Array.from(new Set((sales as any[]).map((r: any) => r.category))).sort() as string[]
  }, [sales])

  // Reset filter when switching tabs or dates
  const filteredSales = useMemo(() => {
    if (!sales) return []
    if (categoryFilter === 'ALL') return sales as any[]
    return (sales as any[]).filter((r: any) => r.category === categoryFilter)
  }, [sales, categoryFilter])

  const filteredTotals = useMemo(() => ({
    units: filteredSales.reduce((s: number, r: any) => s + Number(r.units_sold), 0),
    gross: filteredSales.reduce((s: number, r: any) => s + Number(r.gross_cents), 0),
    discounts: filteredSales.reduce((s: number, r: any) => s + Number(r.discounts_cents), 0),
  }), [filteredSales])

  // Grand total note — sums chartsData daily_revenue which covers the full period (sales + pool)
  const chartDaily = (chartsData as any)?.daily_revenue ?? []
  const grandTotalPesos  = chartDaily.reduce((s: number, d: any) => s + Number(d.total    || 0), 0)
  const itemsTotalPesos  = chartDaily.reduce((s: number, d: any) => s + Number(d.items_net || 0), 0)
  const poolChartPesos   = chartDaily.reduce((s: number, d: any) => s + Number(d.pool     || 0), 0)

  const handleExport = () => {
    const catParam = categoryFilter !== 'ALL' ? `&category=${encodeURIComponent(categoryFilter)}` : ''
    window.open(`/api/v1/reports/export?type=${tab}&format=csv&from=${params.from}&to=${params.to}${catParam}`, '_blank')
  }

  const TABS = [
    { id: 'charts',        label: '📈 Gráficas' },
    { id: 'sales',         label: '🛒 Ventas' },
    { id: 'staff',         label: '👤 Personal' },
    { id: 'pool',          label: '🎱 Billar' },
    { id: 'payments',      label: '💳 Pagos' },
    { id: 'modifiers',     label: '🧂 Modificadores' },
    { id: 'voids',         label: '🚫 Anulaciones' },
    { id: 'peak-hours',    label: '⏰ Horas Pico' },
    { id: 'cigarettes',    label: '🚬 Cigarros' },
    { id: 'menu-deletions', label: '🍽️ Menú Eliminados' },
    { id: 'inv-deletions', label: '🗑 Inv. Eliminados' },
  ] as const

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-5xl mx-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">📊 Reportes</h1>
          <button onClick={handleExport} className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg text-sm">Exportar CSV</button>
        </div>

        {/* Date filters */}
        <div className="flex gap-4 mb-4">
          <div><label className="text-xs text-slate-400 block">Desde</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2" /></div>
          <div><label className="text-xs text-slate-400 block">Hasta</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2" /></div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => { setTab(t.id); setCategoryFilter('ALL') }}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${tab === t.id ? 'bg-sky-600' : 'bg-slate-800 hover:bg-slate-700'}`}>{t.label}</button>
          ))}
        </div>

        {/* Category filter — only on Sales tab */}
        {tab === 'sales' && categories.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            <span className="text-xs text-slate-400 mr-1">Category:</span>
            <button
              onClick={() => setCategoryFilter('ALL')}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${categoryFilter === 'ALL' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
              Todos
            </button>
            {categories.map(cat => (
              <button key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${categoryFilter === cat ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Sales */}
        {tab === 'sales' && sales && (
          <div className="space-y-2">
          <div className="bg-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-700">
                  <th className="p-3 text-left">Artículo</th>
                  <th className="p-3 text-left">Categoría</th>
                  <th className="p-3 text-right">Unidades</th>
                  <th className="p-3 text-right">Bruto</th>
                  <th className="p-3 text-right">Descuentos</th>
                </tr>
              </thead>
              <tbody>
                {filteredSales.map((r: any, i: number) => (
                  <tr key={i} className="border-t border-slate-700">
                    <td className="p-3">{r.item_name}</td>
                    <td className="p-3 text-slate-400">{r.category}</td>
                    <td className="p-3 text-right">{r.units_sold}</td>
                    <td className="p-3 text-right font-mono">{cents(r.gross_cents)}</td>
                    <td className="p-3 text-right text-green-400 font-mono">{cents(r.discounts_cents)}</td>
                  </tr>
                ))}
                {filteredSales.length === 0 && (
                  <tr><td colSpan={5} className="p-6 text-center text-slate-500">Sin ventas en este período{categoryFilter !== 'ALL' ? ` para "${categoryFilter}"` : ''}</td></tr>
                )}
              </tbody>
              {filteredSales.length > 0 && (
                <tfoot>
                  <tr className="bg-slate-700 font-bold border-t-2 border-slate-500">
                    <td className="p-3" colSpan={2}>
                      {categoryFilter !== 'ALL' ? `Total — ${categoryFilter}` : 'Total'}
                    </td>
                    <td className="p-3 text-right">{filteredTotals.units}</td>
                    <td className="p-3 text-right font-mono text-yellow-300">{cents(filteredTotals.gross)}</td>
                    <td className="p-3 text-right font-mono text-green-400">{cents(filteredTotals.discounts)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {grandTotalPesos > 0 && (
            <div className="flex justify-end">
              <div className="bg-slate-700/40 border border-slate-600 rounded-lg px-4 py-2 text-sm text-right">
                <span className="text-slate-400">Total general (Ventas + Billar):</span>
                <span className="ml-2 font-mono font-bold text-yellow-300">{formatMXNFromPesos(grandTotalPesos)}</span>
                <span className="ml-3 text-xs text-slate-500">• Billar: {formatMXNFromPesos(poolChartPesos)}</span>
              </div>
            </div>
          )}
          </div>
        )}

        {/* Staff Sales */}
        {tab === 'staff' && staff && (
          <div className="space-y-3">
            {(staff as any[]).length === 0 ? (
              <div className="text-center text-slate-500 py-12">Sin actividad de personal en este período</div>
            ) : (
              <>
                {(staff as any[]).map((r: any, i: number) => (
                  <div key={i} className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="font-bold text-white">{r.staff_name}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{ROLE_LABELS[r.role] ?? r.role}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xl font-bold text-green-400">{cents(r.total_sales_cents)}</div>
                        <div className="text-xs text-slate-400">{r.tickets_closed} tickets cerrados</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="bg-slate-700 rounded-lg p-2 text-center">
                        <div className="text-slate-400">Tickets Abiertos</div>
                        <div className="font-bold text-white mt-0.5">{r.tickets_opened}</div>
                      </div>
                      <div className="bg-slate-700 rounded-lg p-2 text-center">
                        <div className="text-slate-400">💵 Efectivo</div>
                        <div className="font-bold font-mono mt-0.5">{cents(r.cash_sales_cents)}</div>
                      </div>
                      <div className="bg-slate-700 rounded-lg p-2 text-center">
                        <div className="text-slate-400">💳 Tarjeta</div>
                        <div className="font-bold font-mono mt-0.5">{cents(r.card_sales_cents)}</div>
                      </div>
                    </div>
                    {(r.total_tips_cents || 0) > 0 && (
                      <div className="mt-2 text-xs text-amber-400 text-right">
                        Propinas recaudadas: {cents(r.total_tips_cents)}
                      </div>
                    )}
                  </div>
                ))}
                {/* Staff totals row */}
                {(() => {
                  const tot = {
                    tickets_opened:    (staff as any[]).reduce((s: number, r: any) => s + Number(r.tickets_opened    || 0), 0),
                    tickets_closed:    (staff as any[]).reduce((s: number, r: any) => s + Number(r.tickets_closed    || 0), 0),
                    total_sales_cents: (staff as any[]).reduce((s: number, r: any) => s + Number(r.total_sales_cents || 0), 0),
                    total_tips_cents:  (staff as any[]).reduce((s: number, r: any) => s + Number(r.total_tips_cents  || 0), 0),
                    cash_sales_cents:  (staff as any[]).reduce((s: number, r: any) => s + Number(r.cash_sales_cents  || 0), 0),
                    card_sales_cents:  (staff as any[]).reduce((s: number, r: any) => s + Number(r.card_sales_cents  || 0), 0),
                  }
                  return (
                    <div className="bg-slate-700 rounded-xl p-4 border-2 border-slate-500">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="font-bold text-slate-300 text-sm">Total del Período</div>
                          {grandTotalPesos > 0 && Math.abs(Math.round(grandTotalPesos * 100) - tot.total_sales_cents) > 10 && (
                            <div className="text-xs text-slate-500 mt-0.5">
                              Personal activo: {cents(tot.total_sales_cents)}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="text-xl font-bold text-yellow-300">
                            {grandTotalPesos > 0 ? formatMXNFromPesos(grandTotalPesos) : cents(tot.total_sales_cents)}
                          </div>
                          <div className="text-xs text-slate-400">{tot.tickets_closed} tickets cerrados</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div className="bg-slate-800 rounded-lg p-2 text-center">
                          <div className="text-slate-400">Tickets Abiertos</div>
                          <div className="font-bold text-white mt-0.5">{tot.tickets_opened}</div>
                        </div>
                        <div className="bg-slate-800 rounded-lg p-2 text-center">
                          <div className="text-slate-400">💵 Efectivo</div>
                          <div className="font-bold font-mono mt-0.5">{cents(tot.cash_sales_cents)}</div>
                        </div>
                        <div className="bg-slate-800 rounded-lg p-2 text-center">
                          <div className="text-slate-400">💳 Tarjeta</div>
                          <div className="font-bold font-mono mt-0.5">{cents(tot.card_sales_cents)}</div>
                        </div>
                      </div>
                      {tot.total_tips_cents > 0 && (
                        <div className="mt-2 text-xs text-amber-400 text-right">
                          Propinas totales: {cents(tot.total_tips_cents)}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        )}

        {/* Pool */}
        {tab === 'pool' && pool && (
          <div className="space-y-2">
            <div className="bg-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="bg-slate-700"><th className="p-3 text-left">Mesa</th><th className="p-3 text-right">Sesiones</th><th className="p-3 text-right">Minutos Totales</th><th className="p-3 text-right">Ingresos</th></tr></thead>
                <tbody>{(pool as any[]).map((r, i) => <tr key={i} className="border-t border-slate-700"><td className="p-3">{r.table_code}</td><td className="p-3 text-right">{r.sessions}</td><td className="p-3 text-right">{r.total_seconds ? Math.round(r.total_seconds / 60) : 0}m</td><td className="p-3 text-right font-mono text-yellow-300">{cents(r.revenue_cents)}</td></tr>)}</tbody>
                {(pool as any[]).length > 0 && (() => {
                  const totSessions = (pool as any[]).reduce((s: number, r: any) => s + Number(r.sessions || 0), 0)
                  const totSeconds  = (pool as any[]).reduce((s: number, r: any) => s + Number(r.total_seconds || 0), 0)
                  const totRevenue  = (pool as any[]).reduce((s: number, r: any) => s + Number(r.revenue_cents || 0), 0)
                  return (
                    <tfoot>
                      <tr className="bg-slate-700 font-bold border-t-2 border-slate-500">
                        <td className="p-3">Total</td>
                        <td className="p-3 text-right">{totSessions}</td>
                        <td className="p-3 text-right">{totSeconds ? Math.round(totSeconds / 60) : 0}m</td>
                        <td className="p-3 text-right font-mono text-yellow-300">{cents(totRevenue)}</td>
                      </tr>
                    </tfoot>
                  )
                })()}
              </table>
            </div>
            {grandTotalPesos > 0 && (
              <div className="flex justify-end">
                <div className="bg-slate-700/40 border border-slate-600 rounded-lg px-4 py-2 text-sm text-right">
                  <span className="text-slate-400">Total general (Billar + Ventas):</span>
                  <span className="ml-2 font-mono font-bold text-yellow-300">{formatMXNFromPesos(grandTotalPesos)}</span>
                  <span className="ml-3 text-xs text-slate-500">• Ventas: {formatMXNFromPesos(itemsTotalPesos)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Payments */}
        {tab === 'payments' && payments && (
          <div className="space-y-3">
            <div className="bg-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-700">
                    <th className="p-3 text-left">Método</th>
                    <th className="p-3 text-right">Tickets</th>
                    <th className="p-3 text-right">Ventas</th>
                    <th className="p-3 text-right">Propinas</th>
                  </tr>
                </thead>
                <tbody>
                  {(payments as any[]).map((r, i) => (
                    <tr key={i} className="border-t border-slate-700">
                      <td className="p-3 font-semibold">
                        {r.payment_type === 'CASH' ? '💵 Efectivo' : r.payment_type === 'CARD' ? '💳 Tarjeta' : r.payment_type}
                      </td>
                      <td className="p-3 text-right">{r.ticket_count}</td>
                      <td className="p-3 text-right font-mono text-yellow-300">{cents(r.total_cents)}</td>
                      <td className="p-3 text-right font-mono text-amber-400">{r.tips_cents ? cents(r.tips_cents) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                {(payments as any[]).length > 0 && (
                  <tfoot>
                    <tr className="bg-slate-700 font-bold border-t-2 border-slate-500">
                      <td className="p-3">Total</td>
                      <td className="p-3 text-right">{(payments as any[])[0]?.unique_tickets ?? (payments as any[]).reduce((s: number, r: any) => s + Number(r.ticket_count), 0)}</td>
                      <td className="p-3 text-right font-mono text-yellow-300">
                        {cents((payments as any[]).reduce((s: number, r: any) => s + Number(r.total_cents || 0), 0))}
                      </td>
                      <td className="p-3 text-right font-mono text-amber-400">
                        {cents((payments as any[]).reduce((s: number, r: any) => s + Number(r.tips_cents || 0), 0))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {/* Split payment summary badge */}
            {(() => {
              const splitCount = Math.max(...(payments as any[]).map((r: any) => Number(r.split_count) || 0))
              if (splitCount <= 0) return null
              const cashRow = (payments as any[]).find((r: any) => r.payment_type === 'CASH')
              const cardRow = (payments as any[]).find((r: any) => r.payment_type === 'CARD')
              return (
                <div className="bg-purple-900/30 border border-purple-700 rounded-xl px-4 py-3 flex items-center gap-3">
                  <span className="text-2xl">➕</span>
                  <div>
                    <div className="font-bold text-purple-300 text-sm">
                      {splitCount} ticket{splitCount !== 1 ? 's' : ''} con Pago Dividido (Efectivo + Tarjeta)
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {cashRow && <span className="mr-3">💵 Efectivo: <span className="font-mono text-yellow-300">{cents(cashRow.total_cents)}</span></span>}
                      {cardRow && <span>💳 Tarjeta: <span className="font-mono text-yellow-300">{cents(cardRow.total_cents)}</span></span>}
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>
        )}

        {/* Modifiers */}
        {tab === 'modifiers' && modifiers && (
          <div className="bg-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-700"><th className="p-3 text-left">Modifier</th><th className="p-3 text-left">Group</th><th className="p-3 text-right">Uses</th></tr></thead>
              <tbody>{(modifiers as any[]).map((r, i) => <tr key={i} className="border-t border-slate-700"><td className="p-3">{r.modifier_name}</td><td className="p-3 text-slate-400">{r.group_name}</td><td className="p-3 text-right">{r.usage_count}</td></tr>)}</tbody>
            </table>
          </div>
        )}

        {/* Voids */}
        {tab === 'voids' && (
          <div className="bg-slate-800 rounded-xl overflow-hidden">
            {(!voids || (voids as any[]).length === 0) ? (
              <div className="p-8 text-center text-slate-500">Sin artículos anulados en este período</div>
            ) : (
              <>
                <div className="px-4 py-3 bg-slate-700 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-200">
                    {(voids as any[]).length} artículo{(voids as any[]).length !== 1 ? 's' : ''} anulado{(voids as any[]).length !== 1 ? 's' : ''}
                  </span>
                  <span className="text-xs text-slate-400">
                    Total perdido: <span className="text-red-400 font-mono font-bold">
                      {cents((voids as any[]).reduce((s: number, r: any) => s + (r.unit_price_cents * r.quantity), 0))}
                    </span>
                  </span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-700 border-t border-slate-600">
                      <th className="p-3 text-left">Ticket</th>
                      <th className="p-3 text-left">Mesa</th>
                      <th className="p-3 text-left">Artículo</th>
                      <th className="p-3 text-left">Categoría</th>
                      <th className="p-3 text-right">Cant</th>
                      <th className="p-3 text-right">Valor</th>
                      <th className="p-3 text-left">Reason</th>
                      <th className="p-3 text-left">Voided By</th>
                      <th className="p-3 text-left">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(voids as any[]).map((r: any, i: number) => (
                      <tr key={i} className="border-t border-slate-700 hover:bg-slate-750">
                        <td className="p-3 font-mono text-xs text-slate-400">{r.ticket_id?.slice(0, 8)}…</td>
                        <td className="p-3 font-semibold text-yellow-300">{r.table_code || '—'}</td>
                        <td className="p-3">{r.item_name || '(unknown)'}</td>
                        <td className="p-3 text-slate-400 text-xs">{r.category || '—'}</td>
                        <td className="p-3 text-right">{r.quantity}</td>
                        <td className="p-3 text-right font-mono text-red-400">
                          {cents(r.unit_price_cents * r.quantity)}
                        </td>
                        <td className="p-3 text-orange-300 italic text-xs max-w-[180px]">
                          {r.reason || <span className="text-slate-500">—</span>}
                        </td>
                        <td className="p-3 text-slate-300 text-xs">{r.voided_by || '—'}</td>
                        <td className="p-3 text-slate-400 text-xs whitespace-nowrap">
                          {r.voided_at ? new Date(r.voided_at).toLocaleString('es-MX', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        {/* Peak Hours */}
        {tab === 'peak-hours' && (
          <div className="bg-slate-800 rounded-xl overflow-hidden">
            {(!peakHours || (peakHours as any[]).length === 0) ? (
              <div className="p-8 text-center text-slate-500">No data in this period</div>
            ) : (() => {
              const rows = peakHours as any[]
              const maxRevenue = Math.max(...rows.map((r: any) => Number(r.revenue_cents) || 0), 1)
              const fmt = (h: number) => {
                const suffix = h >= 12 ? 'PM' : 'AM'
                const h12 = h % 12 === 0 ? 12 : h % 12
                return `${h12}:00 ${suffix}`
              }
              return (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-700">
                      <th className="p-3 text-left">Hour</th>
                      <th className="p-3 text-right">Tickets</th>
                      <th className="p-3 text-right">Revenue</th>
                      <th className="p-3 text-right">Avg/Ticket</th>
                      <th className="p-3 w-32">Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: any, i: number) => {
                      const pct = Math.round((Number(r.revenue_cents) / maxRevenue) * 100)
                      const isTop = Number(r.revenue_cents) === maxRevenue
                      return (
                        <tr key={i} className={`border-t border-slate-700 ${isTop ? 'bg-yellow-900/20' : ''}`}>
                          <td className="p-3 font-semibold">{fmt(Number(r.hour))}{isTop && <span className="ml-2 text-xs text-yellow-400">⭐ PICO</span>}</td>
                          <td className="p-3 text-right">{r.ticket_count}</td>
                          <td className="p-3 text-right font-mono text-yellow-300">{cents(r.revenue_cents)}</td>
                          <td className="p-3 text-right font-mono text-slate-400">{cents(r.avg_ticket_cents)}</td>
                          <td className="p-3">
                            <div className="bg-slate-700 rounded-full h-3 w-full overflow-hidden">
                              <div className={`h-full rounded-full transition-all ${isTop ? 'bg-yellow-400' : 'bg-sky-600'}`} style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )
            })()}
          </div>
        )}

        {/* ── Gráficas ───────────────────────────────────────────────────── */}
        {tab === 'charts' && (() => {
          const PIE_COLORS = ['#38bdf8','#818cf8','#34d399','#fb923c','#f472b6','#a78bfa','#facc15','#4ade80']
          const daily   = (chartsData as any)?.daily_revenue  ?? []
          const topProds = (chartsData as any)?.top_products   ?? []
          const byCat    = (chartsData as any)?.by_category    ?? []
          const noData   = daily.length === 0 && topProds.length === 0

          if (noData) return (
            <div className="p-8 text-center text-slate-500">Sin datos en este período</div>
          )

          return (
            <div className="space-y-6">

              {/* Daily revenue line chart */}
              {daily.length > 0 && (
                <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4">
                  <h2 className="text-sm font-semibold text-slate-300 mb-4">💰 Ingresos diarios</h2>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={daily} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                      <YAxis tickFormatter={(v) => formatMXNFromPesos(v)} tick={{ fill: '#94a3b8', fontSize: 11 }} width={80} />
                      <Tooltip
                        contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                        labelStyle={{ color: '#cbd5e1' }}
                        formatter={(v: any) => formatMXNFromPesos(Number(v))}
                      />
                      <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                      <Line type="monotone" dataKey="items_net" name="Consumo" stroke="#38bdf8" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="pool"      name="Billar"  stroke="#818cf8" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="total"     name="Total"   stroke="#34d399" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Top products bar chart */}
              {topProds.length > 0 && (
                <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4">
                  <h2 className="text-sm font-semibold text-slate-300 mb-4">🏆 Productos más vendidos (unidades)</h2>
                  <ResponsiveContainer width="100%" height={Math.max(260, topProds.length * 30)}>
                    <BarChart data={topProds} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                      <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                      <YAxis type="category" dataKey="item_name" width={130} tick={{ fill: '#cbd5e1', fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                        labelStyle={{ color: '#cbd5e1' }}
                      />
                      <Bar dataKey="units_sold" name="Unidades vendidas" fill="#38bdf8" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Two-column: revenue by product (bar) + by category (pie) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                {topProds.length > 0 && (
                  <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4">
                    <h2 className="text-sm font-semibold text-slate-300 mb-4">💵 Ingresos por producto (Top 15)</h2>
                    <ResponsiveContainer width="100%" height={Math.max(260, topProds.length * 30)}>
                      <BarChart data={topProds} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                        <XAxis type="number" tickFormatter={(v) => formatMXNFromPesos(v)} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                        <YAxis type="category" dataKey="item_name" width={130} tick={{ fill: '#cbd5e1', fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                          labelStyle={{ color: '#cbd5e1' }}
                          formatter={(v: any) => formatMXNFromPesos(Number(v))}
                        />
                        <Bar dataKey="gross" name="Ingresos" fill="#818cf8" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {byCat.length > 0 && (
                  <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4">
                    <h2 className="text-sm font-semibold text-slate-300 mb-1">🍕 Ingresos por categoría</h2>
                    <p className="text-[10px] text-slate-500 mb-3">Sólo productos del menú — el ingreso de billar se grafica abajo.</p>
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie data={byCat} dataKey="gross" nameKey="category" cx="50%" cy="50%" outerRadius={90}
                          label={({ name, percent }) => `${name} ${percent != null ? (percent * 100).toFixed(0) : 0}%`}
                          labelLine={{ stroke: '#475569' }}
                        >
                          {byCat.map((_: any, idx: number) => (
                            <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                          formatter={(v: any) => formatMXNFromPesos(Number(v))}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {byCat.map((r: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-1 text-xs text-slate-400">
                          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PIE_COLORS[idx % PIE_COLORS.length] }} />
                          {r.category} — {formatMXNFromPesos(Number(r.gross))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Pool table income visualizations ─────────────────────── */}
              {(() => {
                const itemsTotal = daily.reduce((s: number, d: any) => s + Number(d.items_net || 0), 0)
                const poolTotal  = daily.reduce((s: number, d: any) => s + Number(d.pool || 0), 0)
                const grandTotal = itemsTotal + poolTotal
                const productsVsPool = [
                  { name: 'Productos / Bebidas', value: itemsTotal, color: '#38bdf8' },
                  { name: 'Mesas de Billar',     value: poolTotal,  color: '#a78bfa' },
                ].filter(d => d.value > 0)
                const poolRows = (pool as any[] | undefined) ?? []
                const poolBars = poolRows.map((r: any) => ({
                  table_code: r.table_code,
                  revenue: (Number(r.revenue_cents) || 0) / 100,
                  minutes: Math.round((Number(r.total_seconds) || 0) / 60),
                  sessions: Number(r.sessions) || 0,
                }))
                const noPoolData = grandTotal <= 0 && poolBars.length === 0
                if (noPoolData) return null

                return (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                    {/* Productos vs Billar */}
                    {productsVsPool.length > 0 && (
                      <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4">
                        <h2 className="text-sm font-semibold text-slate-300 mb-1">💰 Ingresos: Productos vs Billar</h2>
                        <p className="text-[10px] text-slate-500 mb-3">
                          Total: {formatMXNFromPesos(grandTotal)}
                          {' · '}Billar: {formatMXNFromPesos(poolTotal)}
                          {' '}({grandTotal > 0 ? `${Math.round((poolTotal / grandTotal) * 100)}%` : '0%'})
                        </p>
                        <ResponsiveContainer width="100%" height={260}>
                          <PieChart>
                            <Pie
                              data={productsVsPool}
                              dataKey="value"
                              nameKey="name"
                              cx="50%" cy="50%" outerRadius={90}
                              label={({ name, percent }) => `${name} ${percent != null ? (percent * 100).toFixed(0) : 0}%`}
                              labelLine={{ stroke: '#475569' }}
                            >
                              {productsVsPool.map((d, idx) => <Cell key={idx} fill={d.color} />)}
                            </Pie>
                            <Tooltip
                              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                              formatter={(v: any) => formatMXNFromPesos(Number(v))}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* Per-pool-table bar */}
                    {poolBars.length > 0 && (
                      <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4">
                        <h2 className="text-sm font-semibold text-slate-300 mb-1">🎱 Ingresos por Mesa de Billar</h2>
                        <p className="text-[10px] text-slate-500 mb-3">
                          Top: <span className="text-amber-300 font-semibold">{poolBars[0]?.table_code}</span>
                          {' · '}{formatMXNFromPesos(poolBars[0]?.revenue || 0)}
                        </p>
                        <ResponsiveContainer width="100%" height={Math.max(220, poolBars.length * 36)}>
                          <BarChart data={poolBars} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                            <XAxis type="number" tickFormatter={(v) => formatMXNFromPesos(v)} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                            <YAxis type="category" dataKey="table_code" width={60} tick={{ fill: '#cbd5e1', fontSize: 11 }} />
                            <Tooltip
                              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                              labelStyle={{ color: '#cbd5e1' }}
                              formatter={(v: any, name: any, props: any) => {
                                if (name === 'revenue') return [formatMXNFromPesos(Number(v)), 'Ingresos']
                                return [v, name]
                              }}
                              labelFormatter={(label: any, payload: any) => {
                                const row = payload?.[0]?.payload
                                if (!row) return label
                                return `${row.table_code} — ${row.minutes} min · ${row.sessions} sesiones`
                              }}
                            />
                            <Bar dataKey="revenue" name="revenue" fill="#a78bfa" radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )
        })()}


        {tab === 'menu-deletions' && (
          <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden">
            {(!menuDeletions || (menuDeletions as any[]).length === 0) ? (
              <div className="p-8 text-center text-slate-500">Sin eliminaciones de menú en este período</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-700/50">
                  <tr className="text-xs text-slate-400">
                    <th className="text-left p-3">Fecha</th>
                    <th className="text-left p-3">Artículo</th>
                    <th className="text-left p-3">Categoría</th>
                    <th className="text-right p-3">Precio</th>
                    <th className="text-left p-3">Eliminado por</th>
                    <th className="text-left p-3">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {(menuDeletions as any[]).map((r: any, i: number) => (
                    <tr key={i} className="border-t border-slate-700 hover:bg-slate-700/30">
                      <td className="p-3 text-slate-400 text-xs">{r.deleted_at ? new Date(r.deleted_at).toLocaleString('es-MX') : '—'}</td>
                      <td className="p-3 font-medium">{r.item_name}</td>
                      <td className="p-3 text-slate-400">{r.category}</td>
                      <td className="p-3 text-right font-mono text-yellow-300">{cents(r.price_cents)}</td>
                      <td className="p-3 text-slate-300">{r.deleted_by}</td>
                      <td className="p-3 text-slate-400 text-xs italic">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-700/30">
                  <tr>
                    <td colSpan={6} className="p-3 text-xs text-slate-400">
                      {(menuDeletions as any[]).length} artículo{(menuDeletions as any[]).length !== 1 ? 's' : ''} eliminado{(menuDeletions as any[]).length !== 1 ? 's' : ''} del menú en este período
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}

        {tab === 'inv-deletions' && (
          <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden">
            {(!invDeletions || (invDeletions as any[]).length === 0) ? (
              <div className="p-8 text-center text-slate-500">Sin eliminaciones de inventario en este período</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-700/50">
                  <tr className="text-xs text-slate-400">
                    <th className="text-left p-3">Fecha</th>
                    <th className="text-left p-3">Artículo</th>
                    <th className="text-left p-3">Categoría</th>
                    <th className="text-right p-3">Últ. Stock</th>
                    <th className="text-left p-3">Unidad</th>
                    <th className="text-left p-3">Eliminado por</th>
                    <th className="text-left p-3">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {(invDeletions as any[]).map((r: any, i: number) => (
                    <tr key={i} className="border-t border-slate-700 hover:bg-slate-700/30">
                      <td className="p-3 text-xs text-slate-400 whitespace-nowrap">
                        {new Date(r.deleted_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className="p-3 font-medium text-red-300">{r.item_name}</td>
                      <td className="p-3 text-slate-400 capitalize">{r.item_category}</td>
                      <td className="p-3 text-right font-mono">{r.last_quantity}</td>
                      <td className="p-3 text-slate-400">{r.item_unit}</td>
                      <td className="p-3 text-slate-300">{r.deleted_by}</td>
                      <td className="p-3 text-xs text-slate-500 max-w-[200px] truncate">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-700/30">
                  <tr>
                    <td colSpan={7} className="p-3 text-xs text-slate-400">
                      {(invDeletions as any[]).length} artículo{(invDeletions as any[]).length !== 1 ? 's' : ''} eliminado{(invDeletions as any[]).length !== 1 ? 's' : ''} en este período
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}

        {tab === 'cigarettes' && (
          <div className="space-y-6">
            {/* Summary cards */}
            {cigData && (
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-800 rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold text-yellow-300">{cents((cigData as any).totals?.gross_cents ?? 0)}</div>
                  <div className="text-xs text-slate-400 mt-1">Ingresos Cigarros</div>
                </div>
                <div className="bg-slate-800 rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold text-sky-300">{(cigData as any).totals?.units_sold ?? 0}</div>
                  <div className="text-xs text-slate-400 mt-1">Cigarros Vendidos</div>
                </div>
                <div className="bg-slate-800 rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold text-emerald-300">{(cigData as any).totals?.boxes_opened ?? 0}</div>
                  <div className="text-xs text-slate-400 mt-1">Cajas Abiertas</div>
                </div>
              </div>
            )}

            {/* Sales by item */}
            <div className="bg-slate-800 rounded-xl overflow-hidden">
              <div className="p-3 bg-slate-700/50 font-semibold text-sm">🚬 Ventas por Producto</div>
              {!cigData || (cigData as any).sales?.length === 0 ? (
                <p className="p-6 text-center text-slate-500">Sin ventas de cigarros en este período</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-400 uppercase bg-slate-700/30">
                    <tr>
                      <th className="p-3 text-left">Producto</th>
                      <th className="p-3 text-right">Precio Unitario</th>
                      <th className="p-3 text-right">Unidades</th>
                      <th className="p-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {((cigData as any).sales as any[]).map((r: any, i: number) => (
                      <tr key={i} className="border-t border-slate-700">
                        <td className="p-3">{r.item_name}</td>
                        <td className="p-3 text-right text-slate-400">{cents(r.unit_price_cents)}</td>
                        <td className="p-3 text-right">{r.units_sold}</td>
                        <td className="p-3 text-right font-mono text-yellow-300">{cents(r.gross_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-700/30">
                    <tr>
                      <td colSpan={2} className="p-3 text-xs text-slate-400 font-semibold">Total</td>
                      <td className="p-3 text-right font-bold">{(cigData as any).totals?.units_sold ?? 0}</td>
                      <td className="p-3 text-right font-bold text-yellow-300">{cents((cigData as any).totals?.gross_cents ?? 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>

            {/* Box tracking */}
            <div className="bg-slate-800 rounded-xl overflow-hidden">
              <div className="p-3 bg-slate-700/50 font-semibold text-sm">📦 Cajas Abiertas</div>
              {!cigData || (cigData as any).boxes?.length === 0 ? (
                <p className="p-6 text-center text-slate-500">Sin cajas abiertas en este período</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-400 uppercase bg-slate-700/30">
                    <tr>
                      <th className="p-3 text-left">Marca</th>
                      <th className="p-3 text-right">Cajas</th>
                      <th className="p-3 text-right">Cigarros Agregados</th>
                      <th className="p-3 text-right">Cigarros Vendidos</th>
                      <th className="p-3 text-right">En Inventario</th>
                      <th className="p-3 text-right">Cajas Terminadas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {((cigData as any).boxes as any[]).map((r: any, i: number) => (
                      <tr key={i} className="border-t border-slate-700">
                        <td className="p-3">{r.brand}</td>
                        <td className="p-3 text-right">{r.boxes_opened}</td>
                        <td className="p-3 text-right text-sky-300">{r.total_cigs_added}</td>
                        <td className="p-3 text-right text-yellow-300">{r.total_cigs_sold ?? 0}</td>
                        <td className="p-3 text-right text-emerald-300">{r.cigs_remaining ?? 0}</td>
                        <td className="p-3 text-right text-slate-400">{r.boxes_finished}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}




      </div>
    </div>
  )
}

