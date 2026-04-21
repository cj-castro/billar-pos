import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import client from '../../api/client'

function cents(n: number | null) { return n != null ? `$${(n / 100).toFixed(2)}` : '-' }

const ROLE_LABELS: Record<string, string> = {
  WAITER: '🏃 Waiter', BAR_STAFF: '🍹 Bar', KITCHEN_STAFF: '🍳 Kitchen',
  MANAGER: '👔 Manager', ADMIN: '🔑 Admin',
}

export default function ReportsPage() {
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [tab, setTab] = useState<'sales' | 'pool' | 'payments' | 'modifiers' | 'staff' | 'voids' | 'peak-hours'>('sales')
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL')

  const params = { from: `${from}T00:00:00`, to: `${to}T23:59:59` }

  const { data: sales } = useQuery({ queryKey: ['report-sales', from, to], queryFn: () => client.get('/reports/sales', { params }).then(r => r.data), enabled: tab === 'sales' })
  const { data: pool } = useQuery({ queryKey: ['report-pool', from, to], queryFn: () => client.get('/reports/pool-time', { params }).then(r => r.data), enabled: tab === 'pool' })
  const { data: payments } = useQuery({ queryKey: ['report-payments', from, to], queryFn: () => client.get('/reports/payments', { params }).then(r => r.data), enabled: tab === 'payments' })
  const { data: modifiers } = useQuery({ queryKey: ['report-modifiers', from, to], queryFn: () => client.get('/reports/modifiers', { params }).then(r => r.data), enabled: tab === 'modifiers' })
  const { data: staff } = useQuery({ queryKey: ['report-staff', from, to], queryFn: () => client.get('/reports/staff', { params }).then(r => r.data), enabled: tab === 'staff' })
  const { data: voids } = useQuery({ queryKey: ['report-voids', from, to], queryFn: () => client.get('/reports/voids', { params }).then(r => r.data), enabled: tab === 'voids' })
  const { data: peakHours } = useQuery({ queryKey: ['report-peak-hours', from, to], queryFn: () => client.get('/reports/peak-hours', { params }).then(r => r.data), enabled: tab === 'peak-hours' })

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

  const handleExport = () => {
    const catParam = categoryFilter !== 'ALL' ? `&category=${encodeURIComponent(categoryFilter)}` : ''
    window.open(`/api/v1/reports/export?type=${tab}&format=csv&from=${params.from}&to=${params.to}${catParam}`, '_blank')
  }

  const TABS = [
    { id: 'sales', label: '🛒 Sales' },
    { id: 'staff', label: '👤 Staff' },
    { id: 'pool', label: '🎱 Pool' },
    { id: 'payments', label: '💳 Payments' },
    { id: 'modifiers', label: '🧂 Modifiers' },
    { id: 'voids', label: '🚫 Voids' },
    { id: 'peak-hours', label: '⏰ Peak Hours' },
  ] as const

  return (
    <div className="min-h-screen bg-slate-950">
      <NavBar />
      <div className="max-w-5xl mx-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">📊 Reports</h1>
          <button onClick={handleExport} className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg text-sm">Export CSV</button>
        </div>

        {/* Date filters */}
        <div className="flex gap-4 mb-4">
          <div><label className="text-xs text-slate-400 block">From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2" /></div>
          <div><label className="text-xs text-slate-400 block">To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2" /></div>
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
              All
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
          <div className="bg-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-700">
                  <th className="p-3 text-left">Item</th>
                  <th className="p-3 text-left">Category</th>
                  <th className="p-3 text-right">Units</th>
                  <th className="p-3 text-right">Gross</th>
                  <th className="p-3 text-right">Discounts</th>
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
                  <tr><td colSpan={5} className="p-6 text-center text-slate-500">No sales in this period{categoryFilter !== 'ALL' ? ` for "${categoryFilter}"` : ''}</td></tr>
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
        )}

        {/* Staff Sales */}
        {tab === 'staff' && staff && (
          <div className="space-y-3">
            {(staff as any[]).length === 0 ? (
              <div className="text-center text-slate-500 py-12">No staff activity in this period</div>
            ) : (staff as any[]).map((r: any, i: number) => (
              <div key={i} className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-bold text-white">{r.staff_name}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{ROLE_LABELS[r.role] ?? r.role}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-green-400">{cents(r.total_sales_cents)}</div>
                    <div className="text-xs text-slate-400">{r.tickets_closed} tickets closed</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="bg-slate-700 rounded-lg p-2 text-center">
                    <div className="text-slate-400">Tickets Opened</div>
                    <div className="font-bold text-white mt-0.5">{r.tickets_opened}</div>
                  </div>
                  <div className="bg-slate-700 rounded-lg p-2 text-center">
                    <div className="text-slate-400">💵 Cash</div>
                    <div className="font-bold font-mono mt-0.5">{cents(r.cash_sales_cents)}</div>
                  </div>
                  <div className="bg-slate-700 rounded-lg p-2 text-center">
                    <div className="text-slate-400">💳 Card</div>
                    <div className="font-bold font-mono mt-0.5">{cents(r.card_sales_cents)}</div>
                  </div>
                </div>
                {(r.total_tips_cents || 0) > 0 && (
                  <div className="mt-2 text-xs text-amber-400 text-right">
                    Tips collected: {cents(r.total_tips_cents)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Pool */}
        {tab === 'pool' && pool && (
          <div className="bg-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-700"><th className="p-3 text-left">Table</th><th className="p-3 text-right">Sessions</th><th className="p-3 text-right">Total Minutes</th><th className="p-3 text-right">Revenue</th></tr></thead>
              <tbody>{(pool as any[]).map((r, i) => <tr key={i} className="border-t border-slate-700"><td className="p-3">{r.table_code}</td><td className="p-3 text-right">{r.sessions}</td><td className="p-3 text-right">{r.total_seconds ? Math.round(r.total_seconds / 60) : 0}m</td><td className="p-3 text-right font-mono text-yellow-300">{cents(r.revenue_cents)}</td></tr>)}</tbody>
            </table>
          </div>
        )}

        {/* Payments */}
        {tab === 'payments' && payments && (
          <div className="space-y-3">
            <div className="bg-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-700">
                    <th className="p-3 text-left">Method</th>
                    <th className="p-3 text-right">Tickets</th>
                    <th className="p-3 text-right">Sales</th>
                    <th className="p-3 text-right">Tips</th>
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
                      <td className="p-3 text-right">{(payments as any[]).reduce((s: number, r: any) => s + Number(r.ticket_count), 0)}</td>
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
              <div className="p-8 text-center text-slate-500">No voided items in this period</div>
            ) : (
              <>
                <div className="px-4 py-3 bg-slate-700 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-200">
                    {(voids as any[]).length} voided item{(voids as any[]).length !== 1 ? 's' : ''}
                  </span>
                  <span className="text-xs text-slate-400">
                    Total lost: <span className="text-red-400 font-mono font-bold">
                      {cents((voids as any[]).reduce((s: number, r: any) => s + (r.unit_price_cents * r.quantity), 0))}
                    </span>
                  </span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-700 border-t border-slate-600">
                      <th className="p-3 text-left">Ticket</th>
                      <th className="p-3 text-left">Table</th>
                      <th className="p-3 text-left">Item</th>
                      <th className="p-3 text-left">Category</th>
                      <th className="p-3 text-right">Qty</th>
                      <th className="p-3 text-right">Value</th>
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
                          <td className="p-3 font-semibold">{fmt(Number(r.hour))}{isTop && <span className="ml-2 text-xs text-yellow-400">⭐ PEAK</span>}</td>
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

      </div>
    </div>
  )
}

