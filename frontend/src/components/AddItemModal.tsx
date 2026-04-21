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

  // Live stock check — refreshes every 15s or on open
  const { data: stockCheck } = useQuery({
    queryKey: ['stock-check'],
    queryFn: () => client.get('/inventory/stock-check').then(r => r.data),
    refetchInterval: 15000,
  })
  const blockedItems: string[] = stockCheck?.blocked_items ?? []
  const blockedModifiers: string[] = stockCheck?.blocked_modifiers ?? []

  // Is any modifier group a multi-select (bucket) group?
  const bucketGroup = selectedItem?.modifier_groups?.find((g: any) => g.allow_multiple && g.max_selections > 1)
  const singleGroups = selectedItem?.modifier_groups?.filter((g: any) => !g.allow_multiple) ?? []

  const bucketTotal = Object.values(bucketCounts).reduce((a: number, b: number) => a + b, 0)
  const bucketTarget = bucketGroup?.max_selections ?? 10

  const adjustBucket = (modId: string, delta: number) => {
    if (delta > 0 && blockedModifiers.includes(modId)) return // can't add OOS modifier
    const current = bucketCounts[modId] ?? 0
    const newVal = Math.max(0, current + delta)
    const newTotal = bucketTotal - current + newVal
    if (newTotal > bucketTarget) return
    setBucketCounts(prev => ({ ...prev, [modId]: newVal }))
  }

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

  const canContinueModifiers = () => {
    const singleOk = singleGroups.every((g: any) => !g.is_mandatory || !!selectedModifiers[g.id])
    const bucketOk = !bucketGroup || bucketTotal === bucketTarget
    return singleOk && bucketOk
  }

  const handleAddItem = async () => {
    setLoading(true)
    try {
      const modifiers: { modifier_id: string }[] = []
      Object.values(selectedModifiers).forEach(mid => modifiers.push({ modifier_id: mid }))
      Object.entries(bucketCounts).forEach(([mid, cnt]) => {
        for (let i = 0; i < cnt; i++) modifiers.push({ modifier_id: mid })
      })

      await client.post(
        `/tickets/${ticketId}/items`,
        { menu_item_id: selectedItem.id, quantity, notes, modifiers },
        { headers: { 'X-Ticket-Version': ticketVersion } }
      )
      toast.success(`${selectedItem.name} added`)
      onAdded()
      onClose()
    } catch (err: any) {
      if (err.response?.data?.error === 'OUT_OF_STOCK') {
        toast.error(`Sin stock: ${err.response.data.shortages.map((s: any) => `${s.name} (${s.available} disponible)`).join(', ')}`, { duration: 5000 })
      } else {
        toast.error(err.response?.data?.message || 'Failed to add item')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-40 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl border border-slate-600">
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="font-bold text-lg">Add Item</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-4">
          {step === 'category' && (
            <div className="grid grid-cols-2 gap-3">
              {(categories || []).map((cat: any) => (
                <button key={cat.id} onClick={() => { setSelectedCategory(cat); setStep('items') }}
                  className="bg-slate-700 hover:bg-slate-600 rounded-xl p-4 text-left">
                  <div className="font-semibold">{cat.name}</div>
                  <div className="text-xs text-slate-400">{cat.routing}</div>
                </button>
              ))}
            </div>
          )}

          {step === 'items' && (
            <div>
              <button onClick={() => setStep('category')} className="text-sky-400 text-sm mb-3">← {selectedCategory?.name}</button>
              <div className="grid grid-cols-2 gap-3">
                {(items || []).map((item: any) => {
                  const oos = blockedItems.includes(item.id)
                  return (
                    <button key={item.id} onClick={() => !oos && handleSelectItem(item)}
                      disabled={oos}
                      className={`rounded-xl p-4 text-left transition-all ${
                        oos
                          ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                          : 'bg-slate-700 hover:bg-slate-600'
                      }`}>
                      <div className="font-semibold">{item.name}</div>
                      <div className="text-sky-400 font-mono">${(item.price_cents / 100).toFixed(2)}</div>
                      {item.requires_flavor && !oos && <div className="text-xs text-yellow-400 mt-1">⚡ Flavor required</div>}
                      {oos && <div className="text-xs text-red-400 mt-1 font-semibold">🚫 Sin stock</div>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'modifiers' && selectedItem && (
            <div>
              <button onClick={() => setStep('items')} className="text-sky-400 text-sm mb-3">← {selectedItem.name}</button>

              {/* Single-select modifier groups */}
              {singleGroups.map((group: any) => (
                <div key={group.id} className="mb-5">
                  <div className="font-semibold mb-2">
                    {group.name}
                    {group.is_mandatory && <span className="text-red-400 text-xs ml-2">* Required</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.modifiers?.map((mod: any) => {
                      const oos = blockedModifiers.includes(mod.id)
                      return (
                        <button key={mod.id}
                          onClick={() => !oos && setSelectedModifiers(prev => ({ ...prev, [group.id]: mod.id }))}
                          disabled={oos}
                          className={`py-2 px-3 rounded-lg border text-sm transition-all ${
                            oos
                              ? 'bg-slate-800 border-slate-700 opacity-50 cursor-not-allowed'
                              : selectedModifiers[group.id] === mod.id
                                ? 'bg-sky-600 border-sky-500'
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
              ))}

              {/* Multi-select (bucket) modifier group */}
              {bucketGroup && (
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="font-semibold">
                      🪣 Pick your beers
                      <span className="text-red-400 text-xs ml-2">* Required</span>
                    </div>
                    <span className={`text-sm font-bold font-mono px-3 py-1 rounded-full border ${
                      bucketTotal === bucketTarget ? 'bg-green-800 border-green-600 text-green-300' : 'bg-slate-700 border-slate-600 text-slate-300'
                    }`}>
                      {bucketTotal} / {bucketTarget}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {bucketGroup.modifiers?.map((mod: any) => {
                      const cnt = bucketCounts[mod.id] ?? 0
                      const oos = blockedModifiers.includes(mod.id)
                      return (
                        <div key={mod.id} className={`flex items-center justify-between rounded-xl px-4 py-2.5 ${oos ? 'bg-slate-800 opacity-50' : 'bg-slate-700'}`}>
                          <div>
                            <span className="font-medium text-sm">{mod.name}</span>
                            {oos && <span className="block text-xs text-red-400">🚫 Sin stock</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            <button onClick={() => adjustBucket(mod.id, -1)} disabled={cnt === 0}
                              className="w-8 h-8 bg-slate-600 hover:bg-slate-500 rounded-lg font-bold text-lg disabled:opacity-30">−</button>
                            <span className={`w-8 text-center font-bold font-mono text-lg ${cnt > 0 ? 'text-yellow-300' : 'text-slate-500'}`}>{cnt}</span>
                            <button onClick={() => adjustBucket(mod.id, 1)} disabled={bucketTotal >= bucketTarget || oos}
                              className="w-8 h-8 bg-slate-600 hover:bg-slate-500 rounded-lg font-bold text-lg disabled:opacity-30">+</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {bucketTotal < bucketTarget && (
                    <p className="text-xs text-slate-400 mt-2 text-center">
                      Select {bucketTarget - bucketTotal} more beer{bucketTarget - bucketTotal !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              )}

              <button onClick={() => setStep('confirm')} disabled={!canContinueModifiers()}
                className="w-full mt-2 py-3 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold disabled:opacity-50">
                Continue →
              </button>
            </div>
          )}

          {step === 'confirm' && selectedItem && (
            <div>
              <button onClick={() => setStep(selectedItem.modifier_groups?.length > 0 ? 'modifiers' : 'items')} className="text-sky-400 text-sm mb-3">← Back</button>
              <div className="bg-slate-700 rounded-xl p-4 mb-4">
                <div className="font-bold text-lg">{selectedItem.name}</div>
                {Object.entries(selectedModifiers).map(([gid, mid]) => {
                  const group = selectedItem.modifier_groups?.find((g: any) => g.id === gid)
                  const mod = group?.modifiers?.find((m: any) => m.id === mid)
                  return mod ? <div key={gid} className="text-sm text-sky-300">→ {mod.name}</div> : null
                })}
                {bucketGroup && Object.entries(bucketCounts).filter(([, cnt]) => (cnt as number) > 0).map(([mid, cnt]) => {
                  const mod = bucketGroup.modifiers?.find((m: any) => m.id === mid)
                  return mod ? <div key={mid} className="text-sm text-yellow-300">🍺 {cnt}× {mod.name}</div> : null
                })}
              </div>
              <div className="flex items-center gap-4 mb-4">
                <span className="text-sm text-slate-400">Quantity</span>
                <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="w-8 h-8 bg-slate-700 rounded-lg font-bold">-</button>
                <span className="font-bold text-lg">{quantity}</span>
                <button onClick={() => setQuantity(quantity + 1)} className="w-8 h-8 bg-slate-700 rounded-lg font-bold">+</button>
              </div>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Special notes (optional)"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2 text-sm mb-4 resize-none"
                rows={2} />
              <button onClick={handleAddItem} disabled={loading}
                className="w-full py-3 bg-green-600 hover:bg-green-500 rounded-xl font-bold disabled:opacity-50">
                {loading ? 'Adding...' : `Add ${quantity}× ${selectedItem.name}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
