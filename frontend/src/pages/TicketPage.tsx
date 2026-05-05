import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import NavBar from '../components/NavBar'
import AddItemModal from '../components/AddItemModal'
import TransferModal from '../components/TransferModal'
import ManagerPinDialog from '../components/ManagerPinDialog'
import EditPaymentModal from '../components/EditPaymentModal'
import PrintRetryBanner from '../components/PrintRetryBanner'
import { useAuthStore } from '../stores/authStore'
import { useTimer } from '../hooks/useTimer'
import { useEscKey } from '../hooks/useEscKey'
import client from '../api/client'
import toast from 'react-hot-toast'
import {
  getPendingJob, storePendingJob, removePendingJob,
  hasPrinted, markPrinted,
} from '../utils/printJobStorage'


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

// Group line items by name + unit_price + modifiers + notes into single rows.
// Each group tracks all original item IDs so voids still work per-item.
function groupLineItemsUI(items: any[]) {
  const map = new Map<string, {
    ids: string[]           // all original line item ids in this group
    menu_item_name: string
    quantity: number
    unit_price_cents: number
    modifiers: any[]
    notes?: string
    status: string          // worst-case status (STAGED > SENT > IN_PROGRESS > READY > SERVED)
  }>()
  const statusRank: Record<string, number> = { STAGED: 5, SENT: 4, IN_PROGRESS: 3, READY: 2, SERVED: 1 }
  for (const item of items) {
    const modKey = (item.modifiers ?? []).map((m: any) => m.name).sort().join('|')
    const key = `${item.menu_item_name}::${item.unit_price_cents}::${modKey}::${item.notes ?? ''}`
    const existing = map.get(key)
    if (existing) {
      existing.ids.push(item.id)
      existing.quantity += item.quantity
      // keep the "most pending" status visible
      if ((statusRank[item.status] ?? 0) > (statusRank[existing.status] ?? 0)) {
        existing.status = item.status
      }
    } else {
      map.set(key, {
        ids: [item.id],
        menu_item_name: item.menu_item_name,
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        modifiers: item.modifiers ?? [],
        notes: item.notes,
        status: item.status,
      })
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
  const [showEditPayment, setShowEditPayment] = useState(false)
  const [showPinForVoid, setShowPinForVoid] = useState<string[] | null>(null)
  const [voidQtyPicker, setVoidQtyPicker] = useState<{ ids: string[]; name: string; qty: number } | null>(null)
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
  const [tipSource, setTipSource] = useState<'CASH' | 'CARD' | 'SPLIT'>('CASH')
  const [splitTipCash, setSplitTipCash] = useState('')
  const [splitTipCard, setSplitTipCard] = useState('')
  const [showJoinWaitlist, setShowJoinWaitlist] = useState(false)
  const [wlName, setWlName] = useState('')
  const [wlSize, setWlSize] = useState(1)
  const [wlJoining, setWlJoining] = useState(false)
  const [printingThermal, setPrintingThermal] = useState(false)
  const [showPinForReprint, setShowPinForReprint] = useState<string | null>(null) // ticketId
  const [reprintBannerKey, setReprintBannerKey] = useState(0)

  // Close modals with Escape
  useEscKey(() => {
    if (closedTicket) return
    if (showPayment) { setShowPayment(false); return }
    if (voidQtyPicker) { setVoidQtyPicker(null); return }
    if (showPinForVoid) { setShowPinForVoid(null); return }
    if (showPinForDiscount) { setShowPinForDiscount(false); setPendingDiscountPct(null); return }
  }, showPayment || !!voidQtyPicker || !!showPinForVoid || showPinForDiscount)

  const { data: ticket, refetch } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => client.get(`/tickets/${id}`).then((r) => r.data),
    refetchInterval: 10_000,
  })

  const activeTimer = ticket?.timer_sessions?.find((s: any) => !s.end_time)
  const elapsed = useTimer(activeTimer?.start_time)

  if (!ticket) return <div className="p-8 text-center text-slate-400">{t('common.loading')}</div>

  const handleVoid = async (itemIds: string | string[], managerId: string) => {
    const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
    try {
      const reason = prompt('Reason for void:') || 'Void'
      for (const itemId of ids) {
        await client.delete(`/tickets/${id}/items/${itemId}`, { data: { manager_id: managerId, reason } })
      }
      toast.success(ids.length > 1 ? `${ids.length} artículos anulados` : 'Artículo anulado')
      refetch()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo anular')
    }
    setShowPinForVoid(null)
    setVoidQtyPicker(null)
  }

  const thermalPrint = async (ticketId: string, unpaid = false) => {
    setPrintingThermal(true)
    // Retrieve any existing failed job_id for idempotent retry
    const pending = getPendingJob(ticketId)
    try {
      const res = await client.post(
        `/tickets/${ticketId}/print${unpaid ? '?unpaid=true' : ''}`,
        pending ? { job_id: pending.job_id } : {},
      )
      const jobId: string = res.data?.job_id
      removePendingJob(ticketId)
      markPrinted(ticketId)
      setReprintBannerKey((k) => k + 1)
      toast.success('Enviado a impresora')
    } catch (err: any) {
      const jobId: string | undefined = err.response?.data?.job_id
      const msg = err.response?.data?.error || 'No se pudo imprimir'
      if (jobId) {
        storePendingJob({ job_id: jobId, ticketId, type: 'RECEIPT', timestamp: Date.now() })
        setReprintBannerKey((k) => k + 1)
      }
      toast.error(msg)
    } finally { setPrintingThermal(false) }
  }

  const handleReprint = async (ticketId: string, managerId: string) => {
    try {
      const res = await client.post(`/tickets/${ticketId}/reprint`, { manager_id: managerId })
      markPrinted(ticketId)
      toast.success('Reimpresión enviada')
    } catch (err: any) {
      const jobId: string | undefined = err.response?.data?.job_id
      if (jobId) {
        storePendingJob({ job_id: jobId, ticketId, type: 'REPRINT', timestamp: Date.now() })
        setReprintBannerKey((k) => k + 1)
      }
      toast.error(err.response?.data?.error || 'Error al reimprimir')
    } finally {
      setShowPinForReprint(null)
    }
  }

  const handleApplyDiscount = async (managerId: string) => {
    if (pendingDiscountPct === null) return
    try {
      await client.patch(`/tickets/${id}/discount`, { pct: pendingDiscountPct, reason: 'Manual discount by manager' })
      toast.success(pendingDiscountPct === 0 ? 'Descuento eliminado' : `Descuento de ${pendingDiscountPct}% aplicado`)
      refetch()
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'No se pudo aplicar el descuento')
    }
    setShowPinForDiscount(false)
    setPendingDiscountPct(null)
  }

  const handleSaveName = async () => {
    try {
      await client.patch(`/tickets/${id}/customer-name`, { customer_name: nameInput })
      toast.success('Nombre actualizado')
      refetch()
      setEditingName(false)
    } catch {
      toast.error('No se pudo guardar el nombre')
    }
  }

  const handleSendOrder = async () => {    try {
      await client.post(`/tickets/${id}/send-order`)
      toast.success('Orden enviada')
      refetch()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Nada para enviar')
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

      const effectiveTipSource = liveTip > 0 ? tipSource : undefined
      const splitTipCashCents = tipSource === 'SPLIT' && splitTipCash ? Math.round(parseFloat(splitTipCash) * 100) : undefined
      const splitTipCardCents = splitTipCashCents !== undefined ? Math.max(0, liveTip - splitTipCashCents) : undefined

      const res = await client.post(`/tickets/${id}/close`, {
        payment_type: paymentType,
        tendered_cents: tenderedCents,
        tip_cents: liveTip,
        tip_source: effectiveTipSource,
        ...(splitTipCashCents !== undefined ? { tip_cash_cents: splitTipCashCents, tip_card_cents: splitTipCardCents } : {}),
        ...(splitPayment && paymentType2Val ? { payment_type_2: paymentType2Val, tendered_cents_2: tenderedCents2 } : {}),
      })
      setShowPayment(false)
      setClosedTicket(res.data)
      qc.invalidateQueries({ queryKey: ['resources'] })
      qc.invalidateQueries({ queryKey: ['tickets-pending-payment'] })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo cerrar')
    } finally {
      setClosingLoading(false)
    }
  }

  const openItems = ticket.line_items?.filter((i: any) => i.status !== 'VOIDED') ?? []
  const groupedItems = groupLineItemsUI(openItems)
  const resource = ticket.resource_code
  const isPoolTable = (ticket.timer_sessions ?? []).length > 0
    || ticket.resource_code?.startsWith('BT')
    || ticket.resource_code?.startsWith('PT')  // legacy codes pre-2026-04-27 rename

  const handleJoinWaitlist = async () => {
    setWlJoining(true)
    try {
      await client.post('/waiting-list', {
        party_name: wlName.trim() || ticket.customer_name || ticket.resource_code,
        party_size: wlSize,
        floor_ticket_id: ticket.id,
        floor_resource_id: ticket.resource_id,
      })
      toast.success('⏳ Agregado a lista de espera')
      setShowJoinWaitlist(false)
      qc.invalidateQueries({ queryKey: ['waiting-list'] })
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Error')
    } finally { setWlJoining(false) }
  }

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
    <div className="min-h-screen bg-slate-950 page-root">
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
                👤 {ticket.customer_name || <span className="text-slate-500">+ Agregar nombre</span>}
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
                  placeholder="Nombre del grupo…"
                />
                <button onClick={handleSaveName} className="text-green-400 text-sm font-bold">✓</button>
                <button onClick={() => setEditingName(false)} className="text-slate-400 text-sm">✕</button>
              </div>
            )}
            {ticket.status === 'CLOSED' && ticket.customer_name && (
              <div className="mt-1 text-yellow-300 text-sm">👤 {ticket.customer_name}</div>
            )}
            {/* Waiting list badge */}
            {ticket.waiting_list_entry && (
              <div className="mt-1 flex items-center justify-center gap-1 bg-yellow-900/50 border border-yellow-700 rounded-full px-3 py-0.5">
                <span className="text-yellow-400 text-xs">⏳ Lista #{ticket.waiting_list_entry.position}</span>
                <span className="text-yellow-300 text-xs font-semibold">{ticket.waiting_list_entry.party_name}</span>
                {ticket.waiting_list_entry.party_size > 1 && (
                  <span className="text-yellow-600 text-xs">· {ticket.waiting_list_entry.party_size}p</span>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            {activeTimer && (
              <div className="text-right">
                <div className="text-yellow-300 font-mono text-xl">{elapsed}</div>
                <div className="text-xs text-slate-400">{t('ticket.poolTime')}</div>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => thermalPrint(ticket.id)}
                disabled={printingThermal}
                className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 px-3 py-1.5 rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {printingThermal ? '⏳ Imprimiendo…' : '🖨️ Imprimir'}
              </button>
            </div>
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
            groupedItems.map((group) => (
              <div key={group.ids.join(',')} className="flex items-start justify-between p-3 border-b border-slate-700 last:border-0">
                <div>
                  <div className="font-medium">{group.quantity}× {group.menu_item_name}</div>
                  {groupModifiers(group.modifiers).map((m) => (
                    <div key={m.name} className="text-xs text-sky-300 ml-2">
                      → {m.count > 1 ? `${m.name} ×${m.count}` : m.name}
                    </div>
                  ))}
                  {group.notes && <div className="text-xs text-slate-400 ml-2 italic">{group.notes}</div>}
                  <div className={`text-xs mt-0.5 ${
                    group.status === 'STAGED' ? 'text-yellow-400' :
                    group.status === 'SERVED' ? 'text-green-400' : 'text-slate-400'
                  }`}>{group.status}{group.ids.length > 1 ? ` (${group.ids.length})` : ''}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono">{cents(
                    group.quantity * (
                      group.unit_price_cents +
                      (group.modifiers ?? []).reduce((s: number, m: any) => s + (m.price_cents ?? 0), 0)
                    )
                  )}</div>
                  {ticket.status === 'OPEN' && (
                    <button
                      onClick={() => {
                        if (group.ids.length === 1) {
                          setShowPinForVoid([group.ids[0]])
                        } else {
                          setVoidQtyPicker({ ids: group.ids, name: group.menu_item_name, qty: 1 })
                        }
                      }}
                      className="text-xs text-red-400 hover:text-red-300 mt-1"
                    >
                      {t('ticket.voidItem')}
                    </button>
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
                      {s.billing_mode === 'PER_MINUTE' ? 'Por minuto' :
                       s.billing_mode === 'ROUND_15' ? 'Redondeado 15 min' : 'Por bloque de hora'}
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
                      {isRunning ? 'est.' : 'cobrado'}
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
                {[0, 5, 10, 15, 20, 25, 50, 100].map(pct => (
                  <button
                    key={pct}
                    onClick={() => { setPendingDiscountPct(pct); setShowPinForDiscount(true) }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${
                      (ticket.manual_discount_pct || 0) === pct
                        ? pct === 100 ? 'bg-purple-600 text-white ring-2 ring-purple-400' : 'bg-green-600 text-white'
                        : pct === 0
                          ? 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                          : pct === 100
                            ? 'bg-slate-700 hover:bg-purple-700 text-purple-300 border border-purple-700'
                            : 'bg-slate-700 hover:bg-green-700 text-slate-200'
                    }`}
                  >
                    {pct === 0 ? 'Sin descuento' : pct === 100 ? '🆓 100%' : `${pct}%`}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={() => setShowTransfer(true)} className="w-full py-3 bg-yellow-600 hover:bg-yellow-500 text-slate-900 rounded-xl font-bold text-lg">🔀 {t('ticket.transfer')}</button>
            {/* Join waiting list — only for floor tables (not pool) and not already queued */}
            {!isPoolTable && !ticket.waiting_list_entry && (
              <button
                onClick={() => { setWlName(ticket.customer_name || ''); setWlSize(1); setShowJoinWaitlist(true) }}
                className="w-full py-3 rounded-xl font-bold text-base border border-yellow-700/50 bg-slate-700 hover:bg-yellow-900 text-yellow-300 transition-colors"
              >
                ⏳ Unirse a lista de espera (pool)
              </button>
            )}
            <button
              onClick={async () => {
                try {
                  await client.post(`/tickets/${ticket.id}/request-payment`)
                  await refetch()
                  await thermalPrint(ticket.id, true)
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
            {ticket.edited_after_close && (
              <div className="text-xs text-amber-300 bg-amber-900/30 rounded-lg px-3 py-1.5">
                ✏️ Editado después del cierre
              </div>
            )}
            {(ticket.change_due ?? 0) > 0 && (
              <div className="text-yellow-300 font-semibold">💰 {t('ticket.closed.changeDue')}: {cents(ticket.change_due)}</div>
            )}
            <button
              onClick={() => thermalPrint(ticket.id)}
              disabled={printingThermal}
              className="w-full py-3 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold text-base flex items-center justify-center gap-2 disabled:opacity-50"
            >
              🖨️ {printingThermal ? 'Enviando…' : t('ticket.closed.printReceipt')}
            </button>
            <PrintRetryBanner key={reprintBannerKey} ticketId={ticket.id} onSuccess={() => setReprintBannerKey((k) => k + 1)} />
            {hasPrinted(ticket.id) && (
              <button
                onClick={() => setShowPinForReprint(ticket.id)}
                className="w-full py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-semibold text-slate-300 flex items-center justify-center gap-2"
              >
                🔄 Reimprimir (PIN)
              </button>
            )}
            {(useAuthStore.getState().user?.role === 'MANAGER' || useAuthStore.getState().user?.role === 'ADMIN') && (
              <button
                onClick={() => setShowEditPayment(true)}
                className="w-full py-2.5 bg-amber-700 hover:bg-amber-600 rounded-xl font-bold text-sm flex items-center justify-center gap-2"
              >
                ✏️ Editar Pago (PIN)
              </button>
            )}
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
      {showEditPayment && ticket && (
        <EditPaymentModal
          ticket={ticket}
          onClose={() => setShowEditPayment(false)}
          onSaved={refetch}
        />
      )}
      {showPinForReprint && (
        <ManagerPinDialog
          action="Reimprimir Recibo"
          onConfirm={(managerId) => handleReprint(showPinForReprint, managerId)}
          onCancel={() => setShowPinForReprint(null)}
        />
      )}
      {voidQtyPicker && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
          <div className="bg-slate-800 rounded-2xl border border-slate-600 p-6 w-full max-w-xs">
            <h3 className="font-bold text-lg mb-1">¿Cuántos anular?</h3>
            <p className="text-sm text-slate-400 mb-4">{voidQtyPicker.name}</p>
            <div className="flex items-center justify-center gap-6 mb-6">
              <button
                onClick={() => setVoidQtyPicker(p => p && p.qty > 1 ? { ...p, qty: p.qty - 1 } : p)}
                className="w-10 h-10 rounded-full bg-slate-700 hover:bg-slate-600 text-xl font-bold"
              >−</button>
              <span className="text-3xl font-mono w-10 text-center">{voidQtyPicker.qty}</span>
              <button
                onClick={() => setVoidQtyPicker(p => p && p.qty < p.ids.length ? { ...p, qty: p.qty + 1 } : p)}
                className="w-10 h-10 rounded-full bg-slate-700 hover:bg-slate-600 text-xl font-bold"
              >+</button>
            </div>
            <p className="text-xs text-slate-500 text-center mb-4">máx: {voidQtyPicker.ids.length}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setVoidQtyPicker(null)}
                className="flex-1 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-sm"
              >Cancelar</button>
              <button
                onClick={() => {
                  // take the last N ids (most recently added)
                  const toVoid = voidQtyPicker.ids.slice(-voidQtyPicker.qty)
                  setVoidQtyPicker(null)
                  setShowPinForVoid(toVoid)
                }}
                className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-sm font-semibold"
              >Continuar</button>
            </div>
          </div>
        </div>
      )}
      {showPinForVoid && (
        <ManagerPinDialog
          action={`Anular ${showPinForVoid.length > 1 ? `${showPinForVoid.length} artículos` : 'Artículo'}`}
          onConfirm={(managerId) => handleVoid(showPinForVoid, managerId)}
          onCancel={() => setShowPinForVoid(null)}
        />
      )}
      {showPinForDiscount && pendingDiscountPct !== null && (
        <ManagerPinDialog
          action={pendingDiscountPct === 0 ? 'Eliminar Descuento' : `Aplicar ${pendingDiscountPct}% de Descuento`}
          onConfirm={handleApplyDiscount}
          onCancel={() => { setShowPinForDiscount(false); setPendingDiscountPct(null) }}
        />
      )}

      {showPayment && (
        <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4">
          <div className="bg-slate-800 rounded-t-2xl sm:rounded-2xl w-full max-w-sm border border-slate-600 flex flex-col max-h-[92dvh] sm:max-h-[90vh]">
            {/* Sticky header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-700 shrink-0">
              <h2 className="font-bold text-lg">{t('payment.title')}</h2>
              <button onClick={() => setShowPayment(false)} className="text-slate-400 hover:text-white text-xl px-1">✕</button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-5 py-4">

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
                      <button key={pt} onClick={() => { setPaymentType(pt); setSplitPayment(false); setTendered2(''); setTipSource(pt) }}
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
                        setTipSource('SPLIT')  // sensible default when paying split
                      } else {
                        setTipSource('CASH')   // reset when going back to single
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
                        placeholder="Cantidad de propina ($)" />
                    )}
                    {liveTip === 0 && (
                      <div className="text-xs text-slate-500 mt-1">{t('payment.noTip')}</div>
                    )}
                    {/* Tip source — always show when tip > 0 */}
                    {liveTip > 0 && (
                      <div className="mt-3 pt-3 border-t border-slate-600">
                        <div className="text-xs text-slate-400 mb-2">¿La propina es en…?</div>
                        <div className="flex gap-2">
                          {(['CASH','CARD','SPLIT'] as const).map(src => (
                            <button key={src} onClick={() => { setTipSource(src); setSplitTipCash(''); setSplitTipCard('') }}
                              className={`flex-1 py-1.5 rounded-lg text-xs font-bold border-2 transition-colors ${tipSource === src ? 'bg-amber-700 border-amber-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-300'}`}>
                              {src === 'CASH' ? '💵 Efectivo' : src === 'CARD' ? '💳 Tarjeta' : '½ Ambos'}
                            </button>
                          ))}
                        </div>

                        {/* Split tip amount inputs */}
                        {tipSource === 'SPLIT' && (
                          <div className="mt-3 space-y-2">
                            <div className="text-xs text-slate-400 mb-1">Especifica cuánto de cada tipo:</div>
                            <div className="flex gap-2 items-center">
                              <label className="text-xs text-slate-400 w-20 shrink-0">💵 Efectivo</label>
                              <input
                                type="number"
                                min="0"
                                max={(liveTip / 100).toFixed(2)}
                                step="0.01"
                                value={splitTipCash}
                                onChange={e => {
                                  setSplitTipCash(e.target.value)
                                  const cashCents = Math.round(parseFloat(e.target.value || '0') * 100)
                                  const cardCents = Math.max(0, liveTip - cashCents)
                                  setSplitTipCard((cardCents / 100).toFixed(2))
                                }}
                                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 font-mono text-sm"
                                placeholder="0.00"
                              />
                            </div>
                            <div className="flex gap-2 items-center">
                              <label className="text-xs text-slate-400 w-20 shrink-0">💳 Tarjeta</label>
                              <input
                                type="number"
                                min="0"
                                max={(liveTip / 100).toFixed(2)}
                                step="0.01"
                                value={splitTipCard}
                                onChange={e => {
                                  setSplitTipCard(e.target.value)
                                  const cardCents = Math.round(parseFloat(e.target.value || '0') * 100)
                                  const cashCents = Math.max(0, liveTip - cardCents)
                                  setSplitTipCash((cashCents / 100).toFixed(2))
                                }}
                                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 font-mono text-sm"
                                placeholder="0.00"
                              />
                            </div>
                            {/* Running totals check */}
                            {splitTipCash && (
                              (() => {
                                const cashCents = Math.round(parseFloat(splitTipCash) * 100)
                                const cardCents = Math.round(parseFloat(splitTipCard || '0') * 100)
                                const diff = cashCents + cardCents - liveTip
                                return diff !== 0 ? (
                                  <div className="text-xs text-amber-400">
                                    ⚠ Suma: {((cashCents + cardCents) / 100).toFixed(2)} · Total propina: {(liveTip / 100).toFixed(2)} (dif: {(diff / 100).toFixed(2)})
                                  </div>
                                ) : (
                                  <div className="text-xs text-green-400">✓ {(cashCents/100).toFixed(2)} efectivo + {(cardCents/100).toFixed(2)} tarjeta</div>
                                )
                              })()
                            )}
                          </div>
                        )}
                      </div>
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

                  <div className="h-1" /> {/* bottom scroll breathing room */}
                </>
              )
            })()}
            </div>{/* end scrollable body */}

            {/* Sticky footer — always visible */}
            {(() => {
              const liveTip2 = tipMode === 'pct' && tipPct !== null
                ? Math.round(liveTotal * tipPct / 100)
                : tipFixed ? Math.round(parseFloat(tipFixed || '0') * 100) : 0
              const grandTotal2 = liveTotal + liveTip2
              return (
                <div className="px-5 py-4 border-t border-slate-700 shrink-0 flex gap-3 bg-slate-800 rounded-b-2xl">
                  <button onClick={() => setShowPayment(false)} className="flex-1 py-3 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700 font-semibold">
                    {t('payment.cancel')}
                  </button>
                  <button onClick={handleClose} disabled={closingLoading} className="flex-1 py-3 bg-green-600 hover:bg-green-500 rounded-xl font-bold text-lg disabled:opacity-50">
                    {closingLoading ? '…' : `✅ ${cents(grandTotal2)}`}
                  </button>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* ── Ticket Closed Overlay ─────────────────────────────────────────── */}
      {closedTicket && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-[60] p-4">
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

              {/* ID return reminder */}
              <div className="flex items-center gap-2 bg-red-900/50 border border-red-500 rounded-xl px-4 py-3 mt-2">
                <span className="text-2xl">🪪</span>
                <span className="text-red-300 font-bold text-sm leading-tight">
                  ¡RECUERDA DEVOLVER LA IDENTIFICACIÓN AL CLIENTE!
                </span>
              </div>
            </div>
            <div className="px-5 pb-5 space-y-3">
              <button
                onClick={() => thermalPrint(closedTicket.id)}
                disabled={printingThermal}
                className="w-full py-3 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold text-base flex items-center justify-center gap-2 disabled:opacity-50"
              >
                🖨️ {printingThermal ? 'Enviando…' : t('ticket.closed.printReceipt')}
              </button>
              <PrintRetryBanner key={reprintBannerKey} ticketId={closedTicket.id} onSuccess={() => setReprintBannerKey((k) => k + 1)} />
              {hasPrinted(closedTicket.id) && (
                <button
                  onClick={() => setShowPinForReprint(closedTicket.id)}
                  className="w-full py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-semibold text-slate-300 flex items-center justify-center gap-2"
                >
                  🔄 Reimprimir (PIN)
                </button>
              )}
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

      {/* Join Waiting List Modal */}
      {showJoinWaitlist && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-[60] p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">⏳ Lista de Espera — Pool</h2>
              <p className="text-slate-400 text-sm mt-1">Agrega esta mesa a la cola para mesa de billar.</p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Nombre</label>
                <input value={wlName} onChange={e => setWlName(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-lg"
                  placeholder={ticket.customer_name || ticket.resource_code} autoFocus />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Personas</label>
                <div className="flex gap-2">
                  {[1,2,3,4,5,6].map(n => (
                    <button key={n} onClick={() => setWlSize(n)}
                      className={`flex-1 py-2 rounded-lg border text-sm font-bold ${wlSize === n ? 'bg-sky-700 border-sky-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-300'}`}>{n}</button>
                  ))}
                </div>
              </div>
              <div className="bg-sky-900/30 border border-sky-700/50 rounded-xl p-3 text-xs text-sky-300">
                🪑 Quedarán en <span className="font-bold">{ticket.resource_code}</span> mientras esperan una mesa de pool.
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button onClick={() => setShowJoinWaitlist(false)}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">Cancelar</button>
              <button onClick={handleJoinWaitlist} disabled={wlJoining}
                className="flex-1 py-2.5 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded-xl disabled:opacity-50">
                {wlJoining ? 'Agregando…' : 'Agregar ⏳'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
