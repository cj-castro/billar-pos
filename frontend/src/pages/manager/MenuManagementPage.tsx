import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useAuthStore } from '../../stores/authStore'

function cents(n: number) { return `$${(n / 100).toFixed(2)}` }

const BLANK_ITEM = { name: '', price_cents: 0, category_id: '', requires_flavor: false, sort_order: 0 }
const BLANK_CAT = { name: '', routing: 'BAR', sort_order: 0 }

export default function MenuManagementPage() {
  const qc = useQueryClient()
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'ADMIN'

  const [editItem, setEditItem] = useState<any>(null)
  const [editItemGroups, setEditItemGroups] = useState<string[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [newItem, setNewItem] = useState({ ...BLANK_ITEM })
  const [saving, setSaving] = useState(false)
  // Confirmation dialog for deactivate
  const [confirmDeactivate, setConfirmDeactivate] = useState<any>(null)
  // Recipe management
  const [recipeItem, setRecipeItem] = useState<any>(null)
  const [recipeItemFull, setRecipeItemFull] = useState<any>(null)
  const [recipeIngredients, setRecipeIngredients] = useState<any[]>([])
  const [addIngr, setAddIngr] = useState({ inventory_item_id: '', quantity: '1' })
  // Category management
  const [showCatManager, setShowCatManager] = useState(false)
  const [editCat, setEditCat] = useState<any>(null)
  const [newCat, setNewCat] = useState({ ...BLANK_CAT })
  const [showAddCat, setShowAddCat] = useState(false)

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => client.get('/menu/categories').then(r => r.data)
  })
  const { data: items = [] } = useQuery({
    queryKey: ['all-items'],
    queryFn: () => client.get('/menu/items', { params: { include_inactive: true } }).then(r => r.data)
  })
  const { data: inventoryItems = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => client.get('/inventory').then(r => r.data)
  })
  const { data: modifierGroups = [] } = useQuery({
    queryKey: ['modifier-groups'],
    queryFn: () => client.get('/menu/modifiers').then(r => r.data)
  })
  const [newItemGroups, setNewItemGroups] = useState<string[]>([])
  const [newItemIngredients, setNewItemIngredients] = useState<{inventory_item_id: string, quantity: number, name: string, unit: string}[]>([])
  const [newIngrPick, setNewIngrPick] = useState({ inventory_item_id: '', quantity: '1' })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['all-items'] })
    qc.invalidateQueries({ queryKey: ['categories'] })
  }

  // ── Category handlers ──────────────────────────────────────────────────────
  const handleCreateCat = async () => {
    if (!newCat.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      await client.post('/menu/categories', newCat)
      toast.success(`Categoría "${newCat.name}" creada`)
      qc.invalidateQueries({ queryKey: ['categories'] })
      setShowAddCat(false)
      setNewCat({ ...BLANK_CAT })
    } catch (err: any) { toast.error(err.response?.data?.error || 'Error') }
    finally { setSaving(false) }
  }

  const handleSaveCat = async () => {
    if (!editCat?.name?.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      await client.patch(`/menu/categories/${editCat.id}`, { name: editCat.name, routing: editCat.routing, sort_order: editCat.sort_order })
      toast.success('Categoría actualizada')
      qc.invalidateQueries({ queryKey: ['categories'] })
      setEditCat(null)
    } catch (err: any) { toast.error(err.response?.data?.error || 'Error') }
    finally { setSaving(false) }
  }

  const handleDeleteCat = async (cat: any) => {
    const itemCount = (items as any[]).filter((i: any) => i.category_id === cat.id).length
    if (itemCount > 0) {
      toast.error(`La categoría tiene ${itemCount} producto${itemCount !== 1 ? 's' : ''}. Elimínalos o muévelos primero.`)
      return
    }
    if (!window.confirm(`¿Eliminar categoría "${cat.name}"?`)) return
    try {
      await client.delete(`/menu/categories/${cat.id}`)
      toast.success(`Categoría eliminada`)
      qc.invalidateQueries({ queryKey: ['categories'] })
    } catch (err: any) { toast.error(err.response?.data?.error || 'Error') }
  }

  // ── Item delete ────────────────────────────────────────────────────────────
  const handleDeleteItem = async (item: any) => {
    if (!window.confirm(`⚠️ ¿Eliminar "${item.name}" del menú?\n\nEsta acción es permanente. Las órdenes históricas conservarán el registro.`)) return
    const reason = window.prompt('Motivo de eliminación (opcional):') ?? ''
    try {
      await client.delete(`/menu/items/${item.id}`, { data: { reason } })
      toast.success(`"${item.name}" eliminado`)
      invalidate()
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Error al eliminar')
    }
  }


  const handleSaveEdit = async (item: any, patch: any) => {
    setSaving(true)
    try {
      await client.patch(`/menu/items/${item.id}`, patch)
      await client.put(`/menu/items/${item.id}/modifier-groups`, { modifier_group_ids: editItemGroups })
      toast.success(`${item.name} actualizado`)
      invalidate()
      setEditItem(null)
    } catch { toast.error('Error al guardar') }
    finally { setSaving(false) }
  }

  const toggleActive = async (item: any) => {
    // Require confirmation before deactivating
    if (item.is_active) {
      setConfirmDeactivate(item)
      return
    }
    try {
      await client.patch(`/menu/items/${item.id}`, { is_active: true })
      toast.success(`${item.name} habilitado`)
      invalidate()
    } catch { toast.error('Error') }
  }

  const confirmDoDeactivate = async () => {
    if (!confirmDeactivate) return
    try {
      await client.patch(`/menu/items/${confirmDeactivate.id}`, { is_active: false })
      toast.success(`${confirmDeactivate.name} desactivado`)
      invalidate()
    } catch { toast.error('Error') }
    setConfirmDeactivate(null)
  }

  const handleCreate = async () => {
    if (!newItem.name.trim() || !newItem.category_id) return toast.error('Se requieren nombre y categoría')
    setSaving(true)
    try {
      const res = await client.post('/menu/items', newItem)
      const created = res.data
      if (newItemGroups.length > 0) {
        await client.put(`/menu/items/${created.id}/modifier-groups`, { modifier_group_ids: newItemGroups })
      }
      for (const ing of newItemIngredients) {
        await client.post('/inventory/insumos-base', {
          menu_item_id: created.id,
          inventory_item_id: ing.inventory_item_id,
          quantity: ing.quantity,
        })
      }
      toast.success(`${newItem.name} añadido`)
      invalidate()
      setShowAdd(false)
      setNewItem({ ...BLANK_ITEM })
      setNewItemGroups([])
      setNewItemIngredients([])
      setNewIngrPick({ inventory_item_id: '', quantity: '1' })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const openRecipe = async (item: any) => {
    setRecipeItem(item)
    setRecipeItemFull(null)
    try {
      const [ingrRes, fullRes] = await Promise.all([
        client.get(`/inventory/insumos-base/${item.id}`),
        client.get(`/menu/items/${item.id}`),
      ])
      setRecipeIngredients(ingrRes.data)
      setRecipeItemFull(fullRes.data)
    } catch { setRecipeIngredients([]) }
    setAddIngr({ inventory_item_id: '', quantity: '1' })
  }

  const handleAddIngredient = async () => {
    if (!addIngr.inventory_item_id) return toast.error('Selecciona un artículo de inventario')
    const qty = parseFloat(addIngr.quantity)
    if (!qty || qty <= 0) return toast.error('La cantidad debe ser mayor a 0')
    try {
      const res = await client.post('/inventory/insumos-base', {
        menu_item_id: recipeItem.id,
        inventory_item_id: addIngr.inventory_item_id,
        quantity: qty,
      })
      setRecipeIngredients(prev => {
        const existing = prev.findIndex(i => i.inventory_item_id === addIngr.inventory_item_id)
        if (existing >= 0) {
          const updated = [...prev]
          updated[existing] = res.data
          return updated
        }
        return [...prev, res.data]
      })
      setAddIngr({ inventory_item_id: '', quantity: '1' })
      toast.success('Insumo vinculado')
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error') }
  }

  const handleDeleteIngredient = async (ingId: string) => {
    try {
      await client.delete(`/inventory/insumos-base/${ingId}`)
      setRecipeIngredients(prev => prev.filter(i => i.id !== ingId))
      toast.success('Insumo eliminado')
    } catch { toast.error('Error') }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-4xl mx-auto p-4">

        <div className="sticky top-0 z-20 bg-slate-950 flex items-center justify-between py-3 mb-4 border-b border-slate-800">
          <h1 className="text-xl font-bold">🍽️ Gestión del Menú</h1>
          <div className="flex gap-2">
            <button onClick={() => setShowCatManager(true)} className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-xl font-semibold text-sm">
              🗂 Categorías
            </button>
            <button onClick={() => setShowAdd(true)} className="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-xl font-semibold text-sm">
              + Agregar Artículo
            </button>
          </div>
        </div>

        {categories.map((cat: any) => {
          const catItems = items.filter((i: any) => i.category_id === cat.id)
          return (
            <div key={cat.id} className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <h2 className="font-bold text-lg">{cat.name}</h2>
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${cat.routing === 'KITCHEN' ? 'bg-orange-900 text-orange-300' : 'bg-blue-900 text-blue-300'}`}>
                  {cat.routing}
                </span>
                <span className="text-slate-500 text-sm">{catItems.length} items</span>
              </div>

              <div className="bg-slate-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-700 text-slate-300">
                      <th className="p-3 text-left">Producto</th>
                      <th className="p-3 text-right">Precio</th>
                      <th className="p-3 text-center">¿Sabor?</th>
                      <th className="p-3 text-center">Activo</th>
                      <th className="p-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catItems.length === 0 && (
                      <tr><td colSpan={5} className="p-4 text-center text-slate-500">Sin productos</td></tr>
                    )}
                    {catItems.map((item: any) => {
                      const isEditing = editItem?.id === item.id
                      return (
                        <React.Fragment key={item.id}>
                        <tr className={`border-t border-slate-700 ${!item.is_active ? 'opacity-50' : ''}`}>
                          {isEditing ? (
                            <>
                              <td className="p-2" colSpan={4}>
                                <div className="flex flex-wrap gap-2 items-center">
                                  <input className="flex-1 min-w-[120px] bg-slate-700 rounded px-2 py-1 text-sm"
                                    placeholder="Nombre"
                                    value={editItem.name} onChange={e => setEditItem({ ...editItem, name: e.target.value })} />
                                  <input type="number" min={0}
                                    className="w-24 bg-slate-700 rounded px-2 py-1 text-sm text-right font-mono"
                                    placeholder="Precio (¢)"
                                    value={editItem.price_cents}
                                    onChange={e => setEditItem({ ...editItem, price_cents: parseInt(e.target.value) || 0 })} />
                                  <select
                                    className="bg-slate-700 rounded px-2 py-1 text-sm"
                                    value={editItem.category_id}
                                    onChange={e => setEditItem({ ...editItem, category_id: e.target.value })}>
                                    {(categories as any[]).map((c: any) => (
                                      <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                  </select>
                                  <label className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                                    <input type="checkbox" checked={editItem.requires_flavor}
                                      onChange={e => setEditItem({ ...editItem, requires_flavor: e.target.checked })} />
                                    Flavor req.
                                  </label>
                                </div>
                              </td>
                              <td className="p-2 text-center">
                                <div className="flex gap-1 justify-center">
                                  <button onClick={() => handleSaveEdit(item, { name: editItem.name, price_cents: editItem.price_cents, requires_flavor: editItem.requires_flavor, category_id: editItem.category_id })}
                                    disabled={saving} className="bg-green-600 hover:bg-green-500 px-2 py-1 rounded text-xs font-bold">✓ Guardar</button>
                                  <button onClick={() => setEditItem(null)} className="bg-slate-600 hover:bg-slate-500 px-2 py-1 rounded text-xs">✕</button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="p-3 font-medium">{item.name}</td>
                              <td className="p-3 text-right font-mono">{cents(item.price_cents)}</td>
                              <td className="p-3 text-center">{item.requires_flavor ? '✅' : '—'}</td>
                              <td className="p-3 text-center">
                                <button onClick={() => toggleActive(item)} title="Toggle active">
                                  {item.is_active ? '✅' : '❌'}
                                </button>
                              </td>
                              <td className="p-3 text-center">
                                <div className="flex gap-1 justify-center flex-wrap">
                                  <button onClick={() => { setEditItem({ ...item }); setEditItemGroups(item.modifier_groups?.map((g: any) => g.id) ?? []) }}
                                    className="bg-slate-600 hover:bg-slate-500 px-2 py-1 rounded text-xs font-semibold">Editar</button>
                                  <button onClick={() => openRecipe(item)}
                                    className={`px-2 py-1 rounded text-xs font-semibold ${item.ingredient_count > 0 ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-slate-600 hover:bg-slate-500'}`}>
                                    📦{item.ingredient_count > 0 ? ` ${item.ingredient_count}` : ''}
                                  </button>
                                  {isAdmin && (
                                    <button onClick={() => handleDeleteItem(item)}
                                      className="bg-red-900 hover:bg-red-800 px-2 py-1 rounded text-xs font-semibold text-red-300"
                                      title="Eliminar producto">🗑</button>
                                  )}
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                        {isEditing && (
                          <tr className="border-t border-slate-600 bg-slate-900">
                            <td colSpan={5} className="px-3 py-2">
                              <div className="text-xs text-slate-400 mb-1 font-semibold">Grupos de Modificadores</div>
                              <div className="flex flex-wrap gap-3">
                                {(modifierGroups as any[]).map((g: any) => (
                                  <label key={g.id} className="flex items-center gap-1.5 text-sm cursor-pointer">
                                    <input type="checkbox"
                                      checked={editItemGroups.includes(g.id)}
                                      onChange={e => setEditItemGroups(e.target.checked
                                        ? [...editItemGroups, g.id]
                                        : editItemGroups.filter(id => id !== g.id)
                                      )}
                                      className="w-4 h-4"
                                    />
                                    <span>{g.name}</span>
                                    {g.is_mandatory && <span className="text-xs text-red-400">required</span>}
                                  </label>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Inventario Modal ─────────────────────────────────────────────────── */}
      {recipeItem && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-emerald-700 shadow-xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-700 flex items-center justify-between flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold">📦 Inventario: {recipeItem.name}</h2>
                <p className="text-xs text-slate-400 mt-0.5">Artículos que se descuentan del inventario al ordenar este producto</p>
              </div>
              <button onClick={() => { setRecipeItem(null); setRecipeItemFull(null) }} className="text-slate-400 hover:text-white text-2xl">&times;</button>
            </div>
            <div className="p-5 overflow-y-auto">

              {/* ── Insumos base ──────────────────────────── */}
              <p className="text-xs text-slate-400 font-semibold uppercase mb-2">Insumos base (siempre se descuentan)</p>
              {recipeIngredients.length === 0 ? (
                <p className="text-slate-500 text-sm mb-4 pl-1">Sin insumos vinculados — agrega abajo.</p>
              ) : (
                <div className="space-y-2 mb-4">
                  {recipeIngredients.map((ing: any) => {
                    const qtyDisplay = parseFloat(ing.quantity) % 1 === 0
                      ? String(Math.round(parseFloat(ing.quantity)))
                      : parseFloat(ing.quantity).toFixed(2)
                    return (
                      <div key={ing.id} className="flex items-center justify-between bg-slate-700 rounded-lg px-3 py-2">
                        <span className="text-sm font-medium">{ing.inventory_item_name}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-emerald-300 font-mono">
                            {qtyDisplay} {ing.deduction_unit_key}
                          </span>
                          <span className="text-xs text-slate-500">
                            ({ing.stock_quantity != null ? parseFloat(ing.stock_quantity).toFixed(0) : '?'} disp.)
                          </span>
                          <button onClick={() => handleDeleteIngredient(ing.id)} className="text-red-400 hover:text-red-300 text-sm">✕</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* ── Descuento por modificador ──────────────────────── */}
              {recipeItemFull?.modifier_groups?.filter((g: any) =>
                g.modifiers?.some((m: any) => m.inventory_rules?.length > 0)
              ).map((group: any) => (
                <div key={group.id} className="mb-4">
                  <p className="text-xs text-sky-400 font-semibold uppercase mb-2">
                    🎛 {group.name} — el mesero elige
                    {group.allow_multiple && <span className="ml-1 text-yellow-400">({group.max_selections} selecciones)</span>}
                  </p>
                  <div className="space-y-1.5">
                    {group.modifiers?.filter((m: any) => m.inventory_rules?.length > 0).map((mod: any) => (
                      <div key={mod.id} className="bg-slate-700/60 rounded-lg px-3 py-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-200">Si se elige <span className="text-sky-300 font-semibold">{mod.name}</span>:</span>
                        <div className="flex flex-col items-end gap-0.5">
                          {mod.inventory_rules.map((r: any, i: number) => (
                            <span key={i} className="text-xs text-emerald-300 font-mono">−{r.quantity} {r.inventory_item_unit} {r.inventory_item_name}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5 pl-1">
                    Cada selección descuenta automáticamente el inventario correspondiente.
                  </p>
                </div>
              ))}

              {/* ── Agregar insumo base ──────────────────────────── */}
              <div className="border-t border-slate-700 pt-4 mt-2">
                <p className="text-xs text-slate-400 mb-2 font-semibold">AGREGAR INSUMO BASE</p>
                <div className="flex gap-2">
                  <select value={addIngr.inventory_item_id}
                    onChange={e => setAddIngr({ ...addIngr, inventory_item_id: e.target.value })}
                    className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm min-w-0">
                    <option value="">— selecciona artículo de inventario —</option>
                    {(inventoryItems as any[]).map((inv: any) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.name} ({inv.base_unit_key}) — {parseFloat(inv.stock_quantity).toFixed(0)} disp.
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0.001}
                      step={(() => {
                        const sel = (inventoryItems as any[]).find((i: any) => i.id === addIngr.inventory_item_id)
                        return sel?.base_unit_key === 'ml' || sel?.base_unit_key === 'gramo' ? '0.1' : '1'
                      })()}
                      value={addIngr.quantity}
                      onChange={e => setAddIngr({ ...addIngr, quantity: e.target.value })}
                      className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm text-center font-mono"
                    />
                    <span className="text-xs text-slate-400 whitespace-nowrap">
                      {(() => {
                        const sel = (inventoryItems as any[]).find((i: any) => i.id === addIngr.inventory_item_id)
                        return sel?.base_unit_key ?? ''
                      })()}
                    </span>
                  </div>
                  <button onClick={handleAddIngredient}
                    className="bg-emerald-700 hover:bg-emerald-600 px-3 py-2 rounded-lg text-sm font-bold whitespace-nowrap">+ Vincular</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Category Manager Modal ──────────────────────────────────────────── */}
      {showCatManager && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-600 shadow-xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-bold">🗂 Categorías del Menú</h2>
              <button onClick={() => { setShowCatManager(false); setShowAddCat(false); setEditCat(null) }}
                className="text-slate-400 hover:text-white text-2xl">&times;</button>
            </div>
            <div className="p-5 overflow-y-auto flex-1 space-y-2">
              {(categories as any[]).map((cat: any) => (
                <div key={cat.id} className="flex items-center justify-between bg-slate-700 rounded-xl px-4 py-3">
                  {editCat?.id === cat.id ? (
                    <div className="flex items-center gap-2 flex-1 mr-2">
                      <input value={editCat.name} onChange={e => setEditCat({ ...editCat, name: e.target.value })}
                        className="flex-1 bg-slate-600 rounded px-2 py-1 text-sm" />
                      <select value={editCat.routing} onChange={e => setEditCat({ ...editCat, routing: e.target.value })}
                        className="bg-slate-600 rounded px-2 py-1 text-sm">
                        <option value="BAR">BAR</option>
                        <option value="KITCHEN">KITCHEN</option>
                      </select>
                      <button onClick={handleSaveCat} disabled={saving}
                        className="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-xs font-bold">✓</button>
                      <button onClick={() => setEditCat(null)}
                        className="bg-slate-600 hover:bg-slate-500 px-3 py-1 rounded text-xs">✕</button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <span className="font-semibold">{cat.name}</span>
                        <span className={`ml-2 text-xs px-2 py-0.5 rounded font-medium ${cat.routing === 'KITCHEN' ? 'bg-orange-900 text-orange-300' : 'bg-blue-900 text-blue-300'}`}>
                          {cat.routing}
                        </span>
                        <span className="ml-2 text-xs text-slate-400">
                          {(items as any[]).filter((i: any) => i.category_id === cat.id).length} productos
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setEditCat({ ...cat })}
                          className="bg-slate-600 hover:bg-sky-700 px-3 py-1 rounded text-xs font-semibold">✏️</button>
                        {isAdmin && (
                          <button onClick={() => handleDeleteCat(cat)}
                            className="bg-red-900 hover:bg-red-800 px-3 py-1 rounded text-xs font-semibold text-red-300">🗑</button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}

              {/* Add new category */}
              {showAddCat ? (
                <div className="bg-slate-700/50 rounded-xl border border-slate-600 p-4 space-y-3">
                  <p className="text-xs text-slate-400 font-semibold uppercase">Nueva Categoría</p>
                  <input value={newCat.name} onChange={e => setNewCat({ ...newCat, name: e.target.value })}
                    placeholder="Nombre de categoría" className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
                  <div className="flex gap-3 items-center">
                    <select value={newCat.routing} onChange={e => setNewCat({ ...newCat, routing: e.target.value })}
                      className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                      <option value="BAR">BAR (bebidas)</option>
                      <option value="KITCHEN">KITCHEN (cocina)</option>
                    </select>
                    <input type="number" value={newCat.sort_order} onChange={e => setNewCat({ ...newCat, sort_order: parseInt(e.target.value) || 0 })}
                      className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm text-center" placeholder="Orden" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => { setShowAddCat(false); setNewCat({ ...BLANK_CAT }) }}
                      className="flex-1 py-2 border border-slate-600 rounded-lg text-sm">Cancelar</button>
                    <button onClick={handleCreateCat} disabled={!newCat.name.trim() || saving}
                      className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg text-sm font-bold disabled:opacity-50">Crear</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowAddCat(true)}
                  className="w-full py-2.5 border border-dashed border-slate-600 rounded-xl text-slate-400 hover:text-white hover:border-slate-400 text-sm">
                  + Nueva Categoría
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Deactivate Confirmation ──────────────────────────────────────────── */}
      {confirmDeactivate && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-red-700 shadow-xl p-6">
            <h2 className="text-lg font-bold text-red-400 mb-2">⚠️ ¿Desactivar Artículo?</h2>
            <p className="text-slate-300 mb-5">
              <span className="font-bold text-white">{confirmDeactivate.name}</span> se ocultará del menú de pedidos.
              Puedes reactivarlo en cualquier momento.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDeactivate(null)}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl hover:bg-slate-700">Cancelar</button>
              <button onClick={confirmDoDeactivate}
                className="flex-1 py-2.5 bg-red-700 hover:bg-red-600 rounded-xl font-bold">Desactivar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Item Modal ──────────────────────────────────────────────────── */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">Agregar Artículo al Menú</h2>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Categoría *</label>
                <select value={newItem.category_id} onChange={e => setNewItem({ ...newItem, category_id: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2">
                  <option value="">— selecciona categoría —</option>
                  {categories.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.routing})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Nombre del producto *</label>
                <input value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="ej. Alitas de pollo" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Precio (centavos) *</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} value={newItem.price_cents}
                    onChange={e => setNewItem({ ...newItem, price_cents: parseInt(e.target.value) || 0 })}
                    className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 font-mono" placeholder="1200" />
                  <span className="text-slate-400 text-sm">= {cents(newItem.price_cents)}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input type="checkbox" id="req-flavor" checked={newItem.requires_flavor}
                  onChange={e => setNewItem({ ...newItem, requires_flavor: e.target.checked })} className="w-4 h-4" />
                <label htmlFor="req-flavor" className="text-sm text-slate-300">Requiere selección de sabor</label>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Orden de aparición</label>
                <input type="number" min={0} value={newItem.sort_order}
                  onChange={e => setNewItem({ ...newItem, sort_order: parseInt(e.target.value) || 0 })}
                  className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
              </div>
              {(modifierGroups as any[]).length > 0 && (
                <div>
                  <label className="text-xs text-slate-400 block mb-2">Grupos de modificadores (sabores, extras…)</label>
                  <div className="bg-slate-700 rounded-lg p-3 space-y-2 max-h-40 overflow-y-auto">
                    {(modifierGroups as any[]).map((g: any) => (
                      <label key={g.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox"
                          checked={newItemGroups.includes(g.id)}
                          onChange={e => setNewItemGroups(e.target.checked
                            ? [...newItemGroups, g.id]
                            : newItemGroups.filter(id => id !== g.id)
                          )}
                          className="w-4 h-4"
                        />
                        <span>{g.name}</span>
                        {g.is_required && <span className="text-xs text-red-400">required</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Inventario vinculado ────────────────────── */}
              <div>
                <label className="text-xs text-slate-400 block mb-2">📦 Inventario que se descuenta al vender (opcional)</label>
                {newItemIngredients.length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    {newItemIngredients.map((ing, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-slate-700 rounded-lg px-3 py-1.5 text-sm">
                        <span>{ing.name} <span className="text-emerald-300 font-mono">×{ing.quantity} {ing.unit}</span></span>
                        <button onClick={() => setNewItemIngredients(prev => prev.filter((_, i) => i !== idx))}
                          className="text-red-400 hover:text-red-300 text-xs">✕</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <select value={newIngrPick.inventory_item_id}
                    onChange={e => setNewIngrPick({ ...newIngrPick, inventory_item_id: e.target.value })}
                    className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm min-w-0">
                    <option value="">— selecciona artículo —</option>
                    {(inventoryItems as any[]).filter(inv => !newItemIngredients.find(i => i.inventory_item_id === inv.id)).map((inv: any) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.name} ({inv.base_unit_key}) — {parseFloat(inv.stock_quantity).toFixed(0)} disp.
                      </option>
                    ))}
                  </select>
                  <input
                    type="number" min={0.001}
                    step={(() => {
                      const sel = (inventoryItems as any[]).find((i: any) => i.id === newIngrPick.inventory_item_id)
                      return sel?.base_unit_key === 'ml' || sel?.base_unit_key === 'gramo' ? '0.1' : '1'
                    })()}
                    value={newIngrPick.quantity}
                    onChange={e => setNewIngrPick({ ...newIngrPick, quantity: e.target.value })}
                    className="w-16 bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm text-center font-mono" />
                  <button
                    onClick={() => {
                      if (!newIngrPick.inventory_item_id) return
                      const inv = (inventoryItems as any[]).find((i: any) => i.id === newIngrPick.inventory_item_id)
                      if (!inv) return
                      const qty = parseFloat(newIngrPick.quantity) || 1
                      setNewItemIngredients(prev => [...prev, {
                        inventory_item_id: inv.id, quantity: qty,
                        name: inv.name, unit: inv.base_unit_key
                      }])
                      setNewIngrPick({ inventory_item_id: '', quantity: '1' })
                    }}
                    className="bg-emerald-700 hover:bg-emerald-600 px-3 py-2 rounded-lg text-sm font-bold whitespace-nowrap">+ Agregar</button>
                </div>
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button onClick={() => { setShowAdd(false); setNewItem({ ...BLANK_ITEM }); setNewItemGroups([]) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">Cancelar</button>
              <button onClick={handleCreate} disabled={!newItem.name.trim() || !newItem.category_id || saving}
                className="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold disabled:opacity-50">
                {saving ? 'Añadiendo…' : 'Agregar Artículo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
