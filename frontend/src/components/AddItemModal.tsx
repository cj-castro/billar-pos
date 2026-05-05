import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import client from '../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../hooks/useEscKey'

interface Props {
  ticketId: string
  ticketVersion: number
  onClose: () => void
  onAdded: () => void
}

export default function AddItemModal({ ticketId, ticketVersion, onClose, onAdded }: Props) {
  const [step, setStep] = useState<'category' | 'items' | 'modifiers' | 'confirm'>('category')
  const [selectedCategory, setSelectedCategory] = useState<any>(null)
  const [selectedItem, setSelectedItem] = useState<any>(null)
  // Single-select modifiers: groupId → modifierId
  const [selectedModifiers, setSelectedModifiers] = useState<Record<string, string>>({})
  useEscKey(onClose)
  // Multi-select (bucket) modifiers: modifierId → count
  const [bucketCounts, setBucketCounts] = useState<Record<string, number>>({})
  const [quantity, setQuantity] = useState(1)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => client.get('/menu/categories').then(r => r.data),
  })

  const { data: items } = useQuery({
    queryKey: ['items', selectedCategory?.id],
    queryFn: () => client.get('/menu/items', { params: { category_id: selectedCategory.id } }).then(r => r.data),
    enabled: !!selectedCategory,
  })

  // Live stock check — refreshes every 10s and always on mount
  const { data: stockCheck } = useQuery({
    queryKey: ['stock-check'],
    queryFn: () => client.get('/inventory/stock-check').then(r => r.data),
    refetchInterval: 10000,
    staleTime: 0,
  })
  const blockedItems: string[] = stockCheck?.blocked_items ?? []
  const blockedModifiers: string[] = stockCheck?.blocked_modifiers ?? []
  const lowStockItemIds: string[] = stockCheck?.low_stock_item_ids ?? []
  const lowStockNames: string[] = (stockCheck?.low_stock_items ?? []).map((i: any) => i.name)
  const remainingByItem: Record<string, number> = stockCheck?.remaining_by_item ?? {}

  // All modifier groups — each can be single-select OR multi-select (bucket)
  const allGroups: any[] = selectedItem?.modifier_groups ?? []

  // Per-group bucket totals (for allow_multiple groups)
  const bucketTotalFor = (groupId: string) =>
    Object.entries(bucketCounts)
      .filter(([k]) => k.startsWith(groupId + ':'))
      .reduce((s, [, v]) => s + (v as number), 0)

  const adjustBucket = (groupId: string, modId: string, delta: number) => {
    const key = `${groupId}:${modId}`
    if (delta > 0 && blockedModifiers.includes(modId)) return
    const group = allGroups.find((g: any) => g.id === groupId)
    const target = group?.max_selections ?? 10
    const current = bucketCounts[key] ?? 0
    const newVal = Math.max(0, current + delta)
    const newTotal = bucketTotalFor(groupId) - current + newVal
    if (newTotal > target) return
    setBucketCounts(prev => ({ ...prev, [key]: newVal }))
  }

  const bucketCountFor = (groupId: string, modId: string) =>
    bucketCounts[`${groupId}:${modId}`] ?? 0

  const handleSelectItem = (item: any) => {
    setSelectedItem(item)
    setSelectedModifiers({})
    setBucketCounts({})
    if (item.modifier_groups?.length > 0) {
      setStep('modifiers')
    } else {
      setStep('confirm')
    }
  }

  const groupIsComplete = (g: any) => {
    if (g.allow_multiple) return bucketTotalFor(g.id) >= (g.min_selections ?? 1)
    return !g.is_mandatory || !!selectedModifiers[g.id]
  }

  const canContinueModifiers = () => allGroups.every(groupIsComplete)

  const handleAddItem = async () => {
    setLoading(true)
    try {
      const modifiers: { modifier_id: string }[] = []
      Object.values(selectedModifiers).forEach(mid => modifiers.push({ modifier_id: mid as string }))
      Object.entries(bucketCounts).forEach(([key, cnt]) => {
        const modId = key.split(':')[1]
        for (let i = 0; i < (cnt as number); i++) modifiers.push({ modifier_id: modId })
      })

      await client.post(
        `/tickets/${ticketId}/items`,
        { menu_item_id: selectedItem.id, quantity, notes, modifiers },
        { headers: { 'X-Ticket-Version': ticketVersion } }
      )
      toast.success(`${selectedItem.name} añadido ✓`)
      onAdded()
      // Stay on items step — let user keep adding from the same category
      setStep('items')
      setSelectedItem(null)
      setSelectedModifiers({})
      setBucketCounts({})
      setQuantity(1)
      setNotes('')
    } catch (err: any) {
      if (err.response?.data?.error === 'OUT_OF_STOCK') {
        toast.error(`Sin stock: ${err.response.data.shortages.map((s: any) => `${s.name} (${s.available} disponible)`).join(', ')}`, { duration: 5000 })
      } else {
        toast.error(err.response?.data?.message || 'No se pudo agregar el artículo')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-[60] p-2 sm:p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg max-h-[92dvh] flex flex-col shadow-2xl border border-slate-600">
        <div className="flex items-center justify-between p-4 border-b border-slate-700 shrink-0">
          <h2 className="font-bold text-lg">Agregar Artículo</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl">&times;</button>
        </div>

        <div className="overflow-y-scroll flex-1 p-3 sm:p-4 overscroll-contain">
          {/* Low-stock global warning banner */}
          {lowStockNames.length > 0 && (
            <div className="mb-3 bg-amber-900/40 border border-amber-700 rounded-xl px-3 py-2 text-xs text-amber-300">
              ⚠️ <span className="font-semibold">Stock bajo:</span> {lowStockNames.join(', ')}
            </div>
          )}

          {step === 'category' && (
            <div className="grid grid-cols-2 gap-2">
              {(categories || []).map((cat: any) => (
                <button key={cat.id} onClick={() => { setSelectedCategory(cat); setStep('items') }}
                  className="bg-slate-700 active:bg-slate-600 rounded-xl p-3 text-left min-h-[56px]">
                  <div className="font-semibold text-sm">{cat.name}</div>
                  <div className="text-xs text-slate-400">{cat.routing}</div>
                </button>
              ))}
            </div>
          )}

          {step === 'items' && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <button onClick={() => setStep('category')} className="text-sky-400 text-sm">← {selectedCategory?.name}</button>
                <button onClick={onClose} className="px-4 py-1.5 bg-green-700 hover:bg-green-600 text-white text-sm font-bold rounded-lg">✓ Listo</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {(items || []).map((item: any) => {
                  const oos = blockedItems.includes(item.id) || (remainingByItem[item.id] !== undefined && remainingByItem[item.id] <= 0)
                  const lowStock = !oos && lowStockItemIds.includes(item.id)
                  const remaining = remainingByItem[item.id]
                  return (
                    <button key={item.id} onClick={() => !oos && handleSelectItem(item)}
                      disabled={oos}
                      className={`rounded-xl p-4 text-left transition-all relative ${
                        oos
                          ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                          : lowStock
                            ? 'bg-amber-950/60 border border-amber-700 hover:border-amber-500'
                            : 'bg-slate-700 hover:bg-slate-600'
                      }`}>
                      <div className="font-semibold">{item.name}</div>
                      <div className="text-sky-400 font-mono">${(item.price_cents / 100).toFixed(2)}</div>
                      {item.requires_flavor && !oos && <div className="text-xs text-yellow-400 mt-1">⚡ Flavor required</div>}
                      {oos && <div className="text-xs text-red-400 mt-1 font-semibold">🚫 Sin stock</div>}
                      {lowStock && remaining !== undefined && (
                        <div className="text-xs text-amber-400 mt-1 font-semibold">⚠️ {remaining} restante{remaining !== 1 ? 's' : ''}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'modifiers' && selectedItem && (
            <div>
              <button onClick={() => setStep('items')} className="text-sky-400 text-sm mb-3">← {selectedItem.name}</button>

              {/* Progress indicator when multiple groups */}
              {allGroups.length > 1 && (
                <div className="flex gap-1.5 mb-4">
                  {allGroups.map((g: any) => (
                    <div key={g.id} className={`flex-1 h-1.5 rounded-full transition-colors ${groupIsComplete(g) ? 'bg-sky-500' : 'bg-slate-600'}`} />
                  ))}
                </div>
              )}

              {allGroups.map((group: any) => {
                const done = groupIsComplete(group)
                if (group.allow_multiple) {
                  // ── Multi-select (bucket) group ────────────────────────
                  const total = bucketTotalFor(group.id)
                  const target = group.max_selections
                  return (
                    <div key={group.id} className="mb-5">
                      <div className="flex items-center justify-between mb-3">
                        <div className="font-semibold">
                          🪣 {group.name}
                          <span className="text-red-400 text-xs ml-2">* Obligatorio</span>
                        </div>
                        <span className={`text-sm font-bold font-mono px-3 py-1 rounded-full border ${
                          done ? 'bg-green-800 border-green-600 text-green-300' : 'bg-slate-700 border-slate-600 text-slate-300'
                        }`}>{total} / {target}</span>
                      </div>
                      <div className="space-y-2">
                        {group.modifiers?.map((mod: any) => {
                          const cnt = bucketCountFor(group.id, mod.id)
                          const oos = blockedModifiers.includes(mod.id)
                          return (
                            <div key={mod.id} className={`flex items-center justify-between rounded-xl px-4 py-2.5 ${oos ? 'bg-slate-800 opacity-50' : 'bg-slate-700'}`}>
                              <div>
                                <span className="font-medium text-sm">{mod.name}</span>
                                {oos && <span className="block text-xs text-red-400">🚫 Sin stock</span>}
                              </div>
                              <div className="flex items-center gap-2">
                                <button onClick={() => adjustBucket(group.id, mod.id, -1)} disabled={cnt === 0}
                                  className="w-8 h-8 bg-slate-600 hover:bg-slate-500 rounded-lg font-bold text-lg disabled:opacity-30">−</button>
                                <span className={`w-8 text-center font-bold font-mono text-lg ${cnt > 0 ? 'text-yellow-300' : 'text-slate-500'}`}>{cnt}</span>
                                <button onClick={() => adjustBucket(group.id, mod.id, 1)} disabled={total >= target || oos}
                                  className="w-8 h-8 bg-slate-600 hover:bg-slate-500 rounded-lg font-bold text-lg disabled:opacity-30">+</button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      {total < target && (
                        <p className="text-xs text-slate-400 mt-2 text-center">
                          Selecciona {target - total} más
                        </p>
                      )}
                    </div>
                  )
                } else {
                  // ── Single-select group ────────────────────────────────
                  return (
                    <div key={group.id} className="mb-5">
                      <div className="font-semibold mb-2 flex items-center gap-2">
                        {group.name}
                        {group.is_mandatory
                          ? done
                            ? <span className="text-green-400 text-xs">✓</span>
                            : <span className="text-red-400 text-xs">* Obligatorio</span>
                          : <span className="text-slate-400 text-xs">Opcional</span>
                        }
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {group.modifiers?.map((mod: any) => {
                          const oos = blockedModifiers.includes(mod.id)
                          const selected = selectedModifiers[group.id] === mod.id
                          return (
                            <button key={mod.id}
                              onClick={() => {
                                if (oos) return
                                // Toggle off if already selected (for optional groups)
                                if (selected && !group.is_mandatory) {
                                  setSelectedModifiers(prev => { const n = { ...prev }; delete n[group.id]; return n })
                                } else {
                                  setSelectedModifiers(prev => ({ ...prev, [group.id]: mod.id }))
                                }
                              }}
                              disabled={oos}
                              className={`py-2 px-3 rounded-lg border text-sm transition-all ${
                                oos
                                  ? 'bg-slate-800 border-slate-700 opacity-50 cursor-not-allowed'
                                  : selected
                                    ? 'bg-sky-600 border-sky-500 ring-2 ring-sky-400'
                                    : 'bg-slate-700 border-slate-600 hover:border-sky-500'
                              }`}>
                              {mod.name}
                              {mod.price_cents > 0 && !oos && <span className="text-xs text-slate-400 ml-1">+${(mod.price_cents / 100).toFixed(2)}</span>}
                              {oos && <span className="block text-xs text-red-400">🚫 Sin stock</span>}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                }
              })}

              <button onClick={() => setStep('confirm')} disabled={!canContinueModifiers()}
                className="w-full mt-2 py-3 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold disabled:opacity-50 disabled:cursor-not-allowed">
                {canContinueModifiers() ? 'Continuar →' : `Faltan selecciones obligatorias`}
              </button>
            </div>
          )}

          {step === 'confirm' && selectedItem && (
            <div>
              <button onClick={() => setStep(allGroups.length > 0 ? 'modifiers' : 'items')} className="text-sky-400 text-sm mb-3">← Atrás</button>
              <div className="bg-slate-700 rounded-xl p-4 mb-4">
                <div className="font-bold text-lg">{selectedItem.name}</div>
                {allGroups.map((group: any) => {
                  if (group.allow_multiple) {
                    return Object.entries(bucketCounts)
                      .filter(([k, cnt]) => k.startsWith(group.id + ':') && (cnt as number) > 0)
                      .map(([k, cnt]) => {
                        const modId = k.split(':')[1]
                        const mod = group.modifiers?.find((m: any) => m.id === modId)
                        return mod ? <div key={k} className="text-sm text-yellow-300">🍺 {cnt}× {mod.name}</div> : null
                      })
                  }
                  const mid = selectedModifiers[group.id]
                  const mod = group.modifiers?.find((m: any) => m.id === mid)
                  return mod ? <div key={group.id} className="text-sm text-sky-300">→ {group.name}: {mod.name}</div> : null
                })}
              </div>
              <div className="flex items-center gap-4 mb-4">
                <span className="text-sm text-slate-400">Cantidad</span>
                <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="w-8 h-8 bg-slate-700 rounded-lg font-bold">-</button>
                <span className="font-bold text-lg">{quantity}</span>
                <button onClick={() => setQuantity(quantity + 1)} className="w-8 h-8 bg-slate-700 rounded-lg font-bold">+</button>
              </div>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Notas especiales (opcional)"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2 text-sm mb-4 resize-none"
                rows={2} />
              <button onClick={handleAddItem} disabled={loading}
                className="w-full py-3 bg-green-600 hover:bg-green-500 rounded-xl font-bold disabled:opacity-50">
                {loading ? 'Añadiendo...' : `Agregar ${quantity}× ${selectedItem.name}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
