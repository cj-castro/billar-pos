import { useEffect, useState } from 'react'
import client from '../../api/client'
import toast from 'react-hot-toast'

interface PoolConfig {
  resource_id: string
  code: string
  billing_mode: 'PER_MINUTE' | 'ROUND_15' | 'PER_HOUR'
  rate_cents: number
  promo_free_minutes: number
}

const BILLING_MODES = [
  { value: 'PER_MINUTE', label: 'Per Minute (exact)' },
  { value: 'ROUND_15', label: 'Round to 15 min (up)' },
  { value: 'PER_HOUR', label: 'Per Hour (full block)' },
]

export default function PoolTableConfigPage() {
  const [tables, setTables] = useState<PoolConfig[]>([])
  const [editing, setEditing] = useState<Record<string, Partial<PoolConfig>>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    client.get('/resources?type=POOL_TABLE').then((res) => {
      const rows: PoolConfig[] = res.data.map((r: any) => ({
        resource_id: r.id,
        code: r.code,
        billing_mode: r.pool_config?.billing_mode ?? 'PER_MINUTE',
        rate_cents: r.pool_config?.rate_cents ?? 8600,
        promo_free_minutes: r.pool_config?.promo_free_minutes ?? 0,
      }))
      setTables(rows)
    })
  }, [])

  const patch = (id: string, field: string, val: any) => {
    setEditing((prev) => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }

  const save = async (row: PoolConfig) => {
    setSaving(row.resource_id)
    const changes = editing[row.resource_id] ?? {}
    const payload = {
      billing_mode: changes.billing_mode ?? row.billing_mode,
      rate_cents: Number(changes.rate_cents ?? row.rate_cents),
      promo_free_minutes: Number(changes.promo_free_minutes ?? row.promo_free_minutes),
    }
    try {
      await client.patch(`/resources/${row.resource_id}/pool-config`, payload)
      setTables((prev) =>
        prev.map((t) => (t.resource_id === row.resource_id ? { ...t, ...payload } : t))
      )
      setEditing((prev) => { const n = { ...prev }; delete n[row.resource_id]; return n })
      toast.success(`${row.code} updated`)
    } catch {
      toast.error('Save failed')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="p-6 text-white max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">🎱 Pool Table Billing Config</h1>
      <div className="space-y-4">
        {tables.map((row) => {
          const edits = editing[row.resource_id] ?? {}
          const cur = { ...row, ...edits }
          const dirty = Object.keys(edits).length > 0
          return (
            <div key={row.resource_id} className="bg-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-bold text-lg">{row.code}</span>
                {dirty && (
                  <button
                    onClick={() => save(row)}
                    disabled={saving === row.resource_id}
                    className="px-4 py-1.5 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-semibold"
                  >
                    {saving === row.resource_id ? 'Saving…' : 'Save'}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Billing Mode</label>
                  <select
                    value={cur.billing_mode}
                    onChange={(e) => patch(row.resource_id, 'billing_mode', e.target.value)}
                    className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm"
                  >
                    {BILLING_MODES.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Rate (pesos / hr)</label>
                  <input
                    type="number"
                    min={0}
                    value={cur.rate_cents}
                    onChange={(e) => patch(row.resource_id, 'rate_cents', e.target.value)}
                    className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm"
                  />
                  <div className="text-xs text-slate-500 mt-0.5">
                    = ${(Number(cur.rate_cents) / 100).toFixed(2)} / hr
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Free First Minutes (promo)</label>
                  <input
                    type="number"
                    min={0}
                    value={cur.promo_free_minutes}
                    onChange={(e) => patch(row.resource_id, 'promo_free_minutes', e.target.value)}
                    className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
