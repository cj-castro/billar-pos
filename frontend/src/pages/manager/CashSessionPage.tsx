import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { printCashReconciliation, printTipDistribution, type ReconSummary } from '../../utils/printCashReconciliation'

function cents(n: number) { return `$${((n ?? 0) / 100).toFixed(2)}` }
function diff(n: number) {
  const abs = Math.abs(n)
  return n >= 0 ? `+$${(abs / 100).toFixed(2)}` : `-$${(abs / 100).toFixed(2)}`
}

export default function CashSessionPage() {
  const qc = useQueryClient()
  const [openingFund, setOpeningFund] = useState('')
  const [closingCash, setClosingCash] = useState('')
  const [closeNotes, setCloseNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<'summary' | 'tickets' | 'expenses' | 'tips'>('summary')
  const [viewingSession, setViewingSession] = useState<any>(null)
  const [viewingSummary, setViewingSummary] = useState<any>(null)
  const [loadingSession, setLoadingSession] = useState(false)

  // Expense form
  const [expAmount, setExpAmount] = useState('')
  const [expMethod, setExpMethod] = useState<'CASH' | 'CARD'>('CASH')
  const [expPayee, setExpPayee] = useState('')
  const [expDesc, setExpDesc] = useState('')
  const [savingExp, setSavingExp] = useState(false)

  // Tip distribution edit
  const [editingTips, setEditingTips] = useState(false)
  const [tipFloor, setTipFloor] = useState('')
  const [tipBar, setTipBar] = useState('')
  const [tipKitchen, setTipKitchen] = useState('')
  const [savingTips, setSavingTips] = useState(false)

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ['cash-status'],
    queryFn: () => client.get('/cash/status').then(r => r.data),
    refetchInterval: 15000,
  })

  const { data: summary, refetch: refetchSummary } = useQuery({
    queryKey: ['cash-summary'],
    queryFn: () => client.get('/cash/current/summary').then(r => r.data),
    enabled: status?.open === true,
    retry: false,
    refetchInterval: 30000,
  })

  const { data: expenses = [], refetch: refetchExpenses } = useQuery({
    queryKey: ['cash-expenses'],
    queryFn: () => client.get('/cash/current/expenses').then(r => r.data),
    enabled: status?.open === true,
  })

  const { data: sessionTickets = [] } = useQuery({
    queryKey: ['cash-tickets'],
    queryFn: () => client.get('/cash/current/tickets').then(r => r.data),
    enabled: status?.open === true && activeTab === 'tickets',
  })

  const { data: tipCfg, refetch: refetchTipCfg } = useQuery({
    queryKey: ['tip-distribution'],
    queryFn: () => client.get('/cash/tip-distribution').then(r => r.data),
  })

  const { data: sessions = [] } = useQuery({
    queryKey: ['cash-sessions'],
    queryFn: () => client.get('/cash/sessions').then(r => r.data),
  })

  const refetchAll = () => {
    refetchStatus(); refetchSummary(); refetchExpenses(); refetchTipCfg()
    qc.invalidateQueries({ queryKey: ['cash-status'] })
  }

  const handleOpen = async () => {
    if (!openingFund) return toast.error('Enter opening fund amount')
    setSaving(true)
    try {
      await client.post('/cash/open', { opening_fund_cents: Math.round(parseFloat(openingFund) * 100) })
      toast.success('Bar opened! Cash session started.')
      setOpeningFund('')
      refetchAll()
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to open session')
    } finally { setSaving(false) }
  }

  const handleClose = async () => {
    if (!closingCash) return toast.error('Enter closing cash count')
    if (!confirm('Close the bar and finalize the cash session?')) return
    setSaving(true)
    try {
      const res = await client.post('/cash/close', {
        closing_cash_counted_cents: Math.round(parseFloat(closingCash) * 100),
        notes: closeNotes || undefined,
      })
      toast.success('Bar closed. Session finalized.')
      setClosingCash('')
      setCloseNotes('')
      refetchAll()
      // Auto-print reconciliation + tip distribution
      if (res.data?.summary) {
        const sess = status?.session
        const dateStr = sess?.date || new Date().toLocaleDateString()
        printCashReconciliation(res.data.summary as ReconSummary, dateStr, new Date().toLocaleTimeString())
        if (res.data.summary.total_tips_cents > 0) {
          setTimeout(() => printTipDistribution(res.data.summary as ReconSummary, dateStr), 800)
        }
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to close session')
    } finally { setSaving(false) }
  }

  const handleAddExpense = async () => {
    if (!expAmount || !expPayee || !expDesc) return toast.error('All expense fields required')
    setSavingExp(true)
    try {
      await client.post('/cash/current/expenses', {
        amount_cents: Math.round(parseFloat(expAmount) * 100),
        payment_method: expMethod,
        payee: expPayee,
        description: expDesc,
      })
      toast.success('Expense added')
      setExpAmount(''); setExpPayee(''); setExpDesc('')
      refetchExpenses(); refetchSummary()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed')
    } finally { setSavingExp(false) }
  }

  const handleDeleteExpense = async (id: string) => {
    if (!confirm('Delete this expense?')) return
    await client.delete(`/cash/expenses/${id}`)
    refetchExpenses(); refetchSummary()
  }

  const handleSaveTipConfig = async () => {
    const floor = parseInt(tipFloor) || 0
    const bar = parseInt(tipBar) || 0
    const kitchen = parseInt(tipKitchen) || 0
    if (floor + bar + kitchen !== 100) return toast.error('Percentages must add up to 100%')
    setSavingTips(true)
    try {
      await client.put('/cash/tip-distribution', { floor_pct: floor, bar_pct: bar, kitchen_pct: kitchen })
      toast.success('Tip distribution saved')
      setEditingTips(false)
      refetchTipCfg(); refetchSummary()
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save')
    } finally { setSavingTips(false) }
  }

  const handleReopenTicket = async (ticketId: string, label: string) => {
    if (!confirm(`Re-open ticket ${label}? This will make it editable again.`)) return
    try {
      await client.post(`/tickets/${ticketId}/reopen`)
      toast.success('Ticket re-opened')
      qc.invalidateQueries({ queryKey: ['cash-tickets'] })
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to re-open')
    }
  }

  const handlePrintReconciliation = () => {
    if (!s) return
    const dateStr = status?.session?.date || new Date().toLocaleDateString()
    printCashReconciliation(s as ReconSummary, dateStr)
  }

  const handlePrintTipSheet = () => {
    if (!s) return
    printTipDistribution(s as ReconSummary, status?.session?.date || new Date().toLocaleDateString())
  }

  const startEditTips = () => {
    if (!tipCfg) return
    setTipFloor(String(tipCfg.floor_pct))
    setTipBar(String(tipCfg.bar_pct))
    setTipKitchen(String(tipCfg.kitchen_pct))
    setEditingTips(true)
  }

  const s = summary?.summary
  const tipTotal = tipFloor && tipBar && tipKitchen
    ? parseInt(tipFloor || '0') + parseInt(tipBar || '0') + parseInt(tipKitchen || '0')
    : null

  const TABS = [
    { id: 'summary', label: '📊 Summary' },
    { id: 'tickets', label: `🧾 Tickets` },
    { id: 'expenses', label: '💸 Expenses' },
    { id: 'tips', label: '💝 Tips Config' },
  ] as const

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <NavBar />
      <div className="max-w-3xl mx-auto p-4">
        <div className="sticky top-0 z-10 bg-slate-950 flex items-center justify-between py-3 mb-4 border-b border-slate-800">
          <h1 className="text-xl font-bold">💰 Cash Session</h1>
          <div className={`px-3 py-1 rounded-full text-sm font-bold ${status?.open ? 'bg-green-700 text-green-200' : 'bg-red-800 text-red-200'}`}>
            {status?.open ? '🟢 Bar Open' : '🔴 Bar Closed'}
          </div>
        </div>

        {/* ── BAR CLOSED: Open Session ── */}
        {!status?.open && (
          <div className="bg-slate-800 rounded-2xl p-6 mb-6 border border-slate-700">
            <h2 className="text-lg font-bold mb-1">Open Bar / Start Cash Session</h2>
            <p className="text-slate-400 text-sm mb-4">Count the starting fund in the register before opening.</p>
            <label className="text-xs text-slate-400 block mb-1">Opening Fund (starting cash in register)</label>
            <div className="flex gap-3">
              <input type="number" value={openingFund} onChange={e => setOpeningFund(e.target.value)}
                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 text-lg font-mono"
                placeholder="0.00" />
              <button onClick={handleOpen} disabled={saving}
                className="bg-green-600 hover:bg-green-500 px-6 py-3 rounded-xl font-bold disabled:opacity-50">
                {saving ? 'Opening…' : 'Open Bar'}
              </button>
            </div>
          </div>
        )}

        {/* ── BAR OPEN: Tabs ── */}
        {status?.open && s && (
          <>
            {/* Tab bar */}
            <div className="flex gap-1 mb-4 bg-slate-800 rounded-xl p-1">
              {TABS.map(t => (
                <button key={t.id} onClick={() => setActiveTab(t.id)}
                  className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition-colors ${activeTab === t.id ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* ── SUMMARY TAB ── */}
            {activeTab === 'summary' && (
              <>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">Total Sales</div>
                    <div className="text-2xl font-bold text-green-400">{cents(s.total_sales_cents)}</div>
                    <div className="text-xs text-slate-500 mt-1">{s.ticket_count} tickets</div>
                  </div>
                  <div className="bg-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">Total Tips</div>
                    <div className="text-2xl font-bold text-amber-400">{cents(s.total_tips_cents)}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      Cash {cents(s.cash_tips_cents)} · Card {cents(s.card_tips_cents)}
                    </div>
                  </div>
                  <div className="bg-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">💵 Cash Sales</div>
                    <div className="text-xl font-bold">{cents(s.cash_sales_cents)}</div>
                  </div>
                  <div className="bg-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">💳 Card Sales</div>
                    <div className="text-xl font-bold">{cents(s.card_sales_cents)}</div>
                  </div>
                  <div className="bg-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">Expenses</div>
                    <div className="text-xl font-bold text-red-400">-{cents(s.total_expenses_cents)}</div>
                    <div className="text-xs text-slate-500 mt-1">Cash -{cents(s.cash_expenses_cents)} · Card -{cents(s.card_expenses_cents)}</div>
                  </div>
                  <div className="bg-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">Expected Cash in Register</div>
                    <div className="text-xl font-bold text-sky-400">{cents(s.expected_cash_cents)}</div>
                    <div className="text-xs text-slate-500 mt-1">Fund {cents(s.opening_fund_cents)} + cash sales + tips − expenses</div>
                  </div>
                </div>

                {/* Print buttons */}
                <div className="flex gap-3 mb-4">
                  <button onClick={handlePrintReconciliation}
                    className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-semibold">
                    🖨 Print Reconciliation
                  </button>
                  {s.total_tips_cents > 0 && (
                    <button onClick={handlePrintTipSheet}
                      className="flex-1 py-2 bg-amber-700 hover:bg-amber-600 rounded-xl text-sm font-semibold">
                      💝 Print Tip Sheet
                    </button>
                  )}
                </div>

                {/* ── Close Bar ── */}
                <div className="bg-slate-800 rounded-2xl p-5 border border-red-900 mb-8">
                  <h2 className="font-bold text-red-300 mb-1">🔒 Close Bar / End Cash Session</h2>
                  <p className="text-slate-400 text-sm mb-4">Count the cash in the register at closing time.</p>
                  <label className="text-xs text-slate-400 block mb-1">Actual Cash Counted in Register</label>
                  <input type="number" value={closingCash} onChange={e => setClosingCash(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 text-lg font-mono mb-3"
                    placeholder="0.00" />
                  {closingCash && s && (
                    <div className={`rounded-lg px-4 py-3 mb-3 text-sm font-bold ${
                      Math.round(parseFloat(closingCash) * 100) >= s.expected_cash_cents
                        ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
                    }`}>
                      Over/Short: {diff(Math.round(parseFloat(closingCash) * 100) - s.expected_cash_cents)}
                    </div>
                  )}
                  <label className="text-xs text-slate-400 block mb-1">Notes (optional)</label>
                  <textarea value={closeNotes} onChange={e => setCloseNotes(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm mb-3" rows={2}
                    placeholder="Any notes for closing..." />
                  <button onClick={handleClose} disabled={saving || !closingCash}
                    className="w-full py-3 bg-red-700 hover:bg-red-600 rounded-xl font-bold text-lg disabled:opacity-50">
                    {saving ? 'Closing…' : '🔒 Close Bar'}
                  </button>
                  <p className="text-xs text-slate-500 mt-2 text-center">
                    Reconciliation + tip distribution will auto-print on close
                  </p>
                </div>
              </>
            )}

            {/* ── TICKETS TAB ── */}
            {activeTab === 'tickets' && (
              <div>
                <div className="text-sm text-slate-400 mb-3">
                  {(sessionTickets as any[]).length} closed tickets this session
                  {' '}· click a ticket to re-open it
                </div>
                {(sessionTickets as any[]).length === 0 ? (
                  <div className="text-center text-slate-500 py-12">No closed tickets yet</div>
                ) : (
                  <div className="space-y-2">
                    {(sessionTickets as any[]).map((t: any) => (
                      <div key={t.id} className="bg-slate-800 rounded-xl flex items-center justify-between px-4 py-3 border border-slate-700">
                        <div>
                          <div className="font-semibold text-sm flex items-center gap-2">
                            {t.customer_name || '(no name)'}
                            {t.was_reopened && <span className="bg-orange-800 text-orange-200 text-xs px-1.5 py-0.5 rounded">RE-OPENED</span>}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {t.resource_code || '—'} · {t.payment_type}
                            {' · '}{t.closed_at ? new Date(t.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <div className="font-bold text-green-400">{cents(t.total_cents)}</div>
                            {(t.tip_cents || 0) > 0 && (
                              <div className="text-xs text-amber-400">+{cents(t.tip_cents)} tip</div>
                            )}
                          </div>
                          <button
                            onClick={() => handleReopenTicket(t.id, `${t.customer_name || t.resource_code}`)}
                            className="text-xs bg-orange-700 hover:bg-orange-600 px-3 py-1.5 rounded-lg font-semibold">
                            Re-open
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── EXPENSES TAB ── */}
            {activeTab === 'expenses' && (
              <>
                <div className="bg-slate-800 rounded-2xl p-5 mb-4 border border-slate-700">
                  <h2 className="font-bold mb-3">➕ Add Expense</h2>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Amount</label>
                      <input type="number" value={expAmount} onChange={e => setExpAmount(e.target.value)}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono"
                        placeholder="0.00" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Payment Method</label>
                      <div className="flex gap-2">
                        {(['CASH', 'CARD'] as const).map(m => (
                          <button key={m} onClick={() => setExpMethod(m)}
                            className={`flex-1 py-2 rounded-lg text-sm font-bold border-2 ${expMethod === m ? 'bg-sky-600 border-sky-400' : 'bg-slate-700 border-slate-600'}`}>
                            {m === 'CASH' ? '💵' : '💳'} {m}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Payee / To whom</label>
                      <input value={expPayee} onChange={e => setExpPayee(e.target.value)}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                        placeholder="e.g. Beer supplier" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Description</label>
                      <input value={expDesc} onChange={e => setExpDesc(e.target.value)}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                        placeholder="e.g. Beer restock" />
                    </div>
                  </div>
                  <button onClick={handleAddExpense} disabled={savingExp}
                    className="w-full py-2 bg-red-700 hover:bg-red-600 rounded-xl font-bold disabled:opacity-50">
                    {savingExp ? 'Adding…' : 'Record Expense'}
                  </button>
                </div>

                {(expenses as any[]).length === 0 ? (
                  <div className="text-center text-slate-500 py-8">No expenses recorded</div>
                ) : (
                  <div className="bg-slate-800 rounded-2xl overflow-hidden border border-slate-700">
                    <div className="px-4 py-3 border-b border-slate-700 font-semibold text-sm">Today's Expenses</div>
                    {(expenses as any[]).map((e: any) => (
                      <div key={e.id} className="flex items-center justify-between px-4 py-3 border-b border-slate-700 last:border-0">
                        <div>
                          <div className="font-medium text-sm">{e.payee}</div>
                          <div className="text-xs text-slate-400">{e.description} · {e.payment_method}</div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-red-400 font-bold">-{cents(e.amount_cents)}</span>
                          <button onClick={() => handleDeleteExpense(e.id)} className="text-slate-500 hover:text-red-400 text-sm">✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ── TIPS CONFIG TAB ── */}
            {activeTab === 'tips' && (
              <div>
                <div className="bg-slate-800 rounded-2xl p-5 mb-4 border border-slate-700">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-bold">💝 Tip Distribution Config</h2>
                    {!editingTips && (
                      <button onClick={startEditTips}
                        className="text-sm bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg">
                        Edit
                      </button>
                    )}
                  </div>

                  {!editingTips && tipCfg ? (
                    <div className="space-y-3">
                      {[
                        { label: '🏃 Floor / Waiters', pct: tipCfg.floor_pct, cents: s.tip_distribution?.floor_cents },
                        { label: '🍹 Bar + Manager', pct: tipCfg.bar_pct, cents: s.tip_distribution?.bar_cents },
                        { label: '🍳 Kitchen', pct: tipCfg.kitchen_pct, cents: s.tip_distribution?.kitchen_cents },
                      ].map(row => (
                        <div key={row.label} className="flex items-center justify-between px-4 py-3 bg-slate-700 rounded-xl">
                          <div>
                            <div className="font-semibold">{row.label}</div>
                            <div className="text-xs text-slate-400">{row.pct}% of total tips</div>
                          </div>
                          <div className="text-xl font-bold text-amber-400">
                            {row.cents != null ? cents(row.cents) : `${row.pct}%`}
                          </div>
                        </div>
                      ))}
                      <div className="text-xs text-slate-500 text-center mt-2">
                        Total tips this session: {cents(s.total_tips_cents)}
                      </div>
                    </div>
                  ) : editingTips ? (
                    <div className="space-y-3">
                      {[
                        { label: '🏃 Floor / Waiters', val: tipFloor, set: setTipFloor },
                        { label: '🍹 Bar + Manager', val: tipBar, set: setTipBar },
                        { label: '🍳 Kitchen', val: tipKitchen, set: setTipKitchen },
                      ].map(row => (
                        <div key={row.label} className="flex items-center gap-3">
                          <label className="flex-1 text-sm font-medium">{row.label}</label>
                          <div className="flex items-center gap-1">
                            <input type="number" value={row.val} onChange={e => row.set(e.target.value)}
                              className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-center font-mono"
                              min="0" max="100" />
                            <span className="text-slate-400">%</span>
                          </div>
                        </div>
                      ))}
                      {tipTotal !== null && (
                        <div className={`text-center text-sm font-bold ${tipTotal === 100 ? 'text-green-400' : 'text-red-400'}`}>
                          Total: {tipTotal}% {tipTotal === 100 ? '✓' : '(must equal 100%)'}
                        </div>
                      )}
                      <div className="flex gap-3 mt-2">
                        <button onClick={() => setEditingTips(false)}
                          className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-semibold">
                          Cancel
                        </button>
                        <button onClick={handleSaveTipConfig} disabled={savingTips || tipTotal !== 100}
                          className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 rounded-xl text-sm font-bold disabled:opacity-50">
                          {savingTips ? 'Saving…' : 'Save Config'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                {s.total_tips_cents > 0 && (
                  <button onClick={handlePrintTipSheet}
                    className="w-full py-3 bg-amber-700 hover:bg-amber-600 rounded-xl font-bold">
                    🖨 Print Tip Distribution Sheet
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Past Sessions ── */}
        {(sessions as any[]).length > 0 && (
          <div className="bg-slate-800 rounded-2xl overflow-hidden border border-slate-700 mt-6">
            <div className="px-4 py-3 border-b border-slate-700 font-semibold text-slate-200">📋 Historial de Sesiones</div>
            {(sessions as any[]).map((sess: any) => (
              <div key={sess.id} className="flex items-center justify-between px-4 py-3 border-b border-slate-700 last:border-0 text-sm">
                <div>
                  <div className="font-medium">{sess.date}</div>
                  <div className="text-xs text-slate-400">{sess.opened_at?.slice(11, 16)} → {sess.closed_at?.slice(11, 16) ?? 'open'}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${sess.status === 'OPEN' ? 'bg-green-800 text-green-300' : 'bg-slate-700 text-slate-300'}`}>
                    {sess.status}
                  </span>
                  <button
                    onClick={async () => {
                      setLoadingSession(true)
                      try {
                        const res = await client.get(`/cash/${sess.id}/summary`)
                        setViewingSession(res.data.session)
                        setViewingSummary(res.data.summary)
                      } catch { toast.error('No se pudo cargar la sesión') }
                      finally { setLoadingSession(false) }
                    }}
                    className="px-3 py-1 bg-sky-700 hover:bg-sky-600 rounded-lg text-xs font-semibold"
                  >
                    {loadingSession ? '…' : '🔍 Ver'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Session Detail Modal ── */}
        {viewingSession && viewingSummary && (
          <div className="fixed inset-0 bg-black/80 flex items-start justify-center z-50 p-4 overflow-y-auto">
            <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-600 my-4">
              <div className="flex items-center justify-between p-5 border-b border-slate-700">
                <div>
                  <h2 className="font-bold text-lg">Sesión — {viewingSession.date}</h2>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {viewingSession.opened_at?.slice(11,16)} → {viewingSession.closed_at?.slice(11,16) ?? 'abierta'}
                    &nbsp;·&nbsp; {viewingSummary.ticket_count} tickets
                  </div>
                </div>
                <button onClick={() => { setViewingSession(null); setViewingSummary(null) }}
                  className="text-slate-400 hover:text-white text-2xl font-bold">✕</button>
              </div>
              <div className="p-5 space-y-3 text-sm">
                {/* Sales summary */}
                <div className="bg-slate-900 rounded-xl p-4 space-y-2">
                  <div className="font-semibold text-slate-300 mb-2">💰 Ventas</div>
                  <div className="flex justify-between"><span className="text-slate-400">Total Ventas</span><span className="font-mono text-yellow-300">{cents(viewingSummary.total_sales_cents)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">💵 Efectivo</span><span className="font-mono">{cents(viewingSummary.cash_sales_cents)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">💳 Tarjeta</span><span className="font-mono">{cents(viewingSummary.card_sales_cents)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Propinas</span><span className="font-mono text-amber-400">{cents(viewingSummary.total_tips_cents)}</span></div>
                </div>
                {/* Cash reconciliation */}
                <div className="bg-slate-900 rounded-xl p-4 space-y-2">
                  <div className="font-semibold text-slate-300 mb-2">🏦 Caja</div>
                  <div className="flex justify-between"><span className="text-slate-400">Fondo Apertura</span><span className="font-mono">{cents(viewingSummary.opening_fund_cents)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">+ Ventas Efectivo</span><span className="font-mono">{cents(viewingSummary.cash_sales_cents)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">+ Propinas Efectivo</span><span className="font-mono">{cents(viewingSummary.cash_tips_cents)}</span></div>
                  {viewingSummary.cash_expenses_cents > 0 && (
                    <div className="flex justify-between"><span className="text-slate-400">- Gastos Efectivo</span><span className="font-mono text-red-400">-{cents(viewingSummary.cash_expenses_cents)}</span></div>
                  )}
                  <div className="flex justify-between font-bold border-t border-slate-700 pt-2"><span>Efectivo Esperado</span><span className="font-mono text-sky-300">{cents(viewingSummary.expected_cash_cents)}</span></div>
                  {viewingSummary.closing_cash_counted_cents != null && (
                    <>
                      <div className="flex justify-between"><span className="text-slate-400">Contado</span><span className="font-mono">{cents(viewingSummary.closing_cash_counted_cents)}</span></div>
                      <div className={`flex justify-between font-bold text-base ${(viewingSummary.cash_over_short_cents ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        <span>{(viewingSummary.cash_over_short_cents ?? 0) >= 0 ? '▲ SOBRANTE' : '▼ FALTANTE'}</span>
                        <span className="font-mono">{diff(viewingSummary.cash_over_short_cents ?? 0)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-3 p-5 border-t border-slate-700">
                <button
                  onClick={() => printCashReconciliation(viewingSummary as ReconSummary, viewingSession.date, viewingSession.closed_at?.slice(11,16))}
                  className="flex-1 py-2.5 bg-sky-700 hover:bg-sky-600 rounded-xl font-semibold text-sm"
                >🖨️ Reimprimir Reconciliación</button>
                {viewingSummary.tip_distribution && (
                  <button
                    onClick={() => printTipDistribution(viewingSummary as ReconSummary, viewingSession.date)}
                    className="flex-1 py-2.5 bg-amber-700 hover:bg-amber-600 rounded-xl font-semibold text-sm"
                  >🖨️ Reimprimir Propinas</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
