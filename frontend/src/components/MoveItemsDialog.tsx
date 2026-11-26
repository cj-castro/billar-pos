import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import client from '../api/client'
import { formatMXN } from '../utils/money'

/**
 * Mover a otra cuenta (batch E6): a line — or part of it — goes to another open
 * account or to a new one ("pago por separado"). Not a void: nothing is
 * returned to stock or retyped; the money and the recorded cost move with it.
 *
 * `lines` are the ticket lines of one grouped row, newest last; moving N units
 * takes them from the newest lines first.
 */
export default function MoveItemsDialog({ ticketId, name, lines, onDone, onCancel }: {
  ticketId: string
  name: string
  lines: { id: string; quantity: number }[]
  onDone: () => void
  onCancel: () => void
}) {
  const total = lines.reduce((s, l) => s + l.quantity, 0)
  const [qty, setQty] = useState(total)
  const [target, setTarget] = useState<string>('')      // ticket id | 'NEW'
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const { data: targets = [] } = useQuery<any[]>({
    queryKey: ['move-targets'],
    queryFn: () => client.get('/tickets/move-targets').then(r => r.data),
  })
  const options = targets.filter(t => t.id !== ticketId)
  const ok = qty >= 1 && qty <= total && (target === 'NEW' ? newName.trim().length > 0 : !!target)

  const submit = async () => {
    // take `qty` units from the newest lines first
    let left = qty
    const items: { id: string; quantity: number }[] = []
    for (const l of [...lines].reverse()) {
      if (left <= 0) break
      const q = Math.min(l.quantity, left)
      items.push({ id: l.id, quantity: q })
      left -= q
    }
    setSaving(true)
    try {
      const r = await client.post(`/tickets/${ticketId}/move-items`, {
        items, ...(target === 'NEW' ? { new_account_name: newName.trim() } : { target_ticket_id: target }),
      })
      const t = r.data.target
      toast.success(`${qty} × ${name} → ${t.resource_code ?? t.customer_name ?? 'otra cuenta'}`)
      onDone()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo mover')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[80] p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 p-5 space-y-3">
        <h2 className="font-bold text-lg">↔ Mover a otra cuenta</h2>
        <div className="text-sm text-slate-300">{name}</div>
        {total > 1 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">¿Cuántos?</span>
            <button onClick={() => setQty(Math.max(1, qty - 1))} className="w-8 h-8 rounded bg-slate-700 font-bold">−</button>
            <span className="font-mono text-xl w-8 text-center">{qty}</span>
            <button onClick={() => setQty(Math.min(total, qty + 1))} className="w-8 h-8 rounded bg-slate-700 font-bold">+</button>
            <span className="text-xs text-slate-500">de {total}</span>
          </div>
        )}
        <div className="max-h-56 overflow-y-auto space-y-1.5">
          {options.map(t => (
            <button key={t.id} type="button" onClick={() => setTarget(t.id)}
              className={`w-full flex justify-between px-3 py-2 rounded-lg border text-sm ${target === t.id
                ? 'bg-sky-900/60 border-sky-500' : 'bg-slate-700/60 border-slate-600 hover:border-slate-400'}`}>
              <span>{t.resource_code ? `Mesa ${t.resource_code}` : '⚡'} {t.customer_name ? `· ${t.customer_name}` : ''}</span>
              <span className="font-mono text-slate-400">{formatMXN(t.total_cents)}</span>
            </button>
          ))}
          <button type="button" onClick={() => setTarget('NEW')}
            className={`w-full text-left px-3 py-2 rounded-lg border text-sm ${target === 'NEW'
              ? 'bg-emerald-900/50 border-emerald-500' : 'bg-slate-700/60 border-slate-600 hover:border-slate-400'}`}>
            ➕ Cuenta nueva (pago por separado)
          </button>
          {target === 'NEW' && (
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre de la cuenta"
              className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm" />
          )}
        </div>
        <p className="text-[11px] text-slate-500">No es anulación: no regresa nada al inventario ni se vuelve a capturar.</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-bold">Cancelar</button>
          <button onClick={submit} disabled={!ok || saving}
            className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-xl text-sm font-bold disabled:opacity-40">
            {saving ? 'Moviendo…' : 'Mover'}
          </button>
        </div>
      </div>
    </div>
  )
}
