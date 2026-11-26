import { useState } from 'react'
import toast from 'react-hot-toast'
import client from '../api/client'
import { formatUnitCost } from '../utils/money'

const FACTOR: Record<string, number> = { kilogramo: 1000, gramo: 1, litro: 1000, ml: 1 }

interface Item {
  id: string; name: string; base_unit_key: string; stock_quantity: number
  unit_cost_cents: number; purchase_pack_size?: number; portion_size?: number | null
}

/**
 * 🔪 Porcionar (batch E8): the raw used and the packs that came out. Shows the
 * output, waste and yield as you type; the owner also sees the cost per pack
 * (the case's cost spread by weight, waste included).
 */
export default function PortionDialog({ raw, packs, isOwner, onDone, onCancel }: {
  raw: Item; packs: Item[]; isOwner: boolean; onDone: () => void; onCancel: () => void
}) {
  const factor = FACTOR[raw.base_unit_key] ?? 1
  const unit = raw.base_unit_key === 'kilogramo' ? 'kg' : raw.base_unit_key === 'litro' ? 'l' : raw.base_unit_key === 'ml' ? 'ml' : 'g'
  const g = raw.base_unit_key === 'litro' || raw.base_unit_key === 'ml' ? 'ml' : 'g'
  const stock = Number(raw.stock_quantity)
  const caseSize = Number(raw.purchase_pack_size || 0)
  const [used, setUsed] = useState(String(caseSize > 0 && caseSize <= stock ? caseSize : stock))
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const usedG = (parseFloat(used) || 0) * factor
  const outG = packs.reduce((s, p) => s + (parseInt(counts[p.id] || '0') || 0) * Number(p.portion_size || 0), 0)
  const waste = usedG - outG
  const yieldPct = usedG > 0 ? outG / usedG * 100 : 0
  const costPerG = outG > 0 ? ((parseFloat(used) || 0) * Number(raw.unit_cost_cents || 0)) / outG : 0
  const tooMuch = outG > usedG * 1.02
  const ok = usedG > 0 && outG > 0 && !tooMuch && (parseFloat(used) || 0) <= stock
  const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString()

  const submit = async () => {
    setSaving(true)
    try {
      const r = await client.post(`/inventory/${raw.id}/portion`, {
        raw_used: parseFloat(used), notes: notes.trim() || null,
        outputs: packs.map(p => ({ item_id: p.id, packs: parseInt(counts[p.id] || '0') || 0 })).filter(o => o.packs > 0),
      })
      toast.success(`Porcionado #${r.data.batch_number}: rendimiento ${r.data.yield_pct}%`)
      onDone()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo registrar')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl p-5 w-full max-w-md border border-orange-700 space-y-3">
        <h2 className="font-bold text-orange-300">🔪 Porcionar {raw.name}</h2>
        <label className="block text-xs text-slate-400">¿Cuánto se usó? ({unit}) · hay {fmt(stock)} {unit}
          <input type="number" min={0} step="0.01" value={used} onChange={e => setUsed(e.target.value)}
            className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
        </label>
        <div className="text-xs text-slate-400">¿Cuántos paquetes salieron?</div>
        {packs.map(p => {
          const n = parseInt(counts[p.id] || '0') || 0
          return (
            <div key={p.id} className="flex items-center gap-2">
              <span className="flex-1 text-sm">{p.name} <span className="text-slate-500">({p.portion_size} {g})</span></span>
              <input type="number" min={0} step={1} value={counts[p.id] ?? ''} placeholder="0"
                onChange={e => setCounts({ ...counts, [p.id]: e.target.value })}
                className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-right" />
              {isOwner && n > 0 && <span className="w-24 text-right text-xs text-slate-400">{formatUnitCost(costPerG * Number(p.portion_size))}/paq</span>}
            </div>
          )
        })}
        {packs.length === 0 && <div className="text-sm text-amber-300">Aún no hay paquetes ligados a este producto. Edita cada paquete y elige "Se porciona de".</div>}
        <div className={`rounded-lg border px-3 py-2 text-sm ${tooMuch ? 'border-red-600 bg-red-950/40' : 'border-slate-600 bg-slate-900/50'}`}>
          En paquetes: <b>{fmt(outG / factor)} {unit}</b> · Merma: <b>{fmt(Math.max(waste, 0) / factor)} {unit}</b> ·
          Rendimiento: <b className={yieldPct < 85 ? 'text-amber-300' : 'text-emerald-300'}>{usedG ? fmt(yieldPct) : 0}%</b>
          {tooMuch && <div className="text-red-300 text-xs mt-1">Salen más gramos de los que entraron: revisa lo usado o los paquetes.</div>}
        </div>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notas (opcional), p. ej. proveedor / lote"
          className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm" />
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
          <button onClick={submit} disabled={!ok || saving}
            className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg font-bold disabled:opacity-40">
            {saving ? 'Guardando…' : 'Registrar porcionado'}
          </button>
        </div>
      </div>
    </div>
  )
}
