import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import client from '../../api/client'
import toast from 'react-hot-toast'

function cents(n: number) { return `$${(n / 100).toFixed(2)}` }

const BLANK_ITEM = { name: '', price_cents: 0, category_id: '', requires_flavor: false, sort_order: 0 }

export default function MenuManagementPage() {
  const qc = useQueryClient()
  const [editItem, setEditItem] = useState<any>(null)
  const [editItemGroups, setEditItemGroups] = useState<string[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [newItem, setNewItem] = useState({ ...BLANK_ITEM })
  const [saving, setSaving] = useState(false)
  // Confirmation dialog for deactivate
  const [confirmDeactivate, setConfirmDeactivate] = useState<any>(null)
  // Recipe management
  const [recipeItem, setRecipeItem] = useState<any>(null)
  const [recipeItemFull, setRecipeItemFull] = useState<any>(null)  // item with modifiers
  const [recipeIngredients, setRecipeIngredients] = useState<any[]>([])
  const [addIngr, setAddIngr] = useState({ inventory_item_id: '', quantity: 1 })

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => client.get('/menu/categories').then(r => r.data)
  })
  const { data: items = [] } = useQuery({
    queryKey: ['all-items'],
    // include_inactive=true so manager sees deactivated items too
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
  // Selected modifier groups for new item
  const [newItemGroups, setNewItemGroups] = useState<string[]>([])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['all-items'] })

  const handleSaveEdit = async (item: any, patch: any) => {
    setSaving(true)
    try {
      await client.patch(`/menu/items/${item.id}`, patch)
      await client.put(`/menu/items/${item.id}/modifier-groups`, { modifier_group_ids: editItemGroups })
      toast.success(`${item.name} updated`)
      invalidate()
      setEditItem(null)
    } catch { toast.error('Save failed') }
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
      toast.success(`${item.name} enabled`)
      invalidate()
    } catch { toast.error('Failed') }
  }

  const confirmDoDeactivate = async () => {
    if (!confirmDeactivate) return
    try {
      await client.patch(`/menu/items/${confirmDeactivate.id}`, { is_active: false })
      toast.success(`${confirmDeactivate.name} deactivated`)
      invalidate()
    } catch { toast.error('Failed') }
    setConfirmDeactivate(null)
  }

  const handleCreate = async () => {
    if (!newItem.name.trim() || !newItem.category_id) return toast.error('Name and category required')
    setSaving(true)
    try {
      const res = await client.post('/menu/items', newItem)
      const created = res.data
      if (newItemGroups.length > 0) {
        await client.put(`/menu/items/${created.id}/modifier-groups`, { modifier_group_ids: newItemGroups })
      }
      toast.success(`${newItem.name} added`)
      invalidate()
      setShowAdd(false)
      setNewItem({ ...BLANK_ITEM })
      setNewItemGroups([])
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed')
    } finally { setSaving(false) }
  }

  const openRecipe = async (item: any) => {
    setRecipeItem(item)
    setRecipeItemFull(null)
    try {
      const [ingrRes, fullRes] = await Promise.all([
        client.get(`/inventory/item-ingredients/${item.id}`),
        client.get(`/menu/items/${item.id}`),
      ])
      setRecipeIngredients(ingrRes.data)
      setRecipeItemFull(fullRes.data)
    } catch { setRecipeIngredients([]) }
    setAddIngr({ inventory_item_id: '', quantity: 1 })
  }

  const handleAddIngredient = async () => {
    if (!addIngr.inventory_item_id) return toast.error('Select an inventory item')
    try {
      const res = await client.post('/inventory/item-ingredients', {
        menu_item_id: recipeItem.id,
        inventory_item_id: addIngr.inventory_item_id,
        quantity: addIngr.quantity,
      })
      setRecipeIngredients(prev => [...prev, res.data])
      setAddIngr({ inventory_item_id: '', quantity: 1 })
      toast.success('Ingredient added')
    } catch (err: any) { toast.error(err.response?.data?.message || 'Failed') }
  }

  const handleDeleteIngredient = async (ingId: string) => {
    try {
      await client.delete(`/inventory/item-ingredients/${ingId}`)
      setRecipeIngredients(prev => prev.filter(i => i.id !== ingId))
      toast.success('Ingredient removed')
    } catch { toast.error('Failed') }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <NavBar />
      <div className="max-w-4xl mx-auto p-4">

        <div className="sticky top-0 z-20 bg-slate-950 flex items-center justify-between py-3 mb-4 border-b border-slate-800">
          <h1 className="text-xl font-bold">🍽️ Menu Management</h1>
          <button onClick={() => setShowAdd(true)} className="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-xl font-semibold text-sm">
            + Add Item
          </button>
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
                      <th className="p-3 text-left">Item</th>
                      <th className="p-3 text-right">Price</th>
                      <th className="p-3 text-center">Flavor?</th>
                      <th className="p-3 text-center">Active</th>
                      <th className="p-3 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catItems.length === 0 && (
                      <tr><td colSpan={5} className="p-4 text-center text-slate-500">No items</td></tr>
                    )}
                    {catItems.map((item: any) => {
                      const isEditing = editItem?.id === item.id
                      return (
                        <React.Fragment key={item.id}>
                        <tr className={`border-t border-slate-700 ${!item.is_active ? 'opacity-50' : ''}`}>
                          {isEditing ? (
                            <>
                              <td className="p-2">
                                <input className="w-full bg-slate-700 rounded px-2 py-1 text-sm"
                                  value={editItem.name} onChange={e => setEditItem({ ...editItem, name: e.target.value })} />
                              </td>
                              <td className="p-2">
                                <input type="number" min={0}
                                  className="w-24 bg-slate-700 rounded px-2 py-1 text-sm text-right font-mono ml-auto block"
                                  value={editItem.price_cents}
                                  onChange={e => setEditItem({ ...editItem, price_cents: parseInt(e.target.value) || 0 })} />
                              </td>
                              <td className="p-2 text-center">
                                <input type="checkbox" checked={editItem.requires_flavor}
                                  onChange={e => setEditItem({ ...editItem, requires_flavor: e.target.checked })} />
                              </td>
                              <td className="p-2 text-center">{item.is_active ? '✅' : '❌'}</td>
                              <td className="p-2 text-center">
                                <div className="flex gap-1 justify-center">
                                  <button onClick={() => handleSaveEdit(item, { name: editItem.name, price_cents: editItem.price_cents, requires_flavor: editItem.requires_flavor })}
                                    disabled={saving} className="bg-green-600 hover:bg-green-500 px-2 py-1 rounded text-xs font-bold">Save</button>
                                  <button onClick={() => setEditItem(null)} className="bg-slate-600 hover:bg-slate-500 px-2 py-1 rounded text-xs">Cancel</button>
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
                                <div className="flex gap-1 justify-center">
                                  <button onClick={() => { setEditItem({ ...item }); setEditItemGroups(item.modifier_groups?.map((g: any) => g.id) ?? []) }}
                                    className="bg-slate-600 hover:bg-slate-500 px-2 py-1 rounded text-xs font-semibold">Edit</button>
                                  <button onClick={() => openRecipe(item)}
                                    className="bg-amber-800 hover:bg-amber-700 px-2 py-1 rounded text-xs font-semibold">🧪 Recipe</button>
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                        {isEditing && (
                          <tr className="border-t border-slate-600 bg-slate-900">
                            <td colSpan={5} className="px-3 py-2">
                              <div className="text-xs text-slate-400 mb-1 font-semibold">Modifier Groups</div>
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

      {/* ── Recipe Modal ─────────────────────────────────────────────────────── */}
      {recipeItem && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-amber-700 shadow-xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-700 flex items-center justify-between flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold">🧪 Recipe: {recipeItem.name}</h2>
                <p className="text-xs text-slate-400 mt-0.5">What gets deducted from inventory when ordered</p>
              </div>
              <button onClick={() => { setRecipeItem(null); setRecipeItemFull(null) }} className="text-slate-400 hover:text-white text-2xl">&times;</button>
            </div>
            <div className="p-5 overflow-y-auto">

              {/* ── Section 1: Fixed base ingredients ──────────────── */}
              <p className="text-xs text-slate-400 font-semibold uppercase mb-2">Base Ingredients (always deducted)</p>
              {recipeIngredients.length === 0 ? (
                <p className="text-slate-500 text-sm mb-4 pl-1">None — add below if needed.</p>
              ) : (
                <div className="space-y-2 mb-4">
                  {recipeIngredients.map((ing: any) => (
                    <div key={ing.id} className="flex items-center justify-between bg-slate-700 rounded-lg px-3 py-2">
                      <span className="text-sm font-medium">{ing.inventory_item_name}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-amber-300 font-mono">{ing.quantity} {ing.inventory_item_unit}</span>
                        <button onClick={() => handleDeleteIngredient(ing.id)} className="text-red-400 hover:text-red-300 text-sm">✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Section 2: Modifier-driven inventory (per brand choice) ── */}
              {recipeItemFull?.modifier_groups?.filter((g: any) =>
                g.modifiers?.some((m: any) => m.inventory_rules?.length > 0)
              ).map((group: any) => (
                <div key={group.id} className="mb-4">
                  <p className="text-xs text-sky-400 font-semibold uppercase mb-2">
                    🎛 {group.name} — waiter picks one
                    {group.allow_multiple && <span className="ml-1 text-yellow-400">({group.max_selections} picks for bucket)</span>}
                  </p>
                  <div className="space-y-1.5">
                    {group.modifiers?.filter((m: any) => m.inventory_rules?.length > 0).map((mod: any) => (
                      <div key={mod.id} className="bg-slate-700/60 rounded-lg px-3 py-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-200">If <span className="text-sky-300 font-semibold">{mod.name}</span> is selected:</span>
                        <div className="flex flex-col items-end gap-0.5">
                          {mod.inventory_rules.map((r: any, i: number) => (
                            <span key={i} className="text-xs text-amber-300 font-mono">−{r.quantity} {r.inventory_item_unit} {r.inventory_item_name}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5 pl-1">
                    Each selection automatically deducts from the matching inventory.
                  </p>
                </div>
              ))}

              {/* ── Add base ingredient ──────────────────────────── */}
              <div className="border-t border-slate-700 pt-4 mt-2">
                <p className="text-xs text-slate-400 mb-2 font-semibold">ADD BASE INGREDIENT</p>
                <div className="flex gap-2">
                  <select value={addIngr.inventory_item_id}
                    onChange={e => setAddIngr({ ...addIngr, inventory_item_id: e.target.value })}
                    className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm min-w-0">
                    <option value="">— pick inventory item —</option>
                    {(inventoryItems as any[]).map((inv: any) => (
                      <option key={inv.id} value={inv.id}>{inv.name} ({inv.unit})</option>
                    ))}
                  </select>
                  <input type="number" min={1} value={addIngr.quantity}
                    onChange={e => setAddIngr({ ...addIngr, quantity: parseInt(e.target.value) || 1 })}
                    className="w-16 bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm text-center font-mono" />
                  <button onClick={handleAddIngredient}
                    className="bg-amber-700 hover:bg-amber-600 px-3 py-2 rounded-lg text-sm font-bold whitespace-nowrap">+ Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Deactivate Confirmation ──────────────────────────────────────────── */}
      {confirmDeactivate && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-red-700 shadow-xl p-6">
            <h2 className="text-lg font-bold text-red-400 mb-2">⚠️ Deactivate Item?</h2>
            <p className="text-slate-300 mb-5">
              <span className="font-bold text-white">{confirmDeactivate.name}</span> will be hidden from the order menu.
              You can re-enable it at any time.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDeactivate(null)}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl hover:bg-slate-700">Cancel</button>
              <button onClick={confirmDoDeactivate}
                className="flex-1 py-2.5 bg-red-700 hover:bg-red-600 rounded-xl font-bold">Deactivate</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Item Modal ──────────────────────────────────────────────────── */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">Add Menu Item</h2>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Category *</label>
                <select value={newItem.category_id} onChange={e => setNewItem({ ...newItem, category_id: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2">
                  <option value="">— select category —</option>
                  {categories.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.routing})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Item Name *</label>
                <input value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" placeholder="e.g. Chicken Wings" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Price (cents) *</label>
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
                <label htmlFor="req-flavor" className="text-sm text-slate-300">Requires flavor selection</label>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Sort Order</label>
                <input type="number" min={0} value={newItem.sort_order}
                  onChange={e => setNewItem({ ...newItem, sort_order: parseInt(e.target.value) || 0 })}
                  className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
              </div>
              {(modifierGroups as any[]).length > 0 && (
                <div>
                  <label className="text-xs text-slate-400 block mb-2">Modifier Groups (flavors, extras…)</label>
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
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button onClick={() => { setShowAdd(false); setNewItem({ ...BLANK_ITEM }); setNewItemGroups([]) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">Cancel</button>
              <button onClick={handleCreate} disabled={!newItem.name.trim() || !newItem.category_id || saving}
                className="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold disabled:opacity-50">
                {saving ? 'Adding…' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
