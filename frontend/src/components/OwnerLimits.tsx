import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import client from '../api/client'

/**
 * Ajustes → Límites (owner). Batches E3 / E5.
 *   comps.owner_above_cents  cortesías worth more than this need the owner's PIN
 *   staff.allowance_cents    free staff consumption per employee per day
 *   purchasing.safety_pct    margin added to the weekly purchase forecast
 * Money is typed in pesos and stored in centavos; 0 / empty = no limit.
 */
const FIELDS = [
  { key: 'comps.owner_above_cents', label: 'Cortesías: el dueño autoriza arriba de ($)', money: true,
    help: 'Una cortesía de más de esta cantidad (precio de lista) necesita el PIN del dueño. 0 = cualquier gerente.' },
  { key: 'staff.allowance_cents', label: 'Consumo libre de personal por día ($)', money: true,
    help: 'Por empleado, a precio de lista. Arriba de esto, el dueño autoriza el cierre. 0 = sin límite.' },
  { key: 'purchasing.safety_pct', label: 'Colchón del pronóstico de compras (%)', money: false,
    help: 'Se suma a lo que se vende por semana. Normalmente 20%.' },
]

export function OwnerLimits() {
  const [vals, setVals] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all(FIELDS.map(f => client.get(`/settings/${f.key}`).then(r => r.data?.value).catch(() => null)))
      .then(vs => setVals(Object.fromEntries(FIELDS.map((f, i) => {
        const v = vs[i]
        if (v == null || v === '') return [f.key, f.key === 'purchasing.safety_pct' ? '20' : '0']
        return [f.key, f.money ? String(Number(v) / 100) : String(v)]
      }))))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      for (const f of FIELDS) {
        const raw = parseFloat(vals[f.key] || '0') || 0
        await client.put(`/settings/${f.key}`, { value: String(f.money ? Math.round(raw * 100) : Math.round(raw)) })
      }
      toast.success('Límites guardados')
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo guardar')
    } finally { setSaving(false) }
  }

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
      <h2 className="font-semibold">Límites (solo dueño)</h2>
      {FIELDS.map(f => (
        <label key={f.key} className="block text-xs text-slate-400">{f.label}
          <input type="number" min={0} step={f.money ? 1 : 1} value={vals[f.key] ?? ''}
            onChange={e => setVals({ ...vals, [f.key]: e.target.value })}
            className="mt-1 w-40 block bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
          <span className="block mt-1 text-slate-500">{f.help}</span>
        </label>
      ))}
      <button onClick={save} disabled={saving}
        className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-semibold disabled:opacity-50">
        {saving ? 'Guardando…' : 'Guardar límites'}
      </button>
    </section>
  )
}
