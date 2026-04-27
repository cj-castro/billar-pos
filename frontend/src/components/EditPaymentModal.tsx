import { useState } from 'react'
import client from '../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../hooks/useEscKey'

interface Props {
  ticket: any
  onClose: () => void
  onSaved: () => void
}

const pesos = (cents: number) => ((cents ?? 0) / 100).toFixed(2)
const toCents = (pesoStr: string) => Math.round(parseFloat(pesoStr || '0') * 100)

export default function EditPaymentModal({ ticket, onClose, onSaved }: Props) {
  useEscKey(onClose)

  // PIN + reason
  const [pin, setPin] = useState('')
  const [reason, setReason] = useState('')

  // Payment
  const [splitPayment, setSplitPayment] = useState(!!ticket.payment_type_2)
  const [paymentType, setPaymentType] = useState<'CASH' | 'CARD'>(ticket.payment_type || 'CASH')
  const [tendered, setTendered] = useState(pesos(ticket.tendered_cents))
  const [paymentType2, setPaymentType2] = useState<'CASH' | 'CARD'>(
    (ticket.payment_type_2 as 'CASH' | 'CARD') || (ticket.payment_type === 'CASH' ? 'CARD' : 'CASH')
  )
  const [tendered2, setTendered2] = useState(pesos(ticket.tendered_cents_2))

  // Tip
  const [tipTotal, setTipTotal] = useState(pesos(ticket.tip_cents))
  const [tipSource, setTipSource] = useState<'CASH' | 'CARD' | 'SPLIT'>(
    (ticket.tip_source as any) || 'CASH'
  )
  const [tipCash, setTipCash] = useState(pesos(ticket.tip_cash_cents))
  const [tipCard, setTipCard] = useState(pesos(ticket.tip_card_cents))

  // History
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<any[] | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadHistory = async () => {
    if (history) { setShowHistory(s => !s); return }
    try {
      const res = await client.get(`/tickets/${ticket.id}/edit-history`)
      setHistory(res.data || [])
      setShowHistory(true)
    } catch {
      toast.error('No se pudo cargar el historial')
    }
  }

  const submit = async () => {
    setError(null)
    if (!pin) return setError('PIN requerido')
    if (!reason.trim()) return setError('Razón del cambio requerida')

    const tipTotalCents = toCents(tipTotal)
    if (tipTotalCents < 0) return setError('Propina inválida')

    // Validate split tip if SPLIT selected
    if (tipSource === 'SPLIT') {
      const sum = toCents(tipCash) + toCents(tipCard)
      if (sum !== tipTotalCents) {
        return setError(`Propina mixta debe sumar al total: ${pesos(toCents(tipCash))} + ${pesos(toCents(tipCard))} ≠ ${pesos(tipTotalCents)}`)
      }
    }

    // Build diff body — only include fields that actually changed.
    const body: any = { pin, reason: reason.trim() }

    if (paymentType !== ticket.payment_type) body.payment_type = paymentType

    if (splitPayment) {
      if (paymentType2 !== ticket.payment_type_2) body.payment_type_2 = paymentType2
      const t1 = toCents(tendered)
      const t2 = toCents(tendered2)
      if (t1 !== (ticket.tendered_cents ?? 0)) body.tendered_cents = t1
      if (t2 !== (ticket.tendered_cents_2 ?? 0)) body.tendered_cents_2 = t2
    } else {
      // Not split — clear payment_type_2 if it was set
      if (ticket.payment_type_2) body.payment_type_2 = null
      if (ticket.tendered_cents_2) body.tendered_cents_2 = null
      const t1 = toCents(tendered)
      if (t1 !== (ticket.tendered_cents ?? 0)) body.tendered_cents = t1
    }

    if (tipTotalCents !== (ticket.tip_cents ?? 0)) body.tip_cents = tipTotalCents
    if (tipSource !== (ticket.tip_source || null)) body.tip_source = tipSource

    if (tipSource === 'SPLIT') {
      const tc = toCents(tipCash)
      const td = toCents(tipCard)
      if (tc !== (ticket.tip_cash_cents ?? 0)) body.tip_cash_cents = tc
      if (td !== (ticket.tip_card_cents ?? 0)) body.tip_card_cents = td
    } else {
      // Single-source tip — clear the split breakdown if it was there
      if (ticket.tip_cash_cents) body.tip_cash_cents = null
      if (ticket.tip_card_cents) body.tip_card_cents = null
    }

    if (Object.keys(body).length <= 2) {
      return setError('No hay cambios que guardar')
    }

    setSaving(true)
    try {
      await client.post(`/tickets/${ticket.id}/edit-payment`, body)
      toast.success('Pago actualizado')
      onSaved()
      onClose()
    } catch (err: any) {
      setError(err.response?.data?.message || err.response?.data?.error || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  // ── UI helpers ──────────────────────────────────────────────────────────
  const PaymentBtn = ({ value, current, onClick }: { value: 'CASH' | 'CARD'; current: 'CASH' | 'CARD'; onClick: () => void }) => (
    <button onClick={onClick}
      className={`py-2 rounded-lg font-semibold text-sm ${current === value ? 'bg-sky-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
      {value === 'CASH' ? '💵 Efectivo' : '💳 Tarjeta'}
    </button>
  )

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-600 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="p-5 border-b border-slate-700">
          <h2 className="text-lg font-bold">✏️ Editar Pago — Ticket Cerrado</h2>
          <p className="text-xs text-slate-400 mt-1">
            El total no se modifica. Sólo método de pago y propinas.
            Para cambiar artículos, usa "Reabrir".
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Total del ticket: <span className="font-mono text-sky-300">${pesos(ticket.total_cents)}</span>
          </p>
        </div>

        <div className="p-5 space-y-4">
          {/* PIN */}
          <div>
            <label className="text-xs text-slate-400 block mb-1">PIN de Gerente *</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              autoFocus
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-lg font-mono text-center tracking-widest"
              placeholder="••••"
            />
          </div>

          {/* PAYMENT */}
          <div className="border-t border-slate-700 pt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold text-slate-200">💰 Método de Pago</span>
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input type="checkbox"
                  checked={splitPayment}
                  onChange={e => setSplitPayment(e.target.checked)}
                  className="accent-sky-500" />
                Pago dividido (2 métodos)
              </label>
            </div>

            <div className="space-y-2">
              <div>
                <label className="text-xs text-slate-400 block mb-1">{splitPayment ? 'Método 1' : 'Método'}</label>
                <div className="grid grid-cols-2 gap-2">
                  <PaymentBtn value="CASH" current={paymentType} onClick={() => setPaymentType('CASH')} />
                  <PaymentBtn value="CARD" current={paymentType} onClick={() => setPaymentType('CARD')} />
                </div>
              </div>

              {splitPayment && (
                <>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Recibido método 1 (MXN)</label>
                    <input type="number" step="0.01" min="0"
                      value={tendered}
                      onChange={e => setTendered(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono" />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Método 2</label>
                    <div className="grid grid-cols-2 gap-2">
                      <PaymentBtn value="CASH" current={paymentType2} onClick={() => setPaymentType2('CASH')} />
                      <PaymentBtn value="CARD" current={paymentType2} onClick={() => setPaymentType2('CARD')} />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Recibido método 2 (MXN)</label>
                    <input type="number" step="0.01" min="0"
                      value={tendered2}
                      onChange={e => setTendered2(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono" />
                  </div>

                  <div className="text-xs text-slate-500">
                    Suma recibida: <span className="font-mono">${pesos(toCents(tendered) + toCents(tendered2))}</span>
                    {' · '}Total + propina: <span className="font-mono">${pesos(ticket.total_cents + toCents(tipTotal))}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* TIP */}
          <div className="border-t border-slate-700 pt-4">
            <div className="text-sm font-bold text-slate-200 mb-2">🪙 Propina</div>

            <div className="space-y-2">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Monto total propina (MXN)</label>
                <input type="number" step="0.01" min="0"
                  value={tipTotal}
                  onChange={e => setTipTotal(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono" />
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Origen</label>
                <div className="grid grid-cols-3 gap-2">
                  {([['CASH', '💵 Efectivo'], ['CARD', '💳 Tarjeta'], ['SPLIT', '🔀 Mixto']] as const).map(([opt, label]) => (
                    <button key={opt}
                      onClick={() => setTipSource(opt)}
                      className={`py-1.5 rounded-lg text-xs font-semibold ${tipSource === opt ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {tipSource === 'SPLIT' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">💵 Efectivo</label>
                    <input type="number" step="0.01" min="0"
                      value={tipCash}
                      onChange={e => setTipCash(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">💳 Tarjeta</label>
                    <input type="number" step="0.01" min="0"
                      value={tipCard}
                      onChange={e => setTipCard(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono" />
                  </div>
                  <div className="col-span-2 text-xs text-slate-500">
                    Suma: <span className="font-mono">${pesos(toCents(tipCash) + toCents(tipCard))}</span>
                    {' · '}Total propina: <span className="font-mono">${pesos(toCents(tipTotal))}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* REASON */}
          <div className="border-t border-slate-700 pt-4">
            <label className="text-xs text-slate-400 block mb-1">Razón del cambio *</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
              placeholder="ej. Cliente pagó parte en efectivo, parte tarjeta — se cobró sólo tarjeta"
            />
          </div>

          {error && <div className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2">⚠️ {error}</div>}

          <button
            onClick={loadHistory}
            className="w-full text-xs text-slate-400 hover:text-slate-200 underline">
            {showHistory ? '▼' : '▶'} Historial de cambios
          </button>
          {showHistory && history && (
            <div className="bg-slate-900 rounded-lg p-3 space-y-2 max-h-40 overflow-y-auto text-xs">
              {history.length === 0 && <div className="text-slate-500">Sin cambios previos.</div>}
              {history.map(h => (
                <div key={h.id} className="border-b border-slate-700 pb-2 last:border-0">
                  <div className="text-slate-300 font-semibold">{new Date(h.created_at).toLocaleString('es-MX')}</div>
                  {h.before_state && h.after_state && Object.keys(h.after_state).map(k => (
                    <div key={k} className="text-slate-400">
                      {k}: <span className="text-red-300">{String(h.before_state[k] ?? '—')}</span>
                      {' → '}
                      <span className="text-green-300">{String(h.after_state[k] ?? '—')}</span>
                    </div>
                  ))}
                  {h.reason && <div className="text-slate-500 italic mt-0.5">{h.reason}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-slate-700">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving || !pin || !reason.trim()}
            className="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold disabled:opacity-50">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}
