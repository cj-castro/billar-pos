import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import client from '../api/client'

/**
 * Ajustes → Límites (owner). Batches E3 / E5.
 *   comps.owner_above_cents  cortesías worth more than this need the owner's PIN
 *   staff.allowance_cents    free staff consumption per employee per day
 *   purchasing.safety_pct    margin added to the weekly purchase forecast
 * Money is typed in pesos and stored in centavos; 0 / empty = no limit.
 *
 * Drawer count by denomination (same Save button):
 *   cash.count_by_denomination  'on' / 'off' (server refuses 'on' when the
 *                               venue currency has no bill/coin table)
 *   cash.drawer_fund_cents      fund that stays in the drawer at close; default $2,000
 */
const FIELDS = [
  { key: 'comps.owner_above_cents', label: 'Cortesías: el dueño autoriza arriba de ($)', money: true,
    help: 'Una cortesía de más de esta cantidad (precio de lista) necesita el PIN del dueño. 0 = cualquier gerente.' },
  { key: 'staff.allowance_cents', label: 'Consumo libre de personal por día ($)', money: true,
    help: 'Por empleado, a precio de lista. Arriba de esto, el dueño autoriza el cierre. 0 = sin límite.' },
  { key: 'purchasing.safety_pct', label: 'Colchón del pronóstico de compras (%)', money: false,
    help: 'Se suma a lo que se vende por semana. Normalmente 20%.' },
]

const COUNT_KEY = 'cash.count_by_denomination'
const FUND_KEY = 'cash.drawer_fund_cents'
const DEFAULT_FUND_CENTS = 200000
// Same values the server reads as "on" (settings_svc.is_truthy).
const TRUTHY = new Set(['1', 'true', 't', 'yes', 'y', 'on'])

export function OwnerLimits() {
  const { t } = useTranslation()
  const [vals, setVals] = useState<Record<string, string>>({})
  const [countOn, setCountOn] = useState<boolean | null>(null)   // null = not loaded yet
  const [fund, setFund] = useState('')   // pesos, as typed
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all(FIELDS.map(f => client.get(`/settings/${f.key}`).then(r => r.data?.value).catch(() => null)))
      .then(vs => setVals(Object.fromEntries(FIELDS.map((f, i) => {
        const v = vs[i]
        if (v == null || v === '') return [f.key, f.key === 'purchasing.safety_pct' ? '20' : '0']
        return [f.key, f.money ? String(Number(v) / 100) : String(v)]
      }))))
    client.get(`/settings/${COUNT_KEY}`)
      .then(r => setCountOn(TRUTHY.has(String(r.data?.value ?? '').trim().toLowerCase())))
      .catch(() => {})
    client.get(`/settings/${FUND_KEY}`)
      .then(r => {
        const n = parseInt(String(r.data?.value ?? ''), 10)
        setFund(String((Number.isFinite(n) ? n : DEFAULT_FUND_CENTS) / 100))
      })
      // Load failed: leave it empty so Save asks for it, never overwrite the real value.
      .catch(() => setFund(''))
  }, [])

  const save = async () => {
    const fundPesos = parseFloat(fund)
    if (!Number.isFinite(fundPesos) || fundPesos < 0) return toast.error(t('cash.count.settingsFundInvalid'))
    setSaving(true)
    try {
      for (const f of FIELDS) {
        const raw = parseFloat(vals[f.key] || '0') || 0
        await client.put(`/settings/${f.key}`, { value: String(f.money ? Math.round(raw * 100) : Math.round(raw)) })
      }
      await client.put(`/settings/${FUND_KEY}`, { value: String(Math.round(fundPesos * 100)) })
      // Last: the server refuses 'on' (422) when the currency has no bill/coin table.
      // Not loaded (GET failed): leave the flag as it is on the server.
      if (countOn !== null) await client.put(`/settings/${COUNT_KEY}`, { value: countOn ? 'on' : 'off' })
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
      <div className="border-t border-slate-800 pt-3 space-y-3">
        <h3 className="font-semibold text-sm">{t('cash.count.settingsTitle')}</h3>
        <label className="flex items-start gap-2 text-sm text-slate-200">
          <input type="checkbox" checked={countOn === true} disabled={countOn === null} onChange={e => setCountOn(e.target.checked)}
            className="mt-1 h-4 w-4" />
          <span>{t('cash.count.settingsToggle')}
            <span className="block text-xs text-slate-500 mt-1">{t('cash.count.settingsToggleHelp')}</span>
          </span>
        </label>
        <label className="block text-xs text-slate-400">{t('cash.count.settingsFund')}
          <input type="number" min={0} step={1} value={fund}
            onChange={e => setFund(e.target.value)}
            className="mt-1 w-40 block bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
          <span className="block mt-1 text-slate-500">{t('cash.count.settingsFundHelp')}</span>
        </label>
      </div>
      <button onClick={save} disabled={saving}
        className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-semibold disabled:opacity-50">
        {saving ? 'Guardando…' : 'Guardar límites'}
      </button>
    </section>
  )
}
