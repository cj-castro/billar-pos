import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'
import { useSocket } from '../../hooks/useSocket'
import { useAuthStore } from '../../stores/authStore'

const BLANK_NEW = { name: '', unit: 'bottle', quantity: 0, low_stock_threshold: 6, category: 'beer', shots_per_bottle: '', item_type: 'STANDARD', yields_item_id: '' }

const CATEGORY_LABELS: Record<string, string> = {
  all: '📦 Todos',
  beer: '🍺 Cerveza',
  spirit: '🥃 Licores',
  mixer: '🧃 Mezcladores',
  food: '🍗 Comida',
  cigarette: '🚬 Cigarros',
  other: '📋 Otro',
}

const CATEGORY_ORDER = ['all', 'beer', 'spirit', 'mixer', 'food', 'cigarette', 'other']

export default function InventoryPage() {
  const qc = useQueryClient()
  const socket = useSocket()
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'ADMIN'
  const [tab, setTab] = useState('all')
  const [adjusting, setAdjusting] = useState<any>(null)
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [newItem, setNewItem] = useState({ ...BLANK_NEW })
  const [openingBottle, setOpeningBottle] = useState<any>(null)
  const [openingBox, setOpeningBox] = useState<any>(null)
  const [editing, setEditing] = useState<any>(null)
  const [editForm, setEditForm] = useState({ name: '', unit: 'bottle', category: 'beer', low_stock_threshold: 6, shots_per_bottle: '', item_type: 'STANDARD', yields_item_id: '' })
  const [viewingMovements, setViewingMovements] = useState<any>(null)
  const [addToMenu, setAddToMenu] = useState<any>(null)
  const [menuForm, setMenuForm] = useState({ category_id: '', price_cents: 0, requires_flavor: false })

  // Cigarette box socket alerts
  useEffect(() => {
    if (!socket) return
    socket.on('inventory:box_finished', (data: any) => {
      toast(`🚬 Caja terminada: ${data.brand} — abre una nueva caja`, {
        duration: 10000,
        icon: '📦',
        style: { background: '#7c2d12', color: '#fed7aa', border: '1px solid #c2410c' },
      })
      qc.invalidateQueries({ queryKey: ['open-boxes'] })
    })
    socket.on('inventory:box_low', (data: any) => {
      toast.error(`🚬 Quedan solo ${data.cigs_remaining} cigarros de ${data.brand}`, { duration: 6000 })
    })
    socket.on('inventory:box_opened', () => {
      qc.invalidateQueries({ queryKey: ['open-boxes'] })
      qc.invalidateQueries({ queryKey: ['inventory'] })
    })
    return () => {
      socket.off('inventory:box_finished')
      socket.off('inventory:box_low')
      socket.off('inventory:box_opened')
    }
  }, [socket])

  useEscKey(() => {
    if (viewingMovements) { setViewingMovements(null); return }
    if (editing) { setEditing(null); return }
    if (openingBottle) { setOpeningBottle(null); return }
    if (openingBox) { setOpeningBox(null); return }
    if (showNew) { setShowNew(false); return }
  }, showNew || !!openingBottle || !!openingBox || !!editing || !!viewingMovements)

  const { data: items = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => client.get('/inventory').then(r => r.data),
  })

  const { data: menuCategories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => client.get('/menu/categories').then(r => r.data),
  })

  const { data: menuItems = [] } = useQuery({
    queryKey: ['all-items'],
    queryFn: () => client.get('/menu/items', { params: { include_inactive: true } }).then(r => r.data),
  })

  const { data: movements = [], isFetching: loadingMovements } = useQuery({
    queryKey: ['inventory-movements', viewingMovements?.id],
    queryFn: () => client.get(`/inventory/${viewingMovements.id}/movements`).then(r => r.data),
    enabled: !!viewingMovements,
    staleTime: 0,
  })

  const { data: openBoxes = [] } = useQuery({
    queryKey: ['open-boxes'],
    queryFn: () => client.get('/inventory/open-boxes').then(r => r.data),
    refetchInterval: 30000,
  })

  const filtered = tab === 'all' ? items : items.filter((i: any) => i.category === tab)

  const handleAdjust = async () => {
    setSaving(true)
    try {
      await client.post(`/inventory/${adjusting.id}/adjust`, { qty_delta: parseInt(delta), reason })
      toast.success('Inventario ajustado')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setAdjusting(null); setDelta(''); setReason('')
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const handleCreate = async () => {
    if (!newItem.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      const payload: any = { ...newItem }
      if (!payload.shots_per_bottle) delete payload.shots_per_bottle
      else payload.shots_per_bottle = parseInt(payload.shots_per_bottle)
      await client.post('/inventory', payload)
      toast.success(`${newItem.name} añadido`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setShowNew(false); setNewItem({ ...BLANK_NEW })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al crear')
    } finally { setSaving(false) }
  }

  const handleEdit = async () => {
    if (!editForm.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      const payload: any = { ...editForm }
      if (!payload.shots_per_bottle) payload.shots_per_bottle = null
      else payload.shots_per_bottle = parseInt(payload.shots_per_bottle)
      await client.patch(`/inventory/${editing.id}`, payload)
      toast.success('Artículo actualizado')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setEditing(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const handleAddToMenu = async () => {
    if (!menuForm.category_id) return toast.error('Selecciona una categoría')
    if (menuForm.price_cents <= 0) return toast.error('El precio debe ser mayor a cero')
    setSaving(true)
    try {
      // Create menu item with same name
      const res = await client.post('/menu/items', {
        name: addToMenu.name,
        category_id: menuForm.category_id,
        price_cents: menuForm.price_cents,
        requires_flavor: menuForm.requires_flavor,
        sort_order: 0,
      })
      // Auto-link to this inventory item (1 unit consumed per sale)
      await client.post('/inventory/item-ingredients', {
        menu_item_id: res.data.id,
        inventory_item_id: addToMenu.id,
        quantity: 1,
      })
      toast.success(`"${addToMenu.name}" añadido al menú ✅`)
      qc.invalidateQueries({ queryKey: ['all-items'] })
      setAddToMenu(null)
      setMenuForm({ category_id: '', price_cents: 0, requires_flavor: false })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al agregar al menú')
    } finally { setSaving(false) }
  }

  const handleDelete = async (item: any) => {
    if (!window.confirm(`⚠️ ¿Eliminar permanentemente "${item.name}"?\n\nSe eliminarán todos los movimientos de stock históricos vinculados a este artículo.\n\nEsta acción no se puede deshacer.`)) return
    try {
      const res = await client.delete(`/inventory/${item.id}`)
      const moved = res.data?.movements_deleted ?? 0
      toast.success(`"${item.name}" eliminado${moved > 0 ? ` · ${moved} movimientos archivados en auditoría` : ''}`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al eliminar')
    }
  }

  const openEdit = (item: any) => {
    setEditForm({
      name: item.name,
      unit: item.unit,
      category: item.category,
      low_stock_threshold: item.low_stock_threshold,
      shots_per_bottle: item.shots_per_bottle ? String(item.shots_per_bottle) : '',
      item_type: item.item_type || 'STANDARD',
      yields_item_id: item.yields_item_id || '',
    })
    setEditing(item)
  }

  const handleOpenBottle = async () => {
    setSaving(true)
    try {
      await client.post(`/inventory/${openingBottle.id}/open-bottle`)
      toast.success(`🍾 ¡Botella abierta! +${openingBottle.shots_per_bottle} copas añadidas`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setOpeningBottle(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al abrir botella')
    } finally { setSaving(false) }
  }

  const handleOpenBox = async () => {
    setSaving(true)
    try {
      await client.post(`/inventory/${openingBox.id}/open-box`)
      toast.success(`🚬 ¡Caja abierta! +${openingBox.shots_per_bottle} cigarros disponibles`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['open-boxes'] })
      setOpeningBox(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al abrir caja')
    } finally { setSaving(false) }
  }

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-3xl mx-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">📦 Inventario</h1>
          <button onClick={() => setShowNew(true)} className="bg-sky-600 hover:bg-sky-500 px-4 py-1.5 rounded-lg text-sm font-semibold">+ Nuevo Artículo</button>
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
          {/* Active open cigarette boxes banner */}
          {(openBoxes as any[]).length > 0 && (
            <div className="mb-4 bg-orange-950/50 border border-orange-700 rounded-xl p-4">
              <div className="font-semibold text-orange-300 mb-3">🚬 Cajas Abiertas</div>
              <div className="space-y-2">
                {(openBoxes as any[]).map((box: any) => {
                  const pct = Math.round((box.cigs_sold / box.cigs_per_box) * 100)
                  const isLow = box.cigs_remaining <= 3
                  return (
                    <div key={box.id} className={`bg-slate-800 rounded-lg p-3 border ${isLow ? 'border-red-700' : 'border-slate-700'}`}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-semibold text-sm">{box.brand}</span>
                        <span className={`text-xs font-bold ${isLow ? 'text-red-400' : 'text-orange-300'}`}>
                          {box.cigs_remaining}/{box.cigs_per_box} restantes
                        </span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all ${isLow ? 'bg-red-500' : 'bg-orange-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        Abierta: {box.opened_at ? new Date(box.opened_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                        {box.opened_by && ` · ${box.opened_by}`}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {filtered.map((item: any) => (
            <div key={item.id} className={`bg-slate-800 rounded-xl p-4 flex items-center justify-between border ${item.is_low ? 'border-red-700' : 'border-slate-700'}`}>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{item.name}</div>
                <div className="text-xs text-slate-400">{item.unit} · {item.category}</div>
                {item.is_low && <div className="text-xs text-red-400 font-semibold">⚠ Stock Bajo</div>}
                {item.item_type === 'CIG_BOX' && item.shots_per_bottle && (
                  <div className="text-xs text-orange-400">🚬 {item.shots_per_bottle} cigarros/caja · {item.quantity} cajas selladas</div>
                )}
                {item.item_type === 'BOTTLE' && item.shots_per_bottle && (
                  <div className="text-xs text-amber-400">🍾 {item.shots_per_bottle} copas/botella · {item.quantity} selladas</div>
                )}
              </div>
              <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                <div className={`font-bold text-xl font-mono min-w-[2.5rem] text-right ${item.is_low ? 'text-red-400' : 'text-white'}`}>
                  {item.quantity}
                </div>
                {item.item_type === 'BOTTLE' && item.shots_per_bottle && item.yields_item_id && (
                  <button onClick={() => setOpeningBottle(item)}
                    className="bg-amber-700 hover:bg-amber-600 px-3 py-1 rounded-lg text-xs font-bold whitespace-nowrap">
                    🍾 Abrir
                  </button>
                )}
                {item.item_type === 'CIG_BOX' && item.shots_per_bottle && item.yields_item_id && (
                  <button onClick={() => setOpeningBox(item)}
                    className="bg-orange-700 hover:bg-orange-600 px-3 py-1 rounded-lg text-xs font-bold whitespace-nowrap">
                    🚬 Abrir
                  </button>
                )}
                <button onClick={() => openEdit(item)} className="bg-slate-700 hover:bg-sky-700 px-3 py-1 rounded-lg text-sm" title="Editar">✏️</button>
                {isAdmin && <button onClick={() => handleDelete(item)} className="bg-slate-700 hover:bg-red-800 px-3 py-1 rounded-lg text-sm text-red-400" title="Eliminar">🗑</button>}
                <button onClick={() => setViewingMovements(item)} className="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-lg text-sm text-slate-300" title="Ver movimientos">📋</button>
                <button onClick={() => setAdjusting(item)} className="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-lg text-sm">Ajustar</button>
                {(() => {
                  const inMenu = (menuItems as any[]).some((m: any) =>
                    m.name.toLowerCase() === item.name.toLowerCase()
                  )
                  return inMenu
                    ? <span className="text-xs text-emerald-400 font-semibold whitespace-nowrap">✅ En menú</span>
                    : <button onClick={() => { setAddToMenu(item); setMenuForm({ category_id: '', price_cents: 0, requires_flavor: false }) }}
                        className="bg-emerald-800 hover:bg-emerald-700 px-3 py-1 rounded-lg text-xs font-bold whitespace-nowrap">🍽️ Al Menú</button>
                })()}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center text-slate-500 py-8">Sin artículos en esta categoría</div>
          )}
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-sky-700">
            <h2 className="font-bold mb-4 text-sky-300">✏️ Editar Artículo</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Nombre *</label>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Categoría</label>
                  <select value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['beer', 'spirit', 'mixer', 'food', 'cigarette', 'other'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Unidad</label>
                  <select value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['bottle', 'shot', 'can', 'serving', 'ml', 'oz', 'cup', 'ramekin', 'lb', 'unit'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Umbral de Stock Bajo</label>
                <input type="number" min={0} value={editForm.low_stock_threshold}
                  onChange={(e) => setEditForm({ ...editForm, low_stock_threshold: parseInt(e.target.value) || 0 })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
              </div>
              {(editForm.category === 'spirit' || editForm.category === 'cigarette' || editing.shots_per_bottle) && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    {editForm.category === 'cigarette' ? 'Cigarros por caja' : 'Shots por botella'}
                  </label>
                  <input type="number" min={1} value={editForm.shots_per_bottle}
                    onChange={(e) => setEditForm({ ...editForm, shots_per_bottle: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder={editForm.category === 'cigarette' ? '20' : '15'} />
                </div>
              )}
              {(editForm.category === 'spirit' || editForm.category === 'cigarette') && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Tipo de artículo</label>
                  <select value={editForm.item_type} onChange={(e) => setEditForm({ ...editForm, item_type: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    <option value="STANDARD">Estándar</option>
                    <option value="BOTTLE">Botella (licor)</option>
                    <option value="CIG_BOX">Caja de cigarros</option>
                    <option value="CIG_SINGLE">Cigarro individual</option>
                  </select>
                </div>
              )}
              {(editForm.item_type === 'BOTTLE' || editForm.item_type === 'CIG_BOX') && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    {editForm.item_type === 'CIG_BOX' ? '🚬 Artículo individual que produce' : '🍾 Copa/Shot que produce'}
                  </label>
                  <select value={editForm.yields_item_id} onChange={(e) => setEditForm({ ...editForm, yields_item_id: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    <option value="">— Sin vincular —</option>
                    {(items as any[])
                      .filter((i: any) => editForm.item_type === 'CIG_BOX' ? i.item_type === 'CIG_SINGLE' : i.item_type === 'STANDARD' && i.id !== editing?.id)
                      .map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setEditing(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              {isAdmin && <button onClick={() => { setEditing(null); handleDelete(editing) }}
                className="py-2 px-4 bg-red-900 hover:bg-red-700 text-red-300 rounded-lg text-sm font-semibold">🗑 Eliminar</button>}
              <button onClick={handleEdit} disabled={!editForm.name.trim() || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Adjust modal */}
      {adjusting && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600">
            <h2 className="font-bold mb-1">Ajustar Inventario</h2>
            <p className="text-slate-400 text-sm mb-4">{adjusting.name} · Actual: {adjusting.quantity} {adjusting.unit}</p>
            <div className="mb-3">
              <label className="text-sm text-slate-400 block mb-1">Cambio de Cantidad (+ o -)</label>
              <input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="+10 o -5" />
            </div>
            <div className="mb-4">
              <label className="text-sm text-slate-400 block mb-1">Motivo *</label>
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2">
                <option value="">— Seleccionar motivo —</option>
                <option value="Reabasto">📦 Reabasto</option>
                <option value="Derrame">💧 Derrame</option>
                <option value="Caducado">⏰ Caducado</option>
                <option value="Conteo">🔢 Conteo de inventario</option>
                <option value="Merma">🗑️ Merma / Desperdicio</option>
                <option value="Ajuste">⚙️ Ajuste manual</option>
              </select>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setAdjusting(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleAdjust} disabled={!delta || !reason || saving} className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Open bottle modal */}
      {openingBottle && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-amber-700">
            <h2 className="font-bold mb-1 text-amber-300">🍾 Abrir Botella</h2>
            <p className="text-slate-300 mb-4">
              ¿Abrir <span className="font-bold text-white">{openingBottle.name}</span>?<br />
              <span className="text-sm text-slate-400">
                Consume 1 botella sellada y añade <span className="text-amber-300 font-bold">{openingBottle.shots_per_bottle} copas</span> al inventario.
              </span>
            </p>
            <p className="text-sm text-slate-400 mb-5">
              Botellas selladas restantes: <span className="font-bold text-white">{openingBottle.quantity}</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => setOpeningBottle(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleOpenBottle} disabled={saving || openingBottle.quantity < 1}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg font-bold disabled:opacity-50 text-slate-900">
                Abrir Botella
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Open cigarette box modal */}
      {openingBox && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-orange-700">
            <h2 className="font-bold mb-1 text-orange-300">🚬 Abrir Caja de Cigarros</h2>
            <p className="text-slate-300 mb-4">
              ¿Abrir <span className="font-bold text-white">{openingBox.name}</span>?<br />
              <span className="text-sm text-slate-400">
                Consume 1 caja sellada y añade <span className="text-orange-300 font-bold">{openingBox.shots_per_bottle} cigarros individuales</span> al inventario.
              </span>
            </p>
            <p className="text-sm text-slate-400 mb-5">
              Cajas selladas restantes: <span className="font-bold text-white">{openingBox.quantity}</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => setOpeningBox(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleOpenBox} disabled={saving || openingBox.quantity < 1}
                className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg font-bold disabled:opacity-50">
                Abrir Caja
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New item modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600">
            <h2 className="font-bold mb-4">Agregar Artículo de Inventario</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Nombre *</label>
                <input value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="Corona Botella" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Categoría</label>
                  <select value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['beer', 'spirit', 'mixer', 'food', 'cigarette', 'other'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Unidad</label>
                  <select value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['bottle', 'shot', 'can', 'serving', 'ml', 'oz', 'cup', 'ramekin', 'lb', 'unit'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Cant. Inicial</label>
                  <input type="number" min={0} value={newItem.quantity} onChange={(e) => setNewItem({ ...newItem, quantity: parseInt(e.target.value) || 0 })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Umbral de Stock Bajo</label>
                  <input type="number" min={0} value={newItem.low_stock_threshold} onChange={(e) => setNewItem({ ...newItem, low_stock_threshold: parseInt(e.target.value) || 0 })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
              </div>
              {(newItem.category === 'spirit' || newItem.category === 'cigarette') && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    {newItem.category === 'cigarette' ? 'Cigarros por caja' : 'Shots por botella'}
                  </label>
                  <input type="number" min={1} value={newItem.shots_per_bottle} onChange={(e) => setNewItem({ ...newItem, shots_per_bottle: e.target.value })} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder={newItem.category === 'cigarette' ? '20' : '15'} />
                </div>
              )}
              {(newItem.category === 'spirit' || newItem.category === 'cigarette') && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Tipo de artículo</label>
                  <select value={newItem.item_type} onChange={(e) => setNewItem({ ...newItem, item_type: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    <option value="STANDARD">Estándar</option>
                    <option value="BOTTLE">Botella (licor)</option>
                    <option value="CIG_BOX">Caja de cigarros</option>
                    <option value="CIG_SINGLE">Cigarro individual</option>
                  </select>
                </div>
              )}
              {(newItem.item_type === 'BOTTLE' || newItem.item_type === 'CIG_BOX') && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    {newItem.item_type === 'CIG_BOX' ? '🚬 Artículo individual que produce' : '🍾 Copa/Shot que produce'}
                  </label>
                  <select value={newItem.yields_item_id} onChange={(e) => setNewItem({ ...newItem, yields_item_id: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    <option value="">— Sin vincular —</option>
                    {(items as any[])
                      .filter((i: any) => newItem.item_type === 'CIG_BOX' ? i.item_type === 'CIG_SINGLE' : i.item_type === 'STANDARD')
                      .map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowNew(false); setNewItem({ ...BLANK_NEW }) }} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleCreate} disabled={!newItem.name.trim() || saving} className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Agregar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Movements modal ────────────────────────────────────────────────── */}
      {viewingMovements && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-600 flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <div>
                <h2 className="font-bold">📋 Movimientos: {viewingMovements.name}</h2>
                <p className="text-xs text-slate-400 mt-0.5">Stock actual: {viewingMovements.quantity} {viewingMovements.unit}</p>
              </div>
              <button onClick={() => setViewingMovements(null)} className="text-slate-400 hover:text-white text-xl px-2">✕</button>
            </div>

            <div className="overflow-y-auto flex-1 p-4">
              {loadingMovements && <div className="text-center text-slate-400 py-8">Cargando…</div>}
              {!loadingMovements && (movements as any[]).length === 0 && (
                <div className="text-center text-slate-500 py-8">Sin movimientos registrados</div>
              )}
              {!loadingMovements && (movements as any[]).length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 border-b border-slate-700">
                      <th className="text-left pb-2 pr-2">Fecha</th>
                      <th className="text-left pb-2 pr-2">Tipo</th>
                      <th className="text-right pb-2 pr-2">Δ</th>
                      <th className="text-right pb-2 pr-3">Stock</th>
                      <th className="text-left pb-2 pr-2">Usuario</th>
                      <th className="text-left pb-2">Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(movements as any[]).map((m: any) => {
                      const positive = m.quantity_delta > 0
                      const typeColor: Record<string, string> = {
                        SALE_CONSUMPTION: 'text-red-400',
                        VOID_REVERSAL: 'text-green-400',
                        MANUAL_ADJUSTMENT: 'text-sky-400',
                        BOTTLE_OPENED: 'text-amber-400',
                        BOX_OPENED: 'text-orange-400',
                        OPENING_STOCK: 'text-purple-400',
                      }
                      const typeLabel: Record<string, string> = {
                        SALE_CONSUMPTION: 'Venta',
                        VOID_REVERSAL: 'Reversa',
                        MANUAL_ADJUSTMENT: 'Ajuste',
                        BOTTLE_OPENED: 'Botella abierta',
                        BOX_OPENED: 'Caja abierta',
                        OPENING_STOCK: 'Stock inicial',
                      }
                      return (
                        <tr key={m.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                          <td className="py-2 text-xs text-slate-400 whitespace-nowrap pr-2">
                            {new Date(m.created_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}
                          </td>
                          <td className={`py-2 text-xs font-medium whitespace-nowrap pr-2 ${typeColor[m.event_type] ?? 'text-slate-300'}`}>
                            {typeLabel[m.event_type] ?? m.event_type}
                          </td>
                          <td className={`py-2 text-right font-mono font-bold pr-2 ${positive ? 'text-green-400' : 'text-red-400'}`}>
                            {positive ? '+' : ''}{m.quantity_delta}
                          </td>
                          <td className="py-2 text-right font-mono text-slate-200 pr-3">
                            {m.quantity_after ?? '—'}
                          </td>
                          <td className="py-2 text-xs text-slate-400 whitespace-nowrap pr-2">
                            {m.performer_name ?? '—'}
                          </td>
                          <td className="py-2 text-xs text-slate-400 truncate max-w-[140px]">
                            {m.reason || m.reference_id || '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="p-4 border-t border-slate-700 flex justify-between items-center">
              <span className="text-xs text-slate-500">{(movements as any[]).length} movimiento{(movements as any[]).length !== 1 ? 's' : ''} (últimos 200)</span>
              <button onClick={() => setViewingMovements(null)} className="px-4 py-1.5 border border-slate-600 rounded-lg text-sm">Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Agregar al Menú modal ─────────────────────────────────────────── */}
      {addToMenu && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-emerald-700 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">🍽️ Agregar al Menú</h2>
              <p className="text-slate-400 text-sm mt-1">
                <span className="text-white font-semibold">{addToMenu.name}</span> — al vender se descontará 1 {addToMenu.unit} del inventario automáticamente
              </p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Categoría del menú *</label>
                <select value={menuForm.category_id}
                  onChange={e => setMenuForm({ ...menuForm, category_id: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2">
                  <option value="">— selecciona categoría —</option>
                  {(menuCategories as any[]).map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.routing})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Precio de venta (centavos) *</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} value={menuForm.price_cents}
                    onChange={e => setMenuForm({ ...menuForm, price_cents: parseInt(e.target.value) || 0 })}
                    className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono"
                    placeholder="ej. 5000 = $50.00" />
                  <span className="text-slate-400 text-sm">${(menuForm.price_cents / 100).toFixed(2)}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input type="checkbox" id="add-flavor" checked={menuForm.requires_flavor}
                  onChange={e => setMenuForm({ ...menuForm, requires_flavor: e.target.checked })} className="w-4 h-4" />
                <label htmlFor="add-flavor" className="text-sm text-slate-300">Requiere selección de sabor</label>
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button onClick={() => setAddToMenu(null)}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">Cancelar</button>
              <button onClick={handleAddToMenu} disabled={!menuForm.category_id || menuForm.price_cents <= 0 || saving}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-bold disabled:opacity-50">
                {saving ? 'Agregando…' : '✅ Agregar al Menú'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
