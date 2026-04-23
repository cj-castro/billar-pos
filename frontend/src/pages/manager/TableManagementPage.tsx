import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'

type ResourceType = 'POOL_TABLE' | 'REGULAR_TABLE' | 'BAR_SEAT'

interface Resource {
  id: string
  code: string
  name: string
  type: ResourceType
  status: string
  is_active: boolean
  sort_order: number
  pool_config?: {
    billing_mode: string
    rate_cents: number
    promo_free_minutes: number
  }
  active_ticket_id?: string | null
}

const BILLING_MODES = [
  { value: 'PER_MINUTE', label: 'Per Minute (exact)' },
  { value: 'ROUND_15', label: 'Round to 15 min (↑)' },
  { value: 'PER_HOUR', label: 'Per Hour (full block)' },
]

const TYPE_LABELS: Record<ResourceType, string> = {
  POOL_TABLE: '🎱 Pool Tables',
  REGULAR_TABLE: '🪑 Floor Tables',
  BAR_SEAT: '🍺 Bar Seats',
}

const TYPE_ICONS: Record<ResourceType, string> = {
  POOL_TABLE: '🎱',
  REGULAR_TABLE: '🪑',
  BAR_SEAT: '🍺',
}

const TYPE_CODE_PREFIX: Record<ResourceType, string> = {
  POOL_TABLE: 'PT',
  REGULAR_TABLE: 'T',
  BAR_SEAT: 'Bar-',
}

export default function TableManagementPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<ResourceType>('POOL_TABLE')
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ code: '', name: '', type: tab as ResourceType, sort_order: 0, billing_mode: 'PER_MINUTE', rate_cents: 8600, promo_free_minutes: 0 })
  const [editingPool, setEditingPool] = useState<Record<string, Partial<Resource['pool_config']>>>({})
  const [editingName, setEditingName] = useState<Record<string, { code: string; name: string }>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  useEscKey(() => setShowAdd(false), showAdd)

  const { data: resources = [], isLoading } = useQuery<Resource[]>({
    queryKey: ['resources-all'],
    queryFn: () => client.get('/resources?include_inactive=true').then(r => r.data),
  })

  const allResources = resources as Resource[]
  const filtered = allResources.filter(r => r.type === tab)
  const active = filtered.filter(r => r.is_active)
  const inactive = filtered.filter(r => !r.is_active)

  const openAddModal = () => {
    const prefix = TYPE_CODE_PREFIX[tab]
    const existing = filtered.filter(r => r.is_active).length
    setAddForm({ code: `${prefix}${existing + 1}`, name: `${TYPE_ICONS[tab]} Table ${existing + 1}`, type: tab, sort_order: existing + 1, billing_mode: 'PER_MINUTE', rate_cents: 8600, promo_free_minutes: 0 })
    setShowAdd(true)
  }

  const handleAdd = async () => {
    if (!addForm.code.trim() || !addForm.name.trim()) { toast.error('Code and name required'); return }
    try {
      const res = await client.post('/resources', {
        code: addForm.code.trim().toUpperCase(),
        name: addForm.name.trim(),
        type: addForm.type,
        sort_order: addForm.sort_order,
      })
      if (addForm.type === 'POOL_TABLE') {
        await client.patch(`/resources/${res.data.id}/pool-config`, {
          billing_mode: addForm.billing_mode,
          rate_cents: Number(addForm.rate_cents),
          promo_free_minutes: Number(addForm.promo_free_minutes),
        })
      }
      toast.success(`${addForm.code} added!`)
      qc.invalidateQueries({ queryKey: ['resources-all'] })
      qc.invalidateQueries({ queryKey: ['resources'] })
      setShowAdd(false)
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add')
    }
  }

  const handleSaveName = async (r: Resource) => {
    const edits = editingName[r.id] ?? { code: r.code, name: r.name }
    setSavingId(r.id)
    try {
      await client.patch(`/resources/${r.id}`, { name: edits.name, sort_order: r.sort_order })
      toast.success('Saved')
      qc.invalidateQueries({ queryKey: ['resources-all'] })
      setEditingName(prev => { const n = { ...prev }; delete n[r.id]; return n })
    } catch { toast.error('Failed to save') }
    setSavingId(null)
  }

  const handleSavePool = async (r: Resource) => {
    const edits = editingPool[r.id] ?? {}
    const base = r.pool_config ?? { billing_mode: 'PER_MINUTE', rate_cents: 8600, promo_free_minutes: 0 }
    setSavingId(r.id + '-pool')
    try {
      await client.patch(`/resources/${r.id}/pool-config`, {
        billing_mode: edits.billing_mode ?? base.billing_mode,
        rate_cents: Number(edits.rate_cents ?? base.rate_cents),
        promo_free_minutes: Number(edits.promo_free_minutes ?? base.promo_free_minutes),
      })
      toast.success(`${r.code} billing saved`)
      qc.invalidateQueries({ queryKey: ['resources-all'] })
      setEditingPool(prev => { const n = { ...prev }; delete n[r.id]; return n })
    } catch { toast.error('Failed to save') }
    setSavingId(null)
  }

  const handleToggleActive = async (r: Resource) => {
    if (r.active_ticket_id && r.is_active) { toast.error('Cannot deactivate — table has an open ticket'); return }
    try {
      await client.patch(`/resources/${r.id}`, { is_active: !r.is_active })
      toast.success(r.is_active ? `${r.code} deactivated` : `${r.code} reactivated`)
      qc.invalidateQueries({ queryKey: ['resources-all'] })
      qc.invalidateQueries({ queryKey: ['resources'] })
    } catch { toast.error('Failed to update') }
  }

  const handleDelete = async (r: Resource) => {
    if (!window.confirm(`Permanently remove ${r.code}? This cannot be undone.`)) return
    try {
      await client.delete(`/resources/${r.id}`)
      toast.success(`${r.code} removed`)
      qc.invalidateQueries({ queryKey: ['resources-all'] })
      qc.invalidateQueries({ queryKey: ['resources'] })
    } catch (err: any) {
      toast.error(err.response?.data?.error === 'TABLE_HAS_OPEN_TICKET' ? 'Table has an open ticket' : 'Failed to remove')
    }
  }

  const patchName = (id: string, field: 'code' | 'name', val: string) => {
    setEditingName(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), [field]: val } as { code: string; name: string } }))
  }

  const patchPool = (id: string, field: string, val: any) => {
    setEditingPool(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), [field]: val } }))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-4xl mx-auto p-4">
        <h1 className="text-2xl font-bold mb-6">🗂 Table & Seat Management</h1>

        {/* Type tabs */}
        <div className="flex gap-2 mb-6">
          {(Object.keys(TYPE_LABELS) as ResourceType[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${tab === t ? 'bg-sky-600' : 'bg-slate-800 hover:bg-slate-700'}`}>
              {TYPE_LABELS[t]}
              <span className="ml-2 bg-slate-700 text-slate-300 text-xs px-1.5 py-0.5 rounded-full">
                {allResources.filter(r => r.type === t && r.is_active).length}
              </span>
            </button>
          ))}
        </div>

        {/* Add button */}
        <div className="flex justify-end mb-4">
          <button onClick={openAddModal}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded-xl text-sm font-bold">
            + Add {tab === 'POOL_TABLE' ? 'Pool Table' : tab === 'REGULAR_TABLE' ? 'Floor Table' : 'Bar Seat'}
          </button>
        </div>

        {isLoading && <div className="text-slate-400 text-center py-12">Loading…</div>}

        {/* Active resources */}
        <div className="space-y-3">
          {active.map(r => {
            const nameEdits = editingName[r.id]
            const poolEdits = editingPool[r.id]
            const poolBase = r.pool_config ?? { billing_mode: 'PER_MINUTE', rate_cents: 8600, promo_free_minutes: 0 }
            const nameDirty = !!nameEdits
            const poolDirty = !!poolEdits

            return (
              <div key={r.id} className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                {/* Header row */}
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-lg">{TYPE_ICONS[r.type]}</span>
                  <input
                    value={nameEdits?.name ?? r.name}
                    onChange={e => patchName(r.id, 'name', e.target.value)}
                    className="bg-slate-700 rounded-lg px-3 py-1.5 text-sm font-semibold flex-1"
                    placeholder="Display name"
                  />
                  <span className="font-mono text-xs text-slate-400 bg-slate-700 px-2 py-1 rounded">{r.code}</span>
                  {nameDirty && (
                    <button onClick={() => handleSaveName(r)} disabled={savingId === r.id}
                      className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded-lg text-xs font-bold">
                      {savingId === r.id ? '…' : 'Save'}
                    </button>
                  )}
                  <button onClick={() => handleToggleActive(r)}
                    className="px-3 py-1 bg-slate-600 hover:bg-orange-600 rounded-lg text-xs text-slate-300"
                    title="Deactivate (hide from floor)">
                    Deactivate
                  </button>
                </div>

                {/* Pool billing config */}
                {r.type === 'POOL_TABLE' && (
                  <div className="bg-slate-900 rounded-lg p-3 mt-1">
                    <div className="text-xs text-slate-400 mb-2 font-semibold">Billing Config</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Mode</label>
                        <select
                          value={(poolEdits?.billing_mode ?? poolBase.billing_mode) as string}
                          onChange={e => patchPool(r.id, 'billing_mode', e.target.value)}
                          className="w-full bg-slate-700 rounded-lg px-2 py-1.5 text-xs">
                          {BILLING_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Rate (pesos/hr)</label>
                        <input type="number" min={0}
                          value={poolEdits?.rate_cents ?? poolBase.rate_cents}
                          onChange={e => patchPool(r.id, 'rate_cents', e.target.value)}
                          className="w-full bg-slate-700 rounded-lg px-2 py-1.5 text-xs" />
                        <div className="text-xs text-slate-500 mt-0.5">= ${(Number(poolEdits?.rate_cents ?? poolBase.rate_cents) / 100).toFixed(2)}/hr</div>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Free First (min)</label>
                        <input type="number" min={0}
                          value={poolEdits?.promo_free_minutes ?? poolBase.promo_free_minutes}
                          onChange={e => patchPool(r.id, 'promo_free_minutes', e.target.value)}
                          className="w-full bg-slate-700 rounded-lg px-2 py-1.5 text-xs" />
                      </div>
                    </div>
                    {poolDirty && (
                      <div className="mt-2 flex justify-end">
                        <button onClick={() => handleSavePool(r)} disabled={savingId === r.id + '-pool'}
                          className="px-4 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-xs font-bold">
                          {savingId === r.id + '-pool' ? 'Saving…' : 'Save Billing'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {r.active_ticket_id && (
                  <div className="mt-2 text-xs text-yellow-400">⚠ Currently in use</div>
                )}
              </div>
            )
          })}
        </div>

        {/* Inactive section */}
        {inactive.length > 0 && (
          <div className="mt-8">
            <div className="text-sm text-slate-500 font-semibold mb-3">Deactivated</div>
            <div className="space-y-2">
              {inactive.map(r => (
                <div key={r.id} className="bg-slate-900 rounded-xl p-3 flex items-center gap-3 opacity-60">
                  <span>{TYPE_ICONS[r.type]}</span>
                  <span className="font-mono text-xs text-slate-400">{r.code}</span>
                  <span className="text-slate-400 text-sm flex-1">{r.name}</span>
                  <button onClick={() => handleToggleActive(r)}
                    className="px-3 py-1 bg-sky-700 hover:bg-sky-600 rounded-lg text-xs">
                    Reactivate
                  </button>
                  <button onClick={() => handleDelete(r)}
                    className="px-3 py-1 bg-red-800 hover:bg-red-700 rounded-lg text-xs text-red-200">
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {active.length === 0 && !isLoading && (
          <div className="text-center py-16 text-slate-500">
            <div className="text-4xl mb-3">{TYPE_ICONS[tab]}</div>
            <p>No active {TYPE_LABELS[tab].toLowerCase()}.</p>
            <button onClick={openAddModal} className="mt-4 px-6 py-2 bg-green-600 hover:bg-green-500 rounded-xl text-sm font-bold">
              Add First One
            </button>
          </div>
        )}
      </div>

      {/* Add Modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-md border border-slate-700">
            <h2 className="text-lg font-bold mb-4">Add {TYPE_LABELS[addForm.type]}</h2>

            {/* Type switcher inside modal */}
            <div className="flex gap-2 mb-4">
              {(Object.keys(TYPE_LABELS) as ResourceType[]).map(t => (
                <button key={t} onClick={() => {
                  const prefix = TYPE_CODE_PREFIX[t]
                  const existing = allResources.filter(r => r.type === t && r.is_active).length
                  setAddForm(f => ({ ...f, type: t, code: `${prefix}${existing + 1}`, name: `${TYPE_ICONS[t]} ${t === 'POOL_TABLE' ? 'Pool Table' : t === 'REGULAR_TABLE' ? 'Table' : 'Bar'} ${existing + 1}` }))
                }}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold ${addForm.type === t ? 'bg-sky-600' : 'bg-slate-700 hover:bg-slate-600'}`}>
                  {TYPE_ICONS[t]}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Code (e.g. PT6, T15, Bar-05)</label>
                <input
                  value={addForm.code}
                  onChange={e => setAddForm(f => ({ ...f, code: e.target.value }))}
                  className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm font-mono uppercase"
                  placeholder="PT6"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Display Name</label>
                <input
                  value={addForm.name}
                  onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm"
                  placeholder="Pool Table 6"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Sort Order</label>
                <input type="number" min={0}
                  value={addForm.sort_order}
                  onChange={e => setAddForm(f => ({ ...f, sort_order: Number(e.target.value) }))}
                  className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>

              {addForm.type === 'POOL_TABLE' && (
                <div className="bg-slate-900 rounded-xl p-3 space-y-3 border border-slate-700">
                  <div className="text-xs text-slate-400 font-semibold">Billing Config</div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Billing Mode</label>
                    <select value={addForm.billing_mode} onChange={e => setAddForm(f => ({ ...f, billing_mode: e.target.value }))}
                      className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm">
                      {BILLING_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Rate (pesos/hr) — e.g. 8600 = $86/hr</label>
                    <input type="number" min={0} value={addForm.rate_cents}
                      onChange={e => setAddForm(f => ({ ...f, rate_cents: Number(e.target.value) }))}
                      className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm" />
                    <div className="text-xs text-slate-500 mt-0.5">= ${(addForm.rate_cents / 100).toFixed(2)} / hour</div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Free First Minutes (0 = no promo)</label>
                    <input type="number" min={0} value={addForm.promo_free_minutes}
                      onChange={e => setAddForm(f => ({ ...f, promo_free_minutes: Number(e.target.value) }))}
                      className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm" />
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowAdd(false)}
                className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm">Cancel</button>
              <button onClick={handleAdd}
                className="flex-1 py-2 bg-green-600 hover:bg-green-500 rounded-xl font-bold text-sm">
                Add {TYPE_ICONS[addForm.type]} {addForm.code || '…'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
