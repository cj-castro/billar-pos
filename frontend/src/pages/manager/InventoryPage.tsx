import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'

const BLANK_NEW = { name: '', unit: 'bottle', quantity: 0, low_stock_threshold: 6, category: 'beer', shots_per_bottle: '' }

const CATEGORY_LABELS: Record<string, string> = {
  all: '📦 All',
  beer: '🍺 Beer',
  spirit: '🥃 Spirits',
  mixer: '🧃 Mixers',
  food: '🍗 Food',
  other: '📋 Other',
}

const CATEGORY_ORDER = ['all', 'beer', 'spirit', 'mixer', 'food', 'other']

export default function InventoryPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState('all')
  const [adjusting, setAdjusting] = useState<any>(null)
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [newItem, setNewItem] = useState({ ...BLANK_NEW })
  const [openingBottle, setOpeningBottle] = useState<any>(null)
  const [editing, setEditing] = useState<any>(null)
  const [editForm, setEditForm] = useState({ name: '', unit: 'bottle', category: 'beer', low_stock_threshold: 6, shots_per_bottle: '' })

  useEscKey(() => {
    if (editing) { setEditing(null); return }
    if (openingBottle) { setOpeningBottle(null); return }
    if (showNew) { setShowNew(false); return }
  }, showNew || !!openingBottle || !!editing)

  const { data: items = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => client.get('/inventory').then(r => r.data),
  })

  const filtered = tab === 'all' ? items : items.filter((i: any) => i.category === tab)

  const handleAdjust = async () => {
    setSaving(true)
    try {
      await client.post(`/inventory/${adjusting.id}/adjust`, { qty_delta: parseInt(delta), reason })
      toast.success('Inventory adjusted')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setAdjusting(null); setDelta(''); setReason('')
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed')
    } finally { setSaving(false) }
  }

  const handleCreate = async () => {
    if (!newItem.name.trim()) return toast.error('Name is required')
    setSaving(true)
    try {
      const payload: any = { ...newItem }
      if (!payload.shots_per_bottle) delete payload.shots_per_bottle
      else payload.shots_per_bottle = parseInt(payload.shots_per_bottle)
      await client.post('/inventory', payload)
      toast.success(`${newItem.name} added`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setShowNew(false); setNewItem({ ...BLANK_NEW })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed')
    } finally { setSaving(false) }
  }

  const handleEdit = async () => {
    if (!editForm.name.trim()) return toast.error('Name is required')
    setSaving(true)
    try {
      const payload: any = { ...editForm }
      if (!payload.shots_per_bottle) payload.shots_per_bottle = null
      else payload.shots_per_bottle = parseInt(payload.shots_per_bottle)
      await client.patch(`/inventory/${editing.id}`, payload)
      toast.success('Item updated')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setEditing(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed')
    } finally { setSaving(false) }
  }

  const openEdit = (item: any) => {
    setEditForm({
      name: item.name,
      unit: item.unit,
      category: item.category,
      low_stock_threshold: item.low_stock_threshold,
      shots_per_bottle: item.shots_per_bottle ? String(item.shots_per_bottle) : '',
    })
    setEditing(item)
  }

  const handleOpenBottle = async () => {
    setSaving(true)
    try {
      await client.post(`/inventory/${openingBottle.id}/open-bottle`)
      toast.success(`🍾 Bottle opened! +${openingBottle.shots_per_bottle} shots added`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setOpeningBottle(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <NavBar />
      <div className="max-w-3xl mx-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">📦 Inventory</h1>
          <button onClick={() => setShowNew(true)} className="bg-sky-600 hover:bg-sky-500 px-4 py-1.5 rounded-lg text-sm font-semibold">+ New Item</button>
        </div>

        {/* Category tabs */}
        <div className="flex gap-1.5 flex-wrap mb-4">
          {CATEGORY_ORDER.map(cat => (
            <button key={cat} onClick={() => setTab(cat)}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                tab === cat ? 'bg-yellow-600 border-yellow-500 text-slate-900' : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500'
              }`}>
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {filtered.map((item: any) => (
            <div key={item.id} className={`bg-slate-800 rounded-xl p-4 flex items-center justify-between border ${item.is_low ? 'border-red-700' : 'border-slate-700'}`}>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{item.name}</div>
                <div className="text-xs text-slate-400">{item.unit} · {item.category}</div>
                {item.is_low && <div className="text-xs text-red-400 font-semibold">⚠ Low Stock</div>}
                {item.shots_per_bottle && (
                  <div className="text-xs text-amber-400">🍾 {item.shots_per_bottle} shots/bottle · {item.quantity} sealed</div>
                )}
              </div>
              <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                <div className={`font-bold text-xl font-mono min-w-[2.5rem] text-right ${item.is_low ? 'text-red-400' : 'text-white'}`}>
                  {item.quantity}
                </div>
                {item.shots_per_bottle && item.yields_item_id && (
                  <button onClick={() => setOpeningBottle(item)}
                    className="bg-amber-700 hover:bg-amber-600 px-3 py-1 rounded-lg text-xs font-bold whitespace-nowrap">
                    🍾 Open
                  </button>
                )}
                <button onClick={() => openEdit(item)} className="bg-slate-700 hover:bg-sky-700 px-3 py-1 rounded-lg text-sm" title="Edit item">✏️</button>
                <button onClick={() => setAdjusting(item)} className="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-lg text-sm">Adjust</button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center text-slate-500 py-8">No items in this category</div>
          )}
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-sky-700">
            <h2 className="font-bold mb-4 text-sky-300">✏️ Edit Item</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Name *</label>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Category</label>
                  <select value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['beer', 'spirit', 'mixer', 'food', 'other'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Unit</label>
                  <select value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['bottle', 'shot', 'can', 'serving', 'ml', 'oz', 'cup', 'ramekin', 'lb', 'unit'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Low Stock Alert Threshold</label>
                <input type="number" min={0} value={editForm.low_stock_threshold}
                  onChange={(e) => setEditForm({ ...editForm, low_stock_threshold: parseInt(e.target.value) || 0 })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
              </div>
              {(editForm.category === 'spirit' || editing.shots_per_bottle) && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Shots per Bottle</label>
                  <input type="number" min={1} value={editForm.shots_per_bottle}
                    onChange={(e) => setEditForm({ ...editForm, shots_per_bottle: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="15" />
                  <p className="text-xs text-slate-500 mt-1">Leave empty to remove shots-per-bottle tracking</p>
                </div>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setEditing(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancel</button>
              <button onClick={handleEdit} disabled={!editForm.name.trim() || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Adjust modal */}
      {adjusting && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600">
            <h2 className="font-bold mb-1">Adjust Inventory</h2>
            <p className="text-slate-400 text-sm mb-4">{adjusting.name} · Current: {adjusting.quantity} {adjusting.unit}</p>
            <div className="mb-3">
              <label className="text-sm text-slate-400 block mb-1">Quantity Change (+ or -)</label>
              <input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="+10 or -5" />
            </div>
            <div className="mb-4">
              <label className="text-sm text-slate-400 block mb-1">Reason *</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="Restock, spillage, etc." />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setAdjusting(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancel</button>
              <button onClick={handleAdjust} disabled={!delta || !reason || saving} className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Open bottle modal */}
      {openingBottle && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-amber-700">
            <h2 className="font-bold mb-1 text-amber-300">🍾 Open Bottle</h2>
            <p className="text-slate-300 mb-4">
              Open <span className="font-bold text-white">{openingBottle.name}</span>?<br />
              <span className="text-sm text-slate-400">
                This will consume 1 sealed bottle and add <span className="text-amber-300 font-bold">{openingBottle.shots_per_bottle} shots</span> to inventory.
              </span>
            </p>
            <p className="text-sm text-slate-400 mb-5">
              Sealed bottles remaining: <span className="font-bold text-white">{openingBottle.quantity}</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => setOpeningBottle(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancel</button>
              <button onClick={handleOpenBottle} disabled={saving || openingBottle.quantity < 1}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg font-bold disabled:opacity-50 text-slate-900">
                Open Bottle
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New item modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600">
            <h2 className="font-bold mb-4">Add Inventory Item</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Name *</label>
                <input value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="Corona Bottle" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Category</label>
                  <select value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['beer', 'spirit', 'mixer', 'food', 'other'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Unit</label>
                  <select value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['bottle', 'shot', 'can', 'serving', 'ml', 'oz', 'cup', 'ramekin', 'lb', 'unit'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Initial Qty</label>
                  <input type="number" min={0} value={newItem.quantity} onChange={(e) => setNewItem({ ...newItem, quantity: parseInt(e.target.value) || 0 })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Low Stock Alert</label>
                  <input type="number" min={0} value={newItem.low_stock_threshold} onChange={(e) => setNewItem({ ...newItem, low_stock_threshold: parseInt(e.target.value) || 0 })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
              </div>
              {newItem.category === 'spirit' && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Shots per Bottle (if spirit bottle)</label>
                  <input type="number" min={1} value={newItem.shots_per_bottle} onChange={(e) => setNewItem({ ...newItem, shots_per_bottle: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="15" />
                  <p className="text-xs text-slate-500 mt-1">Leave empty if this is a shots item (not a bottle)</p>
                </div>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowNew(false); setNewItem({ ...BLANK_NEW }) }} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancel</button>
              <button onClick={handleCreate} disabled={!newItem.name.trim() || saving} className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
