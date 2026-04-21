import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import NavBar from '../components/NavBar'
import AddItemModal from '../components/AddItemModal'
import TransferModal from '../components/TransferModal'
import ManagerPinDialog from '../components/ManagerPinDialog'
import { useTimer } from '../hooks/useTimer'
import { useEscKey } from '../hooks/useEscKey'
import client from '../api/client'
import toast from 'react-hot-toast'
import { printReceipt } from '../utils/printReceipt'

function cents(n: number) { return `$${(n / 100).toFixed(2)}` }

// Group duplicate modifiers and return [{name, count, price_cents}]
function groupModifiers(modifiers: Array<{ name: string; price_cents: number }>) {
  const map = new Map<string, { name: string; count: number; price_cents: number }>()
  for (const m of modifiers) {
    const existing = map.get(m.name)
    if (existing) {
      existing.count++
    } else {
      map.set(m.name, { name: m.name, count: 1, price_cents: m.price_cents })
    }
  }
  return Array.from(map.values())
}

export default function TicketPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [showAddItem, setShowAddItem] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [showPinForVoid, setShowPinForVoid] = useState<string | null>(null)
  const [showPinForDiscount, setShowPinForDiscount] = useState(false)
  const [pendingDiscountPct, setPendingDiscountPct] = useState<number | null>(null)
  const [showPayment, setShowPayment] = useState(false)
  const [paymentType, setPaymentType] = useState<'CASH' | 'CARD'>('CASH')
  const [tendered, setTendered] = useState('')
  const [splitPayment, setSplitPayment] = useState(false)
  const [paymentType2, setPaymentType2] = useState<'CASH' | 'CARD'>('CARD')
  const [tendered2, setTendered2] = useState('')
  const [tipMode, setTipMode] = useState<'pct' | 'fixed'>('pct')
  const [tipPct, setTipPct] = useState<number | null>(null)
  const [tipFixed, setTipFixed] = useState('')
  const [closingLoading, setClosingLoading] = useState(false)
  const [closedTicket, setClosedTicket] = useState<any>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')

  // Close modals with Escape
  useEscKey(() => {
    if (closedTicket) return
    if (showPayment) { setShowPayment(false); return }
    if (showPinForVoid) { setShowPinForVoid(null); return }
    if (showPinForDiscount) { setShowPinForDiscount(false); setPendingDiscountPct(null); return }
  }, showPayment || !!showPinForVoid || showPinForDiscount)

  const { data: ticket, refetch } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => client.get(`/tickets/${id}`).then((r) => r.data),
    refetchInterval: 10_000,
  })

  const activeTimer = ticket?.timer_sessions?.find((s: any) => !s.end_time)
  const elapsed = useTimer(activeTimer?.start_time)

  if (!ticket) return <div className="p-8 text-center text-slate-400">{t('common.loading')}</div>

  const handleVoid = async (itemId: string, managerId: string) => {
    try {
      const reason = prompt('Reason for void:') || 'Void'
      await client.delete(`/tickets/${id}/items/${itemId}`, { data: { manager_id: managerId, reason } })
      toast.success('Item voided')
      refetch()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to void')
    }
    setShowPinForVoid(null)
  }

  const handleApplyDiscount = async (managerId: string) => {
    if (pendingDiscountPct === null) return
    try {
      await client.patch(`/tickets/${id}/discount`, { pct: pendingDiscountPct, reason: 'Manual discount by manager' })
      toast.success(pendingDiscountPct === 0 ? 'Discount removed' : `${pendingDiscountPct}% discount applied`)
      refetch()
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to apply discount')
    }
    setShowPinForDiscount(false)
    setPendingDiscountPct(null)
  }

  const handleSaveName = async () => {
    try {
      await client.patch(`/tickets/${id}/customer-name`, { customer_name: nameInput })
      toast.success('Name updated')
      refetch()
      setEditingName(false)
    } catch {
      toast.error('Failed to save name')
    }
  }

  const handleSendOrder = async () => {    try {
      await client.post(`/tickets/${id}/send-order`)
      toast.success('Order sent')
      refetch()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Nothing to send')
    }
  }

  const handleClose = async () => {
    setClosingLoading(true)
    try {
      const liveTip = tipMode === 'pct' && tipPct !== null
        ? Math.round(liveTotal * tipPct / 100)
        : tipFixed ? Math.round(parseFloat(tipFixed) * 100) : 0
      const grandTotal = liveTotal + liveTip
      const tenderedCents = splitPayment
        ? (tendered2 ? Math.round(parseFloat(tendered2) * 100) : 0)
        : paymentType === 'CASH' ? Math.round(parseFloat(tendered) * 100) : undefined

      // Split payment: primary=CASH tendered2, secondary=CARD gets remainder
      let paymentType2Val: string | undefined
      let tenderedCents2: number | undefined
      if (splitPayment) {
        const cashAmt = tendered2 ? Math.round(parseFloat(tendered2) * 100) : 0
        const cardAmt = Math.max(0, grandTotal - cashAmt)
        paymentType2Val = 'CARD'
        tenderedCents2 = cardAmt
        // Override primary tenderedCents to just the cash portion
        // (tenderedCents already set above from the 'tendered' field)
      }

      const res = await client.post(`/tickets/${id}/close`, {
        payment_type: paymentType,
        tendered_cents: tenderedCents,
        tip_cents: liveTip,
        ...(splitPayment && paymentType2Val ? { payment_type_2: paymentType2Val, tendered_cents_2: tenderedCents2 } : {}),
      })
      setShowPayment(false)
      setClosedTicket(res.data)
      qc.invalidateQueries({ queryKey: ['resources'] })
      qc.invalidateQueries({ queryKey: ['tickets-pending-payment'] })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to close')
    } finally {
      setClosingLoading(false)
    }
  }

  const openItems = ticket.line_items?.filter((i: any) => i.status !== 'VOIDED') ?? []
  const resource = ticket.resource_code

  // Compute live totals — pool time may still be running (charge_cents null)
  const livePoolCents: number = (ticket.timer_sessions ?? []).reduce((sum: number, s: any) => {
    if (!s.end_time && s.start_time) {
      const secs = Math.max(0, (Date.now() - new Date(s.start_time).getTime()) / 1000)
      return sum + Math.floor(secs / 3600 * s.rate_cents)
    }
    return sum + (s.charge_cents ?? 0)
  }, 0)
  const liveSubtotal: number = ticket.subtotal_cents ?? 0
  const liveDiscount: number = ticket.discount_cents ?? 0
  const liveTotal: number = Math.max(0, liveSubtotal - liveDiscount + livePoolCents)

  return (
    <div className="min-h-screen bg-slate-950">
      <NavBar />
      <div className="max-w-2xl mx-auto p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <button onClick={() => navigate('/floor')} className="text-sky-400 text-sm">← {t('nav.floor')}</button>
          <div className="text-center">
            <div className="font-bold text-lg">{resource}</div>
            <div className="text-xs text-slate-400">Ticket #{ticket.id?.slice(-6).toUpperCase()}</div>
            {/* Customer name */}
            {ticket.status === 'OPEN' && !editingName && (
              <button
                onClick={() => { setNameInput(ticket.customer_name || ''); setEditingName(true) }}
                className="mt-1 text-sm text-yellow-300 hover:text-yellow-100 flex items-center gap-1 mx-auto"
              >
                👤 {ticket.customer_name || <span className="text-slate-500">+ Add name</span>}
                <span className="text-slate-500 text-xs">✏️</span>
              </button>
            )}
            {ticket.status === 'OPEN' && editingName && (
              <div className="mt-1 flex items-center gap-1">
                <input
                  autoFocus
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingName(false) }}
                  className="bg-slate-700 border border-yellow-500 rounded px-2 py-0.5 text-sm w-32 text-center"
                  placeholder="Party name…"
                />
                <button onClick={handleSaveName} className="text-green-400 text-sm font-bold">✓</button>
                <button onClick={() => setEditingName(false)} className="text-slate-400 text-sm">✕</button>
              </div>
            )}
            {ticket.status === 'CLOSED' && ticket.customer_name && (
              <div className="mt-1 text-yellow-300 text-sm">👤 {ticket.customer_name}</div>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            {activeTimer && (
              <div className="text-right">
                <div className="text-yellow-300 font-mono text-xl">{elapsed}</div>
                <div className="text-xs text-slate-400">{t('ticket.poolTime')}</div>
              </div>
            )}
            <button
              onClick={() => printReceipt(ticket, livePoolCents)}
              className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 px-3 py-1.5 rounded-lg text-sm font-semibold"
            >
              🖨️ Print
            </button>
          </div>
        </div>

        {/* Line Items */}
        <div className="bg-slate-800 rounded-xl mb-4">
          <div className="flex items-center justify-between p-3 border-b border-slate-700">
            <span className="font-semibold text-sm">{t('ticket.items')}</span>
            {ticket.status === 'OPEN' && (
              <button onClick={() => setShowAddItem(true)} className="bg-sky-600 hover:bg-sky-500 px-3 py-1 rounded-lg text-sm font-semibold">
                + {t('ticket.addItems')}
              </button>
            )}
          </div>
          {openItems.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-sm">{t('ticket.noItems')}</div>
          ) : (
            openItems.map((item: any) => (
              <div key={item.id} className="flex items-start justify-between p-3 border-b border-slate-700 last:border-0">
                <div>
                  <div className="font-medium">{item.quantity}× {item.menu_item_name}</div>
                  {groupModifiers(item.modifiers ?? []).map((m) => (
                    <div key={m.name} className="text-xs text-sky-300 ml-2">
                      → {m.count > 1 ? `${m.name} ×${m.count}` : m.name}
                    </div>
                  ))}
                  {item.notes && <div className="text-xs text-slate-400 ml-2 italic">{item.notes}</div>}
                  <div className={`text-xs mt-0.5 ${
                    item.status === 'STAGED' ? 'text-yellow-400' :
                    item.status === 'SERVED' ? 'text-green-400' : 'text-slate-400'
                  }`}>{item.status}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono">{cents(item.quantity * item.unit_price_cents)}</div>
                  {ticket.status === 'OPEN' && (
                    <button onClick={() => setShowPinForVoid(item.id)} className="text-xs text-red-400 hover:text-red-300 mt-1">{t('ticket.voidItem')}</button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Timer Sessions */}
        {ticket.timer_sessions?.length > 0 && (
          <div className="mb-4 rounded-xl overflow-hidden border-2 border-yellow-600">
            {/* Header */}
            <div className="bg-yellow-900/60 px-4 py-3 flex items-center justify-between">
              <span className="font-bold text-yellow-300 flex items-center gap-2 text-base">
                🎱 {t('ticket.poolTime')}
              </span>
              <span className="font-mono font-bold text-yellow-300 text-xl">
                {/* Show live estimate for the running session + closed sessions */}
                {cents(
                  ticket.timer_sessions.reduce((sum: number, s: any) => {
                    if (!s.end_time && s.start_time) {
                      // live estimate
                      const secs = Math.max(0, (Date.now() - new Date(s.start_time).getTime()) / 1000)
                      return sum + Math.floor(secs / 3600 * s.rate_cents)
                    }
                    return sum + (s.charge_cents ?? 0)
                  }, 0)
                )}
              </span>
            </div>

            {ticket.timer_sessions.map((s: any) => {
              const isRunning = !s.end_time
              // Compute displayed duration
              const totalSec = isRunning
                ? Math.floor((Date.now() - new Date(s.start_time).getTime()) / 1000)
                : (s.duration_seconds ?? 0)
              const h = Math.floor(totalSec / 3600)
              const m = Math.floor((totalSec % 3600) / 60)
              const sec = totalSec % 60
              const durationStr = h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`
              // Live cost estimate for running session
              const liveCost = isRunning
                ? Math.floor(totalSec / 3600 * s.rate_cents)
                : (s.charge_cents ?? 0)

              return (
                <div key={s.id} className="bg-slate-800 px-4 py-3 flex items-center justify-between border-t border-yellow-800/50">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white text-base">{s.resource_code}</span>
                      {isRunning && (
                        <span className="text-xs bg-green-700 text-green-200 px-1.5 py-0.5 rounded font-medium animate-pulse">● LIVE</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {s.billing_mode === 'PER_MINUTE' ? 'Per minute' :
                       s.billing_mode === 'ROUND_15' ? 'Rounded 15 min' : 'Per hour block'}
                      &nbsp;·&nbsp;{cents(s.rate_cents)}/hr
                    </div>
                    <div className="text-sm text-slate-200 font-mono">
                      ⏱ {isRunning ? elapsed || durationStr : durationStr}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-mono font-bold text-2xl ${isRunning ? 'text-yellow-300' : 'text-yellow-100'}`}>
                      {cents(liveCost)}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {isRunning ? 'est.' : 'charged'}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Totals */}
        <div className="bg-slate-800 rounded-xl p-4 mb-4 space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">{t('ticket.subtotal')} (items)</span>
            <span className="font-mono">{cents(liveSubtotal)}</span>
          </div>
          {(ticket.manual_discount_pct || 0) > 0 && (
            <div className="flex justify-between text-sm text-green-400 font-semibold">
              <span>{t('ticket.discount_label')} ({ticket.manual_discount_pct}% off)</span>
              <span className="font-mono">-{cents(liveDiscount)}</span>
            </div>
          )}
          {(ticket.manual_discount_pct || 0) === 0 && liveDiscount > 0 && (
            <div className="flex justify-between text-sm text-green-400">
              <span>{t('ticket.discount')}</span>
              <span className="font-mono">-{cents(liveDiscount)}</span>
            </div>
          )}
          {livePoolCents > 0 && (
            <div className="flex justify-between text-sm font-semibold text-yellow-300">
              <span>🎱 {t('ticket.poolTime')}{activeTimer ? ' (est.)' : ''}</span>
              <span className="font-mono">{cents(livePoolCents)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-xl border-t border-slate-700 pt-2 mt-2">
            <span>{t('ticket.total')}</span>
            <span className="text-sky-400 font-mono">{cents(liveTotal)}</span>
          </div>
        </div>

        {/* Actions */}
        {ticket.status === 'OPEN' && (
          <div className="flex flex-col gap-3">
            {/* Discount quick buttons */}
            <div className="bg-slate-800 rounded-xl p-3 border border-slate-700">
              <div className="text-xs text-slate-400 mb-2 font-semibold">{t('ticket.discount_label')}</div>
              <div className="flex flex-wrap gap-2">
                {[0, 5, 10, 15, 20, 25, 50].map(pct => (
                  <button
                    key={pct}
                    onClick={() => { setPendingDiscountPct(pct); setShowPinForDiscount(true) }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${
                      (ticket.manual_discount_pct || 0) === pct
                        ? 'bg-green-600 text-white'
                        : pct === 0
                          ? 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                          : 'bg-slate-700 hover:bg-green-700 text-slate-200'
                    }`}
                  >
                    {pct === 0 ? 'None' : `${pct}%`}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={() => setShowTransfer(true)} className="w-full py-3 bg-yellow-600 hover:bg-yellow-500 text-slate-900 rounded-xl font-bold text-lg">🔀 {t('ticket.transfer')}</button>
            <button
              onClick={async () => {
                try {
                  await client.post(`/tickets/${ticket.id}/request-payment`)
                  const result = await refetch()
                  const fresh = result.data ?? ticket
                  printReceipt(fresh, undefined, true)
                } catch (err: any) {
                  toast.error(err.response?.data?.message || 'Error al pedir cuenta')
                }
              }}
              className={`w-full py-3 rounded-xl font-bold text-lg transition-colors ${
                ticket.payment_requested
                  ? 'bg-amber-700 hover:bg-amber-600 text-white'
                  : 'bg-amber-500 hover:bg-amber-400 text-slate-900'
              }`}
            >
              🧾 {ticket.payment_requested ? 'Cuenta Solicitada' : 'Pedir Cuenta'}
            </button>
            {/* Close & Pay — only available once payment has been requested */}
            {ticket.payment_requested && (
              <button
                onClick={() => {
                  setSplitPayment(false); setPaymentType('CASH'); setPaymentType2('CARD')
                  setTendered2(''); setTipMode('pct'); setTipPct(null); setTipFixed('')
                  setTendered((liveTotal / 100).toFixed(2))
                  setShowPayment(true)
                }}
                className="w-full py-3 bg-green-600 hover:bg-green-500 rounded-xl font-bold text-lg"
              >
                {t('ticket.closeAndPay')}
              </button>
            )}
            {/* Cancel ticket — only when empty (no items, no pool time) */}
            {openItems.length === 0 && (ticket.timer_sessions ?? []).length === 0 && (
              <button
                onClick={async () => {
                  if (!confirm('¿Cancelar ticket y liberar mesa? Esta acción no se puede deshacer.')) return
                  try {
                    await client.post(`/tickets/${ticket.id}/cancel`)
                    toast.success('Ticket cancelado — mesa liberada')
                    navigate('/floor')
                  } catch (err: any) {
                    toast.error(err.response?.data?.message || 'No se pudo cancelar')
                  }
                }}
                className="w-full py-2.5 border border-red-700 text-red-400 hover:bg-red-900/30 rounded-xl font-semibold text-sm transition-colors"
              >
                🗑 Cancelar ticket y liberar mesa
              </button>
            )}
          </div>
        )}

        {ticket.status === 'CLOSED' && (
          <div className="bg-slate-800 rounded-xl p-5 text-center space-y-3">
            <div className="text-green-400 font-bold text-xl">✓ {t('ticket.status.closed')}</div>
            <div className="text-slate-300">
              {ticket.payment_type === 'CASH' ? '💵 Cash' : '💳 Card'} &nbsp;·&nbsp;
              <span className="font-bold text-sky-400">{cents(ticket.total_cents)}</span>
            </div>
            {(ticket.change_due ?? 0) > 0 && (
              <div className="text-yellow-300 font-semibold">💰 {t('ticket.closed.changeDue')}: {cents(ticket.change_due)}</div>
            )}
            <button
              onClick={() => printReceipt(ticket, livePoolCents)}
              className="w-full py-3 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold text-base flex items-center justify-center gap-2"
            >
              🖨️ {t('ticket.closed.printReceipt')}
            </button>
          </div>
        )}
      </div>

      {/* Modals */}
      {showAddItem && (
        <AddItemModal ticketId={id!} ticketVersion={ticket.version} onClose={() => setShowAddItem(false)} onAdded={refetch} />
      )}
      {showTransfer && (
        <TransferModal ticketId={id!} currentResourceCode={resource} onClose={() => setShowTransfer(false)} />
      )}
      {showPinForVoid && (
        <ManagerPinDialog
          action="Void Line Item"
          onConfirm={(managerId) => handleVoid(showPinForVoid, managerId)}
          onCancel={() => setShowPinForVoid(null)}
        />
      )}
      {showPinForDiscount && pendingDiscountPct !== null && (
        <ManagerPinDialog
          action={pendingDiscountPct === 0 ? 'Remove Discount' : `Apply ${pendingDiscountPct}% Discount`}
          onConfirm={handleApplyDiscount}
          onCancel={() => { setShowPinForDiscount(false); setPendingDiscountPct(null) }}
        />
      )}

      {showPayment && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600">
            <h2 className="font-bold text-lg mb-4">{t('payment.title')}</h2>

            {/* Live breakdown — updates as tip is selected */}
            {(() => {
              const liveTip = tipMode === 'pct' && tipPct !== null
                ? Math.round(liveTotal * tipPct / 100)
                : tipFixed ? Math.round(parseFloat(tipFixed || '0') * 100) : 0
              const grandTotal = liveTotal + liveTip
              const tenderedCents = tendered ? Math.round(parseFloat(tendered) * 100) : 0
              const change = tenderedCents - grandTotal

              return (
                <>
                  <div className="bg-slate-900 rounded-xl p-3 mb-4 space-y-1.5 text-sm">
                    <div className="flex justify-between text-slate-300">
                      <span>{t('payment.items')}</span>
                      <span className="font-mono">{cents(liveSubtotal)}</span>
                    </div>
                    {liveDiscount > 0 && (
                      <div className="flex justify-between text-green-400">
                        <span>{t('payment.discounts')}</span>
                        <span className="font-mono">-{cents(liveDiscount)}</span>
                      </div>
                    )}
                    {livePoolCents > 0 && (
                      <div className="flex justify-between text-yellow-300">
                        <span>🎱 {t('payment.poolTime')}</span>
                        <span className="font-mono">{cents(livePoolCents)}</span>
                      </div>
                    )}
                    <div className={`flex justify-between font-bold border-t border-slate-700 pt-2 ${liveTip > 0 ? 'text-slate-300 text-base' : 'text-xl text-sky-400'}`}>
                      <span>{t('payment.subtotal')}</span>
                      <span className="font-mono">{cents(liveTotal)}</span>
                    </div>
                    {liveTip > 0 && (
                      <>
                        <div className="flex justify-between text-amber-400 text-sm">
                          <span>💝 {t('payment.tip')}{tipMode === 'pct' && tipPct ? ` (${tipPct}%)` : ''}</span>
                          <span className="font-mono">+{cents(liveTip)}</span>
                        </div>
                        <div className="flex justify-between font-extrabold text-xl text-sky-400 border-t border-slate-700 pt-2">
                          <span>{t('payment.grandTotal')}</span>
                          <span className="font-mono">{cents(grandTotal)}</span>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    {(['CASH', 'CARD'] as const).map((pt) => (
                      <button key={pt} onClick={() => { setPaymentType(pt); setSplitPayment(false); setTendered2('') }}
                        className={`py-3 rounded-xl font-bold border-2 ${paymentType === pt && !splitPayment ? 'bg-sky-600 border-sky-400' : 'bg-slate-700 border-slate-600'}`}>
                        {pt === 'CASH' ? t('payment.cash') : t('payment.card')}
                      </button>
                    ))}
                  </div>
                  {/* Split payment toggle */}
                  <button
                    onClick={() => {
                      setSplitPayment(!splitPayment)
                      if (!splitPayment) {
                        setPaymentType('CASH')
                        setTendered2('')
                      }
                    }}
                    className={`w-full py-2 rounded-lg text-sm font-semibold border-2 transition-colors mb-4 ${splitPayment ? 'bg-purple-700 border-purple-400 text-white' : 'bg-slate-700 border-slate-600 text-slate-300'}`}
                  >
                    ➕ {splitPayment ? '✓ Pago Dividido (Efectivo + Tarjeta)' : 'Dividir Pago (Efectivo + Tarjeta)'}
                  </button>

                  {/* Split breakdown — show live cash/card split */}
                  {splitPayment && (() => {
                    const cashAmt = tendered2 ? Math.round(parseFloat(tendered2) * 100) : 0
                    const cardAmt = Math.max(0, grandTotal - cashAmt)
                    return (
                      <div className="mb-4 bg-purple-900/30 border border-purple-700 rounded-xl p-3 space-y-2">
                        <div className="text-xs text-purple-300 font-semibold mb-2">División de Pago — Total: {cents(grandTotal)}</div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">💵 Efectivo recibido</label>
                          <input type="number" value={tendered2}
                            onChange={e => {
                              setTendered2(e.target.value)
                              setTendered(e.target.value) // keep primary tendered in sync
                            }}
                            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono"
                            placeholder="0.00"
                            autoFocus
                          />
                        </div>
                        <div className="flex justify-between items-center bg-slate-800 rounded-lg px-3 py-2">
                          <span className="text-sm text-slate-400">💳 Tarjeta (resto)</span>
                          <span className={`font-mono font-bold text-base ${cardAmt > 0 ? 'text-sky-300' : 'text-green-400'}`}>{cents(cardAmt)}</span>
                        </div>
                        {cashAmt > grandTotal && (
                          <div className="text-xs text-amber-400">⚠ El efectivo supera el total — el resto se devuelve como cambio</div>
                        )}
                      </div>
                    )
                  })()}

                  {/* Tip section */}
                  <div className="mb-4 bg-slate-700/50 rounded-xl p-3">
                    <div className="text-sm text-slate-400 mb-2 font-semibold">💝 {t('payment.tip')}</div>
                    <div className="flex gap-2 mb-2">
                      {[10, 15, 20].map(pct => {
                        const amt = Math.round(liveTotal * pct / 100)
                        const isSelected = tipMode === 'pct' && tipPct === pct
                        return (
                          <button key={pct}
                            onClick={() => {
                              const newPct = isSelected ? null : pct
                              setTipMode('pct'); setTipPct(newPct); setTipFixed('')
                              if (paymentType === 'CASH') {
                                const newTip = newPct !== null ? Math.round(liveTotal * newPct / 100) : 0
                                setTendered(((liveTotal + newTip) / 100).toFixed(2))
                              }
                            }}
                            className={`flex-1 py-2 rounded-lg text-sm font-bold border-2 ${isSelected ? 'bg-amber-600 border-amber-400' : 'bg-slate-700 border-slate-600'}`}>
                            {pct}%<br/><span className="text-xs font-normal">{cents(amt)}</span>
                          </button>
                        )
                      })}
                      <button
                        onClick={() => { setTipMode('fixed'); setTipPct(null) }}
                        className={`flex-1 py-2 rounded-lg text-sm font-bold border-2 ${tipMode === 'fixed' ? 'bg-amber-600 border-amber-400' : 'bg-slate-700 border-slate-600'}`}>
                        {t('payment.other')}
                      </button>
                    </div>
                    {tipMode === 'fixed' && (
                      <input type="number" value={tipFixed}
                        onChange={e => {
                          setTipFixed(e.target.value)
                          if (paymentType === 'CASH') {
                            const fixedTip = e.target.value ? Math.round(parseFloat(e.target.value) * 100) : 0
                            setTendered(((liveTotal + fixedTip) / 100).toFixed(2))
                          }
                        }}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono text-sm"
                        placeholder="Tip amount ($)" />
                    )}
                    {liveTip === 0 && (
                      <div className="text-xs text-slate-500 mt-1">{t('payment.noTip')}</div>
                    )}
                  </div>

                  {paymentType === 'CASH' && !splitPayment && (
                    <div className="mb-4">
                      <label className="text-sm text-slate-400 block mb-1">
                        {t('payment.amountTendered')} <span className="text-xs text-slate-500">{t('payment.includesTip')}</span>
                      </label>
                      <input
                        type="number"
                        value={tendered}
                        onChange={(e) => setTendered(e.target.value)}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-lg font-mono"
                        placeholder={(grandTotal / 100).toFixed(2)}
                      />
                      {/* Quick exact buttons */}
                      <div className="flex gap-2 mt-2">
                        {[grandTotal, ...([5,10,20,50,100].map(b => b * 100).filter(b => b > grandTotal).slice(0,3))].map((amt, i) => (
                          <button key={i} onClick={() => setTendered((amt / 100).toFixed(2))}
                            className="flex-1 py-1 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-mono">
                            ${(amt / 100).toFixed(2)}
                          </button>
                        ))}
                      </div>
                      {tendered && tenderedCents >= grandTotal && (
                        <div className="text-green-400 mt-2 text-sm font-semibold">
                          💰 {t('payment.change')}: {cents(change)}
                        </div>
                      )}
                      {tendered && tenderedCents < grandTotal && (
                        <div className="text-red-400 mt-2 text-sm">
                          ⚠ {t('payment.shortBy')} {cents(grandTotal - tenderedCents)}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button onClick={() => setShowPayment(false)} className="flex-1 py-2 border border-slate-600 rounded-lg">{t('payment.cancel')}</button>
                    <button onClick={handleClose} disabled={closingLoading} className="flex-1 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-bold disabled:opacity-50">
                      {closingLoading ? '...' : `${t('payment.confirm')} ${cents(grandTotal)}`}
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* ── Ticket Closed Overlay ─────────────────────────────────────────── */}
      {closedTicket && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-green-700 shadow-2xl shadow-green-900/40 overflow-hidden">
            <div className="bg-green-700/30 p-6 text-center border-b border-green-700">
              <img src="/logo.jpg" alt="Bola 8 Pool Club" className="w-20 h-20 rounded-full object-cover mx-auto mb-3 border-2 border-green-500 shadow-lg" />
              <div className="text-2xl font-extrabold text-green-400">{t('ticket.closed.title')}</div>
              <div className="text-slate-300 text-sm mt-1">#{closedTicket.id?.slice(-6).toUpperCase()}</div>
            </div>
            <div className="p-5 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">{t('ticket.closed.table')}</span>
                <span className="font-semibold">{closedTicket.resource_code}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">{t('ticket.closed.payment')}</span>
                <span className="font-semibold">
                  {closedTicket.payment_type === 'CASH' ? t('payment.cash') : t('payment.card')}
                  {closedTicket.payment_type_2 && ` + ${closedTicket.payment_type_2 === 'CASH' ? t('payment.cash') : t('payment.card')}`}
                </span>
              </div>
              <div className="flex justify-between text-lg font-bold border-t border-slate-700 pt-3">
                <span>{t('ticket.closed.total')}</span>
                <span className="text-green-400">{cents(closedTicket.total_cents)}</span>
              </div>
              {(closedTicket.tip_cents ?? 0) > 0 && (
                <div className="flex justify-between text-sm text-amber-400">
                  <span>💝 {t('ticket.closed.tip')}</span>
                  <span className="font-semibold">{cents(closedTicket.tip_cents)}</span>
                </div>
              )}
              {(closedTicket.change_due ?? 0) > 0 && (
                <div className="flex justify-between text-base font-bold text-yellow-300 bg-yellow-900/30 rounded-lg px-3 py-2">
                  <span>💰 {t('ticket.closed.changeDue')}</span>
                  <span>{cents(closedTicket.change_due)}</span>
                </div>
              )}
            </div>
            <div className="px-5 pb-5 space-y-3">
              <button
                onClick={() => printReceipt(closedTicket)}
                className="w-full py-3 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold text-base flex items-center justify-center gap-2"
              >
                🖨️ {t('ticket.closed.printReceipt')}
              </button>
              <button
                onClick={() => navigate('/floor')}
                className="w-full py-3 bg-slate-700 hover:bg-slate-600 rounded-xl font-semibold text-base"
              >
                {t('ticket.closed.backToFloor')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
