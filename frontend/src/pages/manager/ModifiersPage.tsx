import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'

const BLANK_GROUP = { name: '', is_mandatory: true, min_selections: 1, max_selections: 1, allow_multiple: false }
const BLANK_MOD = { name: '', price_cents: '' }

export default function ModifiersPage() {
  const qc = useQueryClient()

  // Group state
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [editingGroup, setEditingGroup] = useState<any>(null)
  const [groupForm, setGroupForm] = useState({ ...BLANK_GROUP })
  const [newGroupForm, setNewGroupForm] = useState({ ...BLANK_GROUP })

  // Modifier state
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [showNewMod, setShowNewMod] = useState<string | null>(null) // group_id
  const [editingMod, setEditingMod] = useState<any>(null)
  const [modForm, setModForm] = useState({ ...BLANK_MOD })
  const [newModForm, setNewModForm] = useState({ ...BLANK_MOD })

  // Inventory rules for the modifier being edited
  const [modRules, setModRules] = useState<{ inventory_item_id: string; inventory_item_name: string; inventory_item_unit: string; quantity: number }[]>([])
  const [addingRule, setAddingRule] = useState(false)
  const [newRuleItemId, setNewRuleItemId] = useState('')
  const [newRuleQty, setNewRuleQty] = useState(1)

  const [saving, setSaving] = useState(false)
  const [showInactive, setShowInactive] = useState(false)

  useEscKey(() => {
    if (editingMod) { setEditingMod(null); return }
    if (showNewMod) { setShowNewMod(null); return }
    if (editingGroup) { setEditingGroup(null); return }
    if (showNewGroup) { setShowNewGroup(false); return }
  }, showNewGroup || !!editingGroup || !!showNewMod || !!editingMod)

  // Query key includes showInactive so toggling forces a fresh fetch with the right filter
  const { data: groups = [], refetch: refetchGroups } = useQuery({
    queryKey: ['modifier-groups', showInactive],
    queryFn: () => client.get(`/menu/modifiers${showInactive ? '?include_inactive=1' : ''}`).then(r => r.data),
    staleTime: 0,
  })

  // Inventory items for the rules dropdown
  const { data: inventoryItems = [] } = useQuery({
    queryKey: ['inventory-items-all'],
    queryFn: () => client.get('/inventory').then(r => r.data),
  })

  // Invalidate all modifier + item caches across the app after any change
  const invalidateAll = () => {
    refetchGroups()
    qc.invalidateQueries({ queryKey: ['modifier-groups'] }) // MenuManagementPage
    qc.invalidateQueries({ queryKey: ['items'] })           // AddItemModal (embedded modifier_groups)
    qc.invalidateQueries({ queryKey: ['all-items'] })       // MenuManagementPage item list
  }

  // ── Groups ──────────────────────────────────────────────────────────────────

  const handleCreateGroup = async () => {
    if (!newGroupForm.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      await client.post('/menu/modifier-groups', newGroupForm)
      toast.success(`Grupo "${newGroupForm.name}" creado`)
      invalidateAll()
      setShowNewGroup(false)
      setNewGroupForm({ ...BLANK_GROUP })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al crear grupo')
    } finally { setSaving(false) }
  }

  const handleUpdateGroup = async () => {
    if (!groupForm.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      await client.patch(`/menu/modifier-groups/${editingGroup.id}`, groupForm)
      toast.success('Grupo actualizado')
      invalidateAll()
      setEditingGroup(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const handleDeleteGroup = async (group: any) => {
    if (!window.confirm(`¿Eliminar el grupo "${group.name}"? Se desvinculará de todos los artículos del menú y sus opciones quedarán inactivas.`)) return
    try {
      await client.delete(`/menu/modifier-groups/${group.id}`)
      toast.success(`Grupo "${group.name}" eliminado`)
      invalidateAll()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al eliminar')
    }
  }

  const openEditGroup = (group: any) => {
    setGroupForm({
      name: group.name,
      is_mandatory: group.is_mandatory,
      min_selections: group.min_selections,
      max_selections: group.max_selections,
      allow_multiple: group.allow_multiple,
    })
    setEditingGroup(group)
  }

  // ── Modifiers ────────────────────────────────────────────────────────────────

  const handleCreateMod = async (groupId: string) => {
    if (!newModForm.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      const price = newModForm.price_cents === '' ? 0 : Math.round(parseFloat(String(newModForm.price_cents)) * 100)
      await client.post(`/menu/modifier-groups/${groupId}/modifiers`, { name: newModForm.name.trim(), price_cents: price })
      toast.success(`"${newModForm.name}" añadido`)
      invalidateAll()
      setShowNewMod(null)
      setNewModForm({ ...BLANK_MOD })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al crear')
    } finally { setSaving(false) }
  }

  const handleUpdateMod = async () => {
    if (!modForm.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      const price = modForm.price_cents === '' ? 0 : Math.round(parseFloat(String(modForm.price_cents)) * 100)
      await client.patch(`/menu/modifiers/${editingMod.id}`, { name: modForm.name.trim(), price_cents: price })
      toast.success('Modificador actualizado')
      invalidateAll()
      setEditingMod(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const handleToggleMod = async (mod: any) => {
    const newActive = !mod.is_active
    try {
      await client.patch(`/menu/modifiers/${mod.id}`, { is_active: newActive })
      toast.success(newActive ? `"${mod.name}" activado` : `"${mod.name}" desactivado`)
      invalidateAll()
      if (editingMod?.id === mod.id) setEditingMod(null)
    } catch {
      toast.error('Error al actualizar')
    }
  }

  const handleDeleteMod = async (mod: any) => {
    if (!window.confirm(`¿Eliminar la opción "${mod.name}"?`)) return
    try {
      await client.delete(`/menu/modifiers/${mod.id}`)
      toast.success(`"${mod.name}" eliminado`)
      invalidateAll()
      if (editingMod?.id === mod.id) setEditingMod(null)
    } catch {
      toast.error('Error al eliminar')

      invalidateAll()
    }
  }

  const openEditMod = (mod: any) => {
    setModForm({ name: mod.name, price_cents: mod.price_cents > 0 ? String(mod.price_cents / 100) : '' })
    setModRules(mod.inventory_rules ?? [])
    setAddingRule(false)
    setNewRuleItemId('')
    setNewRuleQty(1)
    setEditingMod(mod)
  }

  const handleSaveRules = async (rules: typeof modRules) => {
    try {
      await client.put(`/menu/modifiers/${editingMod.id}/inventory-rules`, { rules })
      toast.success('Vínculos de inventario guardados')
      invalidateAll()
    } catch {
      toast.error('Error al guardar vínculos')
    }
  }

  const addRule = () => {
    const item = (inventoryItems as any[]).find((i: any) => i.id === newRuleItemId)
    if (!item) return
    if (modRules.some(r => r.inventory_item_id === newRuleItemId)) {
      toast.error('Ya está vinculado')
      return
    }
    const updated = [...modRules, { inventory_item_id: item.id, inventory_item_name: item.name, inventory_item_unit: item.unit, quantity: newRuleQty }]
    setModRules(updated)
    handleSaveRules(updated)
    setAddingRule(false)
    setNewRuleItemId('')
    setNewRuleQty(1)
  }

  const removeRule = (itemId: string) => {
    const updated = modRules.filter(r => r.inventory_item_id !== itemId)
    setModRules(updated)
    handleSaveRules(updated)
  }

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-2xl mx-auto p-4">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold">🧩 Modificadores</h1>
            <p className="text-xs text-slate-400 mt-0.5">Grupos y opciones (sabores, salsas, extras…)</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowInactive(s => !s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${showInactive ? 'bg-slate-600 border-slate-500 text-white' : 'bg-transparent border-slate-600 text-slate-400 hover:border-slate-400'}`}>
              {showInactive ? '👁 Ocultar inactivos' : '👁 Ver inactivos'}
            </button>
            <button onClick={() => setShowNewGroup(true)}
              className="bg-sky-600 hover:bg-sky-500 px-4 py-1.5 rounded-lg text-sm font-semibold">
              + Nuevo Grupo
            </button>
          </div>
        </div>

        {(groups as any[]).length === 0 && (
          <div className="text-center text-slate-500 py-16">
            <div className="text-4xl mb-3">🧩</div>
            <div>Sin grupos de modificadores</div>
            <div className="text-xs mt-1">Crea un grupo (ej. "Sabores", "Salsas") y añade opciones dentro</div>
          </div>
        )}

        <div className="space-y-4">
          {(groups as any[]).map((group: any) => {
            const isExpanded = expandedGroup === group.id
            const allMods: any[] = group.modifiers ?? []
            // When showInactive=false, server already returns only active items.
            // When showInactive=true, server returns all — show all.
            const visibleMods = allMods
            const inactiveCount = allMods.filter((m: any) => m.is_active === false).length
            return (
              <div key={group.id} className="bg-slate-800 rounded-2xl border border-slate-700">
                {/* Group header */}
                <div className="flex items-center gap-2 p-4">
                  <button onClick={() => setExpandedGroup(isExpanded ? null : group.id)}
                    className="flex-1 text-left min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{group.name}</span>
                      {group.is_mandatory && <span className="text-xs bg-red-900 text-red-300 px-1.5 py-0.5 rounded-full">Obligatorio</span>}
                      {group.allow_multiple && <span className="text-xs bg-sky-900 text-sky-300 px-1.5 py-0.5 rounded-full">Múltiple</span>}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {visibleMods.length} opción{visibleMods.length !== 1 ? 'es' : ''}
                      {!showInactive && inactiveCount > 0 && <span className="text-slate-500"> · {inactiveCount} eliminada{inactiveCount !== 1 ? 's' : ''}</span>}
                      {' · '}Sel: {group.min_selections}–{group.max_selections}
                      <span className="ml-2 text-slate-500">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </button>
                  <button onClick={() => openEditGroup(group)}
                    className="bg-slate-700 hover:bg-sky-700 px-3 py-1.5 rounded-lg text-sm shrink-0" title="Editar grupo">✏️</button>
                  <button onClick={() => handleDeleteGroup(group)}
                    className="bg-slate-700 hover:bg-red-800 px-3 py-1.5 rounded-lg text-sm text-red-400 shrink-0" title="Eliminar grupo">🗑</button>
                </div>

                {/* Modifiers list */}
                {isExpanded && (
                  <div className="border-t border-slate-700 px-4 pb-4">
                    <div className="space-y-2 mt-3">
                      {visibleMods.length === 0 && (
                        <div className="text-xs text-slate-500 py-2 text-center">Sin opciones aún</div>
                      )}
                      {visibleMods.map((mod: any) => {
                        const active = mod.is_active !== false
                        return (
                          <div key={mod.id}
                            className={`flex items-center gap-2 p-2 rounded-lg transition-opacity ${active ? 'bg-slate-700/50' : 'bg-slate-900/40 opacity-60'}`}>
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium">{mod.name}</span>
                              {!active && <span className="ml-2 text-xs text-slate-500 italic">inactivo</span>}
                            </div>
                            {mod.price_cents > 0 && (
                              <span className="text-xs text-sky-400 font-mono shrink-0">+${(mod.price_cents / 100).toFixed(2)}</span>
                            )}
                            {/* Edit */}
                            <button onClick={() => openEditMod(mod)}
                              className="bg-slate-600 hover:bg-sky-700 px-2 py-1 rounded text-xs shrink-0" title="Editar">✏️</button>
                            {/* Toggle active/inactive */}
                            <button onClick={() => handleToggleMod(mod)}
                              className={`px-2 py-1 rounded text-xs font-semibold shrink-0 ${active ? 'bg-yellow-900 hover:bg-yellow-700 text-yellow-300' : 'bg-green-900 hover:bg-green-700 text-green-300'}`}
                              title={active ? 'Desactivar' : 'Activar'}>
                              {active ? '⏸' : '▶'}
                            </button>
                            {/* Delete (soft) */}
                            <button onClick={() => handleDeleteMod(mod)}
                              className="bg-slate-700 hover:bg-red-800 px-2 py-1 rounded text-xs text-red-400 shrink-0" title="Eliminar">🗑</button>
                          </div>
                        )
                      })}
                    </div>
                    <button onClick={() => { setShowNewMod(group.id); setNewModForm({ ...BLANK_MOD }) }}
                      className="mt-3 w-full py-1.5 border border-dashed border-slate-600 rounded-lg text-sm text-slate-400 hover:border-sky-500 hover:text-sky-400 transition-colors">
                      + Añadir opción a "{group.name}"
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── New Group Modal ─────────────────────────────────────────────────── */}
      {showNewGroup && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-sky-700">
            <h2 className="font-bold mb-4 text-sky-300">+ Nuevo Grupo de Modificadores</h2>
            <GroupForm form={newGroupForm} setForm={setNewGroupForm} />
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowNewGroup(false)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleCreateGroup} disabled={!newGroupForm.name.trim() || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Creando…' : 'Crear Grupo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Group Modal ────────────────────────────────────────────────── */}
      {editingGroup && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600">
            <h2 className="font-bold mb-4">✏️ Editar Grupo: {editingGroup.name}</h2>
            <GroupForm form={groupForm} setForm={setGroupForm} />
            <div className="flex gap-3 mt-5">
              <button onClick={() => setEditingGroup(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={() => { handleDeleteGroup(editingGroup); setEditingGroup(null) }}
                className="py-2 px-4 bg-red-900 hover:bg-red-700 text-red-300 rounded-lg text-sm font-semibold">🗑 Eliminar</button>
              <button onClick={handleUpdateGroup} disabled={!groupForm.name.trim() || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Modifier Modal ───────────────────────────────────────────────── */}
      {showNewMod && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-green-700">
            <h2 className="font-bold mb-4 text-green-300">+ Nueva Opción</h2>
            <ModifierForm form={newModForm} setForm={setNewModForm} />
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowNewMod(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={() => handleCreateMod(showNewMod)} disabled={!newModForm.name.trim() || saving}
                className="flex-1 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Añadiendo…' : 'Añadir'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Modifier Modal ─────────────────────────────────────────────── */}
      {editingMod && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-md border border-slate-600 max-h-[90vh] overflow-y-auto">
            <h2 className="font-bold mb-1">✏️ Editar: {editingMod.name}</h2>
            {editingMod.is_active === false && (
              <div className="text-xs text-yellow-400 bg-yellow-900/30 rounded-lg px-3 py-1.5 mb-3">
                ⚠️ Esta opción está inactiva — no aparece en nuevos pedidos
              </div>
            )}
            <div className="mt-3">
              <ModifierForm form={modForm} setForm={setModForm} />
            </div>

            {/* ── Inventory rules ───────────────────────────────────────── */}
            <div className="mt-5 border-t border-slate-700 pt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide">📦 Consumo de Inventario</p>
                <button onClick={() => setAddingRule(r => !r)}
                  className="text-xs bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded-lg text-sky-400">
                  {addingRule ? '✕ Cancelar' : '+ Vincular'}
                </button>
              </div>

              {modRules.length === 0 && !addingRule && (
                <p className="text-xs text-slate-500 italic">Sin vínculos — seleccionar esta opción no consume inventario.</p>
              )}

              {modRules.map(r => (
                <div key={r.inventory_item_id} className="flex items-center gap-2 bg-slate-700/50 rounded-lg px-3 py-2 mb-1.5">
                  <span className="flex-1 text-sm">{r.inventory_item_name}</span>
                  <span className="text-xs text-slate-400">{r.inventory_item_unit}</span>
                  <span className="text-xs font-mono text-sky-300 w-6 text-center">{r.quantity}</span>
                  <button onClick={() => removeRule(r.inventory_item_id)}
                    className="text-red-400 hover:text-red-300 text-xs px-1">✕</button>
                </div>
              ))}

              {addingRule && (
                <div className="bg-slate-700/50 rounded-xl p-3 space-y-2 mt-2 border border-slate-600">
                  <select value={newRuleItemId} onChange={e => setNewRuleItemId(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    <option value="">— Seleccionar artículo de inventario —</option>
                    {(inventoryItems as any[])
                      .filter((i: any) => !modRules.some(r => r.inventory_item_id === i.id))
                      .map((i: any) => (
                        <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
                      ))}
                  </select>
                  <div className="flex gap-2 items-center">
                    <label className="text-xs text-slate-400 shrink-0">Cantidad:</label>
                    <input type="number" min={1} value={newRuleQty} onChange={e => setNewRuleQty(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-center" />
                    <button onClick={addRule} disabled={!newRuleItemId}
                      className="flex-1 py-1.5 bg-sky-600 hover:bg-sky-500 rounded-lg text-sm font-bold disabled:opacity-40">
                      + Agregar
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-5 flex-wrap">
              <button onClick={() => setEditingMod(null)} className="py-2 px-3 border border-slate-600 rounded-lg text-sm">Cancelar</button>
              {/* Toggle active */}
              <button onClick={() => handleToggleMod(editingMod)}
                className={`py-2 px-3 rounded-lg text-sm font-semibold ${editingMod.is_active !== false ? 'bg-yellow-900 hover:bg-yellow-700 text-yellow-200' : 'bg-green-900 hover:bg-green-700 text-green-200'}`}>
                {editingMod.is_active !== false ? '⏸ Desactivar' : '▶ Activar'}
              </button>
              {/* Delete */}
              <button onClick={() => handleDeleteMod(editingMod)}
                className="py-2 px-3 bg-red-900 hover:bg-red-700 text-red-300 rounded-lg text-sm font-semibold">🗑 Eliminar</button>
              {/* Save */}
              <button onClick={handleUpdateMod} disabled={!modForm.name.trim() || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50 min-w-[80px]">
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Reusable sub-forms ────────────────────────────────────────────────────────

function GroupForm({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-slate-400 block mb-1">Nombre del grupo *</label>
        <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
          placeholder="Ej. Sabores, Salsas, Extras" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-400 block mb-1">Mín. selecciones</label>
          <input type="number" min={0} value={form.min_selections}
            onChange={(e) => setForm({ ...form, min_selections: parseInt(e.target.value) || 0 })}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Máx. selecciones</label>
          <input type="number" min={1} value={form.max_selections}
            onChange={(e) => setForm({ ...form, max_selections: parseInt(e.target.value) || 1 })}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.is_mandatory} onChange={(e) => setForm({ ...form, is_mandatory: e.target.checked })}
            className="w-4 h-4 rounded" />
          <span className="text-sm">Selección obligatoria</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.allow_multiple} onChange={(e) => setForm({ ...form, allow_multiple: e.target.checked })}
            className="w-4 h-4 rounded" />
          <span className="text-sm">Permitir repetir la misma opción</span>
        </label>
      </div>
    </div>
  )
}

function ModifierForm({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-slate-400 block mb-1">Nombre *</label>
        <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
          placeholder="Ej. Buffalo, BBQ, Habanero" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">Precio adicional ($) — dejar vacío si es gratis</label>
        <input type="number" min={0} step="0.01" value={form.price_cents}
          onChange={(e) => setForm({ ...form, price_cents: e.target.value })}
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
          placeholder="0.00" />
      </div>
    </div>
  )
}
