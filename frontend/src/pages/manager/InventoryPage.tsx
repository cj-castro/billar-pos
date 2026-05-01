import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'
import { useSocket } from '../../hooks/useSocket'
import { useAuthStore } from '../../stores/authStore'
import { useUnitCatalog } from '../../hooks/useUnitCatalog'
import { formatMXN } from '../../utils/money'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InventoryItem {
  id: string
  name: string
  sku: string | null
  supplier: string | null
  category: string
  item_type: string
  base_unit_key: string
  stock_quantity: number
  low_stock_threshold: number
  unit_cost_cents: number
  purchase_unit_key: string | null
  purchase_pack_size: number
  shots_per_bottle: number | null
  yields_item_id: string | null
  is_active: boolean
  is_low: boolean
}

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

const EVENT_TYPE_COLORS: Record<string, string> = {
  RESTOCK:            'text-emerald-400',
  SALE_DEDUCTION:     'text-red-400',
  SALE_CONSUMPTION:   'text-red-400',
  VOID_REVERSAL:      'text-green-400',
  MANUAL_ADJUSTMENT:  'text-sky-400',
  WASTE:              'text-red-500',
  COUNT_ADJUSTMENT:   'text-violet-400',
  BOTTLE_OPENING:     'text-amber-400',
  BOX_OPENING:        'text-orange-400',
  PORTION_CONVERSION: 'text-teal-400',
  OPENING_STOCK:      'text-purple-400',
}

// Weighted average cost formula — mirrors backend exactly
function computeWAC(oldQty: number, oldWacCents: number, deltaQty: number, incomingCostCents: number): number {
  if (oldQty <= 0) return incomingCostCents
  return Math.round((oldQty * oldWacCents + deltaQty * incomingCostCents) / (oldQty + deltaQty))
}

function fmtQty(qty: number): string {
  const n = parseFloat(qty.toFixed(4))
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2).replace(/\.?0+$/, '')
}

// ── Blank form states ─────────────────────────────────────────────────────────

const BLANK_NEW = {
  name: '', sku: '', supplier: '', category: 'beer', item_type: 'STANDARD',
  base_unit_key: 'botella', stock_quantity: '', low_stock_threshold: '6',
  initial_cost_pesos: '', purchase_unit_key: '', purchase_pack_size: '1',
  shots_per_bottle: '', yields_item_id: '',
}

// ── Main component ────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const socket = useSocket()
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'ADMIN'
  const { units, getUnitName } = useUnitCatalog()

  // list UI
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // modal states
  const [showNew, setShowNew] = useState(false)
  const [newItem, setNewItem] = useState({ ...BLANK_NEW })
  const [editing, setEditing] = useState<InventoryItem | null>(null)
  const [editForm, setEditForm] = useState<any>(null)
  const [restocking, setRestocking] = useState<InventoryItem | null>(null)
  const [adjusting, setAdjusting] = useState<InventoryItem | null>(null)
  const [openingBottle, setOpeningBottle] = useState<InventoryItem | null>(null)
  const [openingBox, setOpeningBox] = useState<InventoryItem | null>(null)
  const [viewingMovements, setViewingMovements] = useState<InventoryItem | null>(null)
  const [showCatalog, setShowCatalog] = useState(false)
  const [addToMenu, setAddToMenu] = useState<InventoryItem | null>(null)
  const [menuForm, setMenuForm] = useState({ category_id: '', price_cents: 0, requires_flavor: false })

  // restock form
  const [restockPurchaseQty, setRestockPurchaseQty] = useState('')
  const [restockCostPesos, setRestockCostPesos] = useState('')
  const [restockPackOverride, setRestockPackOverride] = useState('')
  const [restockPortionCount, setRestockPortionCount] = useState('')
  const [restockTotalCostPesos, setRestockTotalCostPesos] = useState('')
  const [restockNote, setRestockNote] = useState('')

  // adjust form
  const [adjustType, setAdjustType] = useState('MANUAL_ADJUSTMENT')
  const [adjustDelta, setAdjustDelta] = useState('')
  const [adjustCounted, setAdjustCounted] = useState('')
  const [adjustWaste, setAdjustWaste] = useState('')
  const [adjustReason, setAdjustReason] = useState('')

  const [saving, setSaving] = useState(false)

  // 300ms search debounce
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search])

  // socket events
  useEffect(() => {
    if (!socket) return
    socket.on('inventory:box_finished', (data: any) => {
      toast(`🚬 Caja terminada: ${data.brand}`, {
        duration: 10000, icon: '📦',
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
  }, [socket, qc])

  useEscKey(() => {
    if (viewingMovements) { setViewingMovements(null); return }
    if (editing)          { setEditing(null); return }
    if (restocking)       { setRestocking(null); return }
    if (adjusting)        { setAdjusting(null); return }
    if (openingBottle)    { setOpeningBottle(null); return }
    if (openingBox)       { setOpeningBox(null); return }
    if (showCatalog)      { setShowCatalog(false); return }
    if (showNew)          { setShowNew(false); return }
    if (addToMenu)        { setAddToMenu(null); return }
  }, showNew || !!editing || !!restocking || !!adjusting || !!openingBottle || !!openingBox || !!viewingMovements || showCatalog || !!addToMenu)

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: items = [] } = useQuery<InventoryItem[]>({
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
    queryFn: () => client.get(`/inventory/${viewingMovements!.id}/movements`).then(r => r.data),
    enabled: !!viewingMovements,
    staleTime: 0,
  })

  const { data: openBoxes = [] } = useQuery({
    queryKey: ['open-boxes'],
    queryFn: () => client.get('/inventory/open-boxes').then(r => r.data),
    refetchInterval: 30000,
  })

  // ── Filtered list ──────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let list = items
    if (tab !== 'all') list = list.filter(i => i.category === tab)
    if (lowStockOnly)  list = list.filter(i => i.is_low)
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      list = list.filter(i =>
        i.name.toLowerCase().includes(q) ||
        (i.sku ?? '').toLowerCase().includes(q) ||
        (i.supplier ?? '').toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q)
      )
    }
    return list
  }, [items, tab, lowStockOnly, debouncedSearch])

  // ── Restock WAC preview (client-side) ─────────────────────────────────────

  const restockPreview = useMemo(() => {
    if (!restocking) return null
    const isFood = restocking.category === 'food'
    if (isFood) {
      const portions = parseFloat(restockPortionCount)
      const totalCentavos = Math.round(parseFloat(restockTotalCostPesos || '0') * 100)
      if (!portions || portions <= 0) return null
      const costPerPortion = Math.round(totalCentavos / portions)
      const newWAC = computeWAC(restocking.stock_quantity, restocking.unit_cost_cents, portions, costPerPortion)
      return { delta: portions, costPerBase: costPerPortion, newWAC }
    } else {
      const purchaseQty = parseFloat(restockPurchaseQty)
      const costCents = Math.round(parseFloat(restockCostPesos || '0') * 100)
      const packSize = parseFloat(restockPackOverride || String(restocking.purchase_pack_size)) || 1
      if (!purchaseQty || purchaseQty <= 0) return null
      const delta = purchaseQty * packSize
      const costPerBase = Math.round(costCents / packSize)
      const newWAC = computeWAC(restocking.stock_quantity, restocking.unit_cost_cents, delta, costPerBase)
      return { delta, costPerBase, newWAC }
    }
  }, [restocking, restockPurchaseQty, restockCostPesos, restockPackOverride, restockPortionCount, restockTotalCostPesos])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!newItem.name.trim()) return toast.error('Se requiere un nombre')
    if (!newItem.base_unit_key) return toast.error('Se requiere unidad base')
    setSaving(true)
    try {
      const payload: any = {
        name: newItem.name.trim(),
        category: newItem.category,
        item_type: newItem.item_type,
        base_unit_key: newItem.base_unit_key,
        stock_quantity: parseFloat(newItem.stock_quantity as any) || 0,
        low_stock_threshold: parseFloat(newItem.low_stock_threshold as any) || 0,
        unit_cost_cents: Math.round(parseFloat(newItem.initial_cost_pesos || '0') * 100),
      }
      if (newItem.sku.trim())      payload.sku = newItem.sku.trim()
      if (newItem.supplier.trim()) payload.supplier = newItem.supplier.trim()
      if (newItem.purchase_unit_key) payload.purchase_unit_key = newItem.purchase_unit_key
      if (newItem.purchase_pack_size) payload.purchase_pack_size = parseFloat(newItem.purchase_pack_size) || 1
      if (newItem.shots_per_bottle) payload.shots_per_bottle = parseInt(newItem.shots_per_bottle)
      if (newItem.yields_item_id)   payload.yields_item_id = newItem.yields_item_id
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
      const payload: any = {
        name: editForm.name.trim(),
        category: editForm.category,
        item_type: editForm.item_type,
        base_unit_key: editForm.base_unit_key,
        low_stock_threshold: parseFloat(editForm.low_stock_threshold) || 0,
        sku: editForm.sku?.trim() || null,
        supplier: editForm.supplier?.trim() || null,
        purchase_unit_key: editForm.purchase_unit_key || null,
        purchase_pack_size: parseFloat(editForm.purchase_pack_size) || 1,
        shots_per_bottle: editForm.shots_per_bottle ? parseInt(editForm.shots_per_bottle) : null,
        yields_item_id: editForm.yields_item_id || null,
      }
      await client.patch(`/inventory/${editing!.id}`, payload)
      toast.success('Artículo actualizado')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setEditing(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const handleRestock = async () => {
    if (!restocking) return
    setSaving(true)
    try {
      const isFood = restocking.category === 'food'
      let payload: any = { reason: restockNote || undefined }

      if (isFood) {
        const portions = parseFloat(restockPortionCount)
        if (!portions || portions <= 0) { toast.error('Se requiere cantidad de porciones > 0'); return }
        payload.portion_count = portions
        payload.total_purchase_cost_cents = Math.round(parseFloat(restockTotalCostPesos || '0') * 100)
      } else {
        const qty = parseFloat(restockPurchaseQty)
        if (!qty || qty <= 0) { toast.error('Se requiere cantidad > 0'); return }
        const costCents = Math.round(parseFloat(restockCostPesos || '0') * 100)
        if (costCents < 0) { toast.error('El costo no puede ser negativo'); return }
        payload.purchase_quantity = qty
        payload.unit_cost_per_purchase_unit_cents = costCents
        if (restockPackOverride) payload.pack_size_override = parseFloat(restockPackOverride)
      }

      await client.post(`/inventory/${restocking.id}/restock`, payload)
      toast.success('Reabasto registrado')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setRestocking(null)
      setRestockPurchaseQty(''); setRestockCostPesos(''); setRestockPackOverride('')
      setRestockPortionCount(''); setRestockTotalCostPesos(''); setRestockNote('')
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al reabastecer')
    } finally { setSaving(false) }
  }

  const handleAdjust = async () => {
    if (!adjusting) return
    if (!adjustReason.trim()) return toast.error('Se requiere un motivo')
    setSaving(true)
    try {
      const payload: any = { event_type: adjustType, reason: adjustReason.trim() }
      if (adjustType === 'WASTE')            payload.waste_quantity = parseFloat(adjustWaste)
      else if (adjustType === 'COUNT_ADJUSTMENT') payload.counted_quantity = parseFloat(adjustCounted)
      else                                   payload.qty_delta = parseFloat(adjustDelta)

      await client.post(`/inventory/${adjusting.id}/adjust`, payload)
      toast.success('Inventario ajustado')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setAdjusting(null)
      setAdjustDelta(''); setAdjustCounted(''); setAdjustWaste(''); setAdjustReason('')
    } catch (err: any) {
      const msg = err.response?.data?.message || 'Error al guardar'
      if (msg.includes('WOULD_GO_NEGATIVE') || msg.includes('WASTE_EXCEEDS')) {
        toast.error('No hay suficiente stock para esta operación')
      } else {
        toast.error(msg)
      }
    } finally { setSaving(false) }
  }

  const handleOpenBottle = async () => {
    if (!openingBottle) return
    setSaving(true)
    try {
      await client.post(`/inventory/${openingBottle.id}/open-bottle`)
      toast.success(`🍾 +${openingBottle.shots_per_bottle} copas añadidas`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setOpeningBottle(null)
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error') }
    finally { setSaving(false) }
  }

  const handleOpenBox = async () => {
    if (!openingBox) return
    setSaving(true)
    try {
      await client.post(`/inventory/${openingBox.id}/open-box`)
      toast.success(`🚬 +${openingBox.shots_per_bottle} cigarros disponibles`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['open-boxes'] })
      setOpeningBox(null)
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error') }
    finally { setSaving(false) }
  }

  const handleDelete = async (item: InventoryItem) => {
    if (!window.confirm(`⚠️ ¿Eliminar permanentemente "${item.name}"?\n\nSe eliminarán todos los movimientos históricos.\n\nEsta acción no se puede deshacer.`)) return
    try {
      const res = await client.delete(`/inventory/${item.id}`)
      const moved = res.data?.movements_deleted ?? 0
      toast.success(`"${item.name}" eliminado${moved > 0 ? ` · ${moved} movimientos eliminados` : ''}`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error al eliminar') }
  }

  const handleAddToMenu = async () => {
    if (!addToMenu) return
    if (!menuForm.category_id) return toast.error('Selecciona una categoría')
    if (menuForm.price_cents <= 0) return toast.error('El precio debe ser mayor a cero')
    setSaving(true)
    try {
      const res = await client.post('/menu/items', {
        name: addToMenu.name, category_id: menuForm.category_id,
        price_cents: menuForm.price_cents, requires_flavor: menuForm.requires_flavor, sort_order: 0,
      })
      await client.post('/inventory/insumos-base', {
        menu_item_id: res.data.id, inventory_item_id: addToMenu.id,
        quantity: 1, deduction_unit_key: addToMenu.base_unit_key,
      })
      toast.success(`"${addToMenu.name}" añadido al menú ✅`)
      qc.invalidateQueries({ queryKey: ['all-items'] })
      setAddToMenu(null); setMenuForm({ category_id: '', price_cents: 0, requires_flavor: false })
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error') }
    finally { setSaving(false) }
  }

  const openEdit = (item: InventoryItem) => {
    setEditForm({
      name: item.name,
      sku: item.sku ?? '',
      supplier: item.supplier ?? '',
      category: item.category,
      item_type: item.item_type,
      base_unit_key: item.base_unit_key,
      low_stock_threshold: String(item.low_stock_threshold),
      purchase_unit_key: item.purchase_unit_key ?? '',
      purchase_pack_size: String(item.purchase_pack_size),
      shots_per_bottle: item.shots_per_bottle ? String(item.shots_per_bottle) : '',
      yields_item_id: item.yields_item_id ?? '',
    })
    setEditing(item)
  }

  const openRestock = (item: InventoryItem) => {
    setRestockPurchaseQty(''); setRestockCostPesos('')
    setRestockPackOverride(''); setRestockPortionCount('')
    setRestockTotalCostPesos(''); setRestockNote('')
    setRestocking(item)
  }

  const openAdjust = (item: InventoryItem) => {
    setAdjustType('MANUAL_ADJUSTMENT'); setAdjustDelta('')
    setAdjustCounted(String(item.stock_quantity)); setAdjustWaste('')
    setAdjustReason('')
    setAdjusting(item)
  }

  // ── Unit dropdown helper ───────────────────────────────────────────────────

  const UnitSelect = ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
        {units.filter(u => u.active).map(u => (
          <option key={u.key} value={u.key}>{getUnitName(u.key)}</option>
        ))}
      </select>
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-3xl mx-auto p-4">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">📦 {t('inventory.title')}</h1>
          <div className="flex gap-2">
            {isAdmin && (
              <button onClick={() => setShowCatalog(true)}
                className="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-300">
                ⚙️ {t('inventory.unitCatalog')}
              </button>
            )}
            <button onClick={() => setShowNew(true)}
              className="bg-sky-600 hover:bg-sky-500 px-4 py-1.5 rounded-lg text-sm font-semibold">
              + {t('inventory.addItem')}
            </button>
          </div>
        </div>

        {/* Search + filters */}
        <div className="flex gap-2 mb-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('inventory.search')}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder-slate-500"
          />
          <button onClick={() => setLowStockOnly(v => !v)}
            className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap ${
              lowStockOnly ? 'bg-red-700 border-red-600 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}>
            ⚠ {t('inventory.lowStockOnly')}
          </button>
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

        {/* Open cigarette boxes banner */}
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
                      <div className={`h-2 rounded-full ${isLow ? 'bg-red-500' : 'bg-orange-500'}`}
                        style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Item list */}
        <div className="space-y-2">
          {filtered.map((item) => (
            <div key={item.id}
              className={`bg-slate-800 rounded-xl p-4 flex items-start justify-between border ${item.is_low ? 'border-red-700' : 'border-slate-700'}`}>
              <div className="flex-1 min-w-0 mr-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold truncate">{item.name}</span>
                  {item.sku && <span className="text-xs text-slate-500 font-mono">{item.sku}</span>}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {getUnitName(item.base_unit_key)} · {CATEGORY_LABELS[item.category]?.replace(/^.+ /, '') ?? item.category}
                  {item.supplier && <span className="ml-2 text-slate-500">{item.supplier}</span>}
                </div>
                {item.is_low && <div className="text-xs text-red-400 font-semibold mt-0.5">⚠ {t('inventory.lowStock')}</div>}
                {item.item_type === 'CIG_BOX' && item.shots_per_bottle && (
                  <div className="text-xs text-orange-400 mt-0.5">🚬 {item.shots_per_bottle} cigarros/caja</div>
                )}
                {item.item_type === 'BOTTLE' && item.shots_per_bottle && (
                  <div className="text-xs text-amber-400 mt-0.5">🍾 {item.shots_per_bottle} copas/botella</div>
                )}
                {item.unit_cost_cents > 0 && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    {t('inventory.unitCost')}: {formatMXN(item.unit_cost_cents)}/{getUnitName(item.base_unit_key)}
                  </div>
                )}
              </div>

              <div className="flex items-start gap-1.5 flex-shrink-0">
                {/* Stock quantity */}
                <div className={`font-bold text-lg font-mono text-right min-w-[3.5rem] ${item.is_low ? 'text-red-400' : 'text-white'}`}>
                  {fmtQty(item.stock_quantity)}
                  <div className="text-xs font-normal text-slate-400">{getUnitName(item.base_unit_key)}</div>
                </div>

                <div className="flex flex-col gap-1 ml-1">
                  {/* Bottle / box open buttons */}
                  {item.item_type === 'BOTTLE' && item.shots_per_bottle && item.yields_item_id && (
                    <button onClick={() => setOpeningBottle(item)}
                      className="bg-amber-700 hover:bg-amber-600 px-2 py-1 rounded-lg text-xs font-bold">🍾 Abrir</button>
                  )}
                  {item.item_type === 'CIG_BOX' && item.shots_per_bottle && item.yields_item_id && (
                    <button onClick={() => setOpeningBox(item)}
                      className="bg-orange-700 hover:bg-orange-600 px-2 py-1 rounded-lg text-xs font-bold">🚬 Abrir</button>
                  )}
                  <button onClick={() => openRestock(item)}
                    className="bg-emerald-800 hover:bg-emerald-700 px-2 py-1 rounded-lg text-xs font-bold text-emerald-300">
                    📦 {t('inventory.restock')}
                  </button>
                  <button onClick={() => openAdjust(item)}
                    className="bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded-lg text-xs">
                    {t('inventory.adjust')}
                  </button>
                  <button onClick={() => openEdit(item)}
                    className="bg-slate-700 hover:bg-sky-700 px-2 py-1 rounded-lg text-xs" title="Editar">✏️</button>
                  <button onClick={() => setViewingMovements(item)}
                    className="bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded-lg text-xs text-slate-300" title="Movimientos">📋</button>
                  {isAdmin && (
                    <button onClick={() => handleDelete(item)}
                      className="bg-slate-700 hover:bg-red-800 px-2 py-1 rounded-lg text-xs text-red-400" title="Eliminar">🗑</button>
                  )}
                  {/* Add to menu */}
                  {(() => {
                    const inMenu = (menuItems as any[]).some((m: any) =>
                      m.name.toLowerCase() === item.name.toLowerCase()
                    )
                    return inMenu
                      ? <span className="text-xs text-emerald-400 font-semibold text-center">✅ Menú</span>
                      : <button onClick={() => { setAddToMenu(item); setMenuForm({ category_id: '', price_cents: 0, requires_flavor: false }) }}
                          className="bg-emerald-800 hover:bg-emerald-700 px-2 py-1 rounded-lg text-xs font-bold">🍽️ Menú</button>
                  })()}
                </div>
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="text-center text-slate-500 py-10">
              {debouncedSearch ? `Sin resultados para "${debouncedSearch}"` : 'Sin artículos en esta categoría'}
            </div>
          )}
        </div>
      </div>

      {/* ── Restock Modal ──────────────────────────────────────────────────── */}
      {restocking && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-emerald-700">
            <h2 className="font-bold mb-1 text-emerald-300">📦 {t('inventory.restock')}</h2>
            <p className="text-slate-400 text-sm mb-4">
              {restocking.name} · {t('inventory.currentStock')}: {fmtQty(restocking.stock_quantity)} {getUnitName(restocking.base_unit_key)}
            </p>

            {restocking.category === 'food' ? (
              /* Food portion mode */
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.portionCount')} *</label>
                  <input type="number" min={0.01} step="any" value={restockPortionCount}
                    onChange={e => setRestockPortionCount(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                    placeholder="ej. 45" autoFocus />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.totalBatchCost')} *</label>
                  <input type="number" min={0} step="0.01" value={restockTotalCostPesos}
                    onChange={e => setRestockTotalCostPesos(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                    placeholder="0.00" />
                </div>
                {restockPreview && (
                  <div className="bg-slate-700/50 rounded-lg p-3 text-sm space-y-1">
                    <div className="text-slate-400">
                      Costo por porción: <span className="text-white font-semibold">{formatMXN(restockPreview.costPerBase)}</span>
                    </div>
                    <div className="text-emerald-300 font-semibold">
                      {t('inventory.newWAC')}: {formatMXN(restockPreview.newWAC)}/{getUnitName(restocking.base_unit_key)}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Drinks / general mode */
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Cantidad ({restocking.purchase_unit_key ? getUnitName(restocking.purchase_unit_key) : getUnitName(restocking.base_unit_key)}) *
                    </label>
                    <input type="number" min={0.01} step="any" value={restockPurchaseQty}
                      onChange={e => setRestockPurchaseQty(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                      placeholder="ej. 5" autoFocus />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Uds/paquete
                      {restocking.purchase_pack_size > 1 && (
                        <span className="text-slate-500 ml-1">(pred: {restocking.purchase_pack_size})</span>
                      )}
                    </label>
                    <input type="number" min={0.0001} step="any"
                      value={restockPackOverride}
                      onChange={e => setRestockPackOverride(e.target.value)}
                      placeholder={String(restocking.purchase_pack_size)}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                  </div>
                </div>

                {restockPreview && (
                  <div className="bg-slate-700/30 rounded-lg px-3 py-2 text-sm text-emerald-300">
                    → {fmtQty(restockPreview.delta)} {getUnitName(restocking.base_unit_key)} al inventario
                  </div>
                )}

                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.costPerPurchaseUnit')} *</label>
                  <input type="number" min={0} step="0.01" value={restockCostPesos}
                    onChange={e => setRestockCostPesos(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                    placeholder="0.00" />
                </div>

                {restockPreview && restockCostPesos && (
                  <div className="bg-slate-700/50 rounded-lg p-3 text-sm space-y-1">
                    <div className="text-slate-400">
                      Por {getUnitName(restocking.base_unit_key)}: <span className="text-white font-semibold">{formatMXN(restockPreview.costPerBase)}</span>
                    </div>
                    <div className="text-emerald-300 font-semibold">
                      {t('inventory.newWAC')}: {formatMXN(restockPreview.newWAC)}/{getUnitName(restocking.base_unit_key)}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="mt-3">
              <label className="text-xs text-slate-400 block mb-1">Nota (opcional)</label>
              <input value={restockNote} onChange={e => setRestockNote(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                placeholder="ej. Pedido de proveedor" />
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setRestocking(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleRestock} disabled={saving}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Guardando…' : 'Registrar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Adjust Modal ───────────────────────────────────────────────────── */}
      {adjusting && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600">
            <h2 className="font-bold mb-1">{t('inventory.adjust')}</h2>
            <p className="text-slate-400 text-sm mb-4">
              {adjusting.name} · {fmtQty(adjusting.stock_quantity)} {getUnitName(adjusting.base_unit_key)}
            </p>

            <div className="mb-3">
              <label className="text-xs text-slate-400 block mb-1">Tipo de ajuste</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { value: 'MANUAL_ADJUSTMENT', label: t('inventory.manualAdj'),   color: 'sky' },
                  { value: 'WASTE',              label: t('inventory.waste'),        color: 'red' },
                  { value: 'COUNT_ADJUSTMENT',   label: t('inventory.physicalCount'), color: 'violet' },
                ].map(({ value, label, color }) => (
                  <button key={value} onClick={() => setAdjustType(value)}
                    className={`py-2 px-1 rounded-lg text-xs font-semibold border transition-colors ${
                      adjustType === value
                        ? `bg-${color}-700 border-${color}-600 text-white`
                        : 'bg-slate-700 border-slate-600 text-slate-400'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {adjustType === 'MANUAL_ADJUSTMENT' && (
              <div className="mb-3">
                <label className="text-xs text-slate-400 block mb-1">Cambio (+ o -)</label>
                <input type="number" step="any" value={adjustDelta} onChange={e => setAdjustDelta(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder={`+10 o -5 ${getUnitName(adjusting.base_unit_key)}`} autoFocus />
              </div>
            )}

            {adjustType === 'WASTE' && (
              <div className="mb-3">
                <label className="text-xs text-slate-400 block mb-1">
                  Cantidad a dar de baja ({getUnitName(adjusting.base_unit_key)})
                </label>
                <input type="number" min={0.01} step="any" value={adjustWaste}
                  onChange={e => setAdjustWaste(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="ej. 1" autoFocus />
              </div>
            )}

            {adjustType === 'COUNT_ADJUSTMENT' && (
              <div className="mb-3">
                <label className="text-xs text-slate-400 block mb-1">
                  Cantidad contada ({getUnitName(adjusting.base_unit_key)})
                </label>
                <input type="number" min={0} step="any" value={adjustCounted}
                  onChange={e => setAdjustCounted(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  autoFocus />
                {adjustCounted !== '' && (
                  <p className="text-xs mt-1">
                    Diferencia:{' '}
                    <span className={parseFloat(adjustCounted) - adjusting.stock_quantity >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {parseFloat(adjustCounted) - adjusting.stock_quantity >= 0 ? '+' : ''}
                      {fmtQty(parseFloat(adjustCounted) - adjusting.stock_quantity)} {getUnitName(adjusting.base_unit_key)}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="mb-4">
              <label className="text-xs text-slate-400 block mb-1">Motivo *</label>
              <input value={adjustReason} onChange={e => setAdjustReason(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                placeholder="ej. Derrame, corrección de conteo…" />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setAdjusting(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleAdjust} disabled={!adjustReason.trim() || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Open Bottle Modal ─────────────────────────────────────────────── */}
      {openingBottle && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-amber-700">
            <h2 className="font-bold mb-1 text-amber-300">🍾 Abrir Botella</h2>
            <p className="text-slate-300 mb-2">
              ¿Abrir <span className="font-bold text-white">{openingBottle.name}</span>?
            </p>
            <p className="text-sm text-slate-400 mb-5">
              Consume 1 botella sellada y añade{' '}
              <span className="text-amber-300 font-bold">{openingBottle.shots_per_bottle} copas</span> al inventario.
              Botellas restantes: <span className="font-bold text-white">{fmtQty(openingBottle.stock_quantity)}</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => setOpeningBottle(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleOpenBottle} disabled={saving || openingBottle.stock_quantity < 1}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg font-bold disabled:opacity-50 text-slate-900">
                Abrir Botella
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Open Box Modal ────────────────────────────────────────────────── */}
      {openingBox && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-orange-700">
            <h2 className="font-bold mb-1 text-orange-300">🚬 Abrir Caja</h2>
            <p className="text-slate-300 mb-2">
              ¿Abrir <span className="font-bold text-white">{openingBox.name}</span>?
            </p>
            <p className="text-sm text-slate-400 mb-5">
              Consume 1 caja y añade{' '}
              <span className="text-orange-300 font-bold">{openingBox.shots_per_bottle} cigarros</span>.
              Cajas restantes: <span className="font-bold text-white">{fmtQty(openingBox.stock_quantity)}</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => setOpeningBox(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleOpenBox} disabled={saving || openingBox.stock_quantity < 1}
                className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg font-bold disabled:opacity-50">
                Abrir Caja
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Item Modal ────────────────────────────────────────────────── */}
      {showNew && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600 my-4">
            <h2 className="font-bold mb-4">Agregar Artículo de Inventario</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Nombre *</label>
                <input value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="ej. Corona Botella" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">SKU</label>
                  <input value={newItem.sku} onChange={e => setNewItem({ ...newItem, sku: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                    placeholder="opcional" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.supplier')}</label>
                  <input value={newItem.supplier} onChange={e => setNewItem({ ...newItem, supplier: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                    placeholder="opcional" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Categoría</label>
                  <select value={newItem.category} onChange={e => setNewItem({ ...newItem, category: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['beer','spirit','mixer','food','cigarette','other'].map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]?.replace(/^.+ /, '') ?? c}</option>)}
                  </select>
                </div>
                <UnitSelect label={`${t('inventory.baseUnit')} *`} value={newItem.base_unit_key}
                  onChange={v => setNewItem({ ...newItem, base_unit_key: v })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Cant. Inicial</label>
                  <input type="number" min={0} step="any" value={newItem.stock_quantity}
                    onChange={e => setNewItem({ ...newItem, stock_quantity: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Umbral Stock Bajo</label>
                  <input type="number" min={0} step="any" value={newItem.low_stock_threshold}
                    onChange={e => setNewItem({ ...newItem, low_stock_threshold: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">{t('inventory.initialCost')}</label>
                <input type="number" min={0} step="0.01" value={newItem.initial_cost_pesos}
                  onChange={e => setNewItem({ ...newItem, initial_cost_pesos: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="ej. 25.50 (por unidad base)" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <UnitSelect label={t('inventory.purchaseUnit')} value={newItem.purchase_unit_key}
                  onChange={v => setNewItem({ ...newItem, purchase_unit_key: v })} />
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.packSize')}</label>
                  <input type="number" min={0.0001} step="any" value={newItem.purchase_pack_size}
                    onChange={e => setNewItem({ ...newItem, purchase_pack_size: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                    placeholder="ej. 12 (botellas/caja)" />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Tipo de artículo</label>
                <select value={newItem.item_type} onChange={e => setNewItem({ ...newItem, item_type: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                  <option value="STANDARD">Estándar</option>
                  <option value="BOTTLE">Botella (licor)</option>
                  <option value="CIG_BOX">Caja de cigarros</option>
                  <option value="CIG_SINGLE">Cigarro individual</option>
                </select>
              </div>
              {(newItem.item_type === 'BOTTLE' || newItem.item_type === 'CIG_BOX') && (
                <>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      {newItem.item_type === 'CIG_BOX' ? 'Cigarros por caja' : 'Shots por botella'}
                    </label>
                    <input type="number" min={1} value={newItem.shots_per_bottle}
                      onChange={e => setNewItem({ ...newItem, shots_per_bottle: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                      placeholder={newItem.item_type === 'CIG_BOX' ? '20' : '15'} />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      {newItem.item_type === 'CIG_BOX' ? 'Artículo individual que produce' : 'Copa/Shot que produce'}
                    </label>
                    <select value={newItem.yields_item_id} onChange={e => setNewItem({ ...newItem, yields_item_id: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                      <option value="">— Sin vincular —</option>
                      {items.filter(i =>
                        newItem.item_type === 'CIG_BOX' ? i.item_type === 'CIG_SINGLE' : i.item_type === 'STANDARD'
                      ).map(i => <option key={i.id} value={i.id}>{i.name} ({getUnitName(i.base_unit_key)})</option>)}
                    </select>
                  </div>
                </>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowNew(false); setNewItem({ ...BLANK_NEW }) }}
                className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleCreate} disabled={!newItem.name.trim() || !newItem.base_unit_key || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Agregar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Item Modal ───────────────────────────────────────────────── */}
      {editing && editForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-sky-700 my-4">
            <h2 className="font-bold mb-1 text-sky-300">✏️ Editar Artículo</h2>
            <p className="text-xs text-slate-400 mb-4">
              WAC actual: <span className="text-white">{formatMXN(editing.unit_cost_cents)}/{getUnitName(editing.base_unit_key)}</span>
              {' '}· Para actualizar el costo, usa Reabastecer.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Nombre *</label>
                <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">SKU</label>
                  <input value={editForm.sku} onChange={e => setEditForm({ ...editForm, sku: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.supplier')}</label>
                  <input value={editForm.supplier} onChange={e => setEditForm({ ...editForm, supplier: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Categoría</label>
                  <select value={editForm.category} onChange={e => setEditForm({ ...editForm, category: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                    {['beer','spirit','mixer','food','cigarette','other'].map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]?.replace(/^.+ /,'') ?? c}</option>)}
                  </select>
                </div>
                <UnitSelect label={t('inventory.baseUnit')} value={editForm.base_unit_key}
                  onChange={v => setEditForm({ ...editForm, base_unit_key: v })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Umbral Stock Bajo</label>
                  <input type="number" min={0} step="any" value={editForm.low_stock_threshold}
                    onChange={e => setEditForm({ ...editForm, low_stock_threshold: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.packSize')}</label>
                  <input type="number" min={0.0001} step="any" value={editForm.purchase_pack_size}
                    onChange={e => setEditForm({ ...editForm, purchase_pack_size: e.target.value })}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                </div>
              </div>
              <UnitSelect label={t('inventory.purchaseUnit')} value={editForm.purchase_unit_key}
                onChange={v => setEditForm({ ...editForm, purchase_unit_key: v })} />
              <div>
                <label className="text-xs text-slate-400 block mb-1">Tipo de artículo</label>
                <select value={editForm.item_type} onChange={e => setEditForm({ ...editForm, item_type: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                  <option value="STANDARD">Estándar</option>
                  <option value="BOTTLE">Botella (licor)</option>
                  <option value="CIG_BOX">Caja de cigarros</option>
                  <option value="CIG_SINGLE">Cigarro individual</option>
                </select>
              </div>
              {(editForm.item_type === 'BOTTLE' || editForm.item_type === 'CIG_BOX') && (
                <>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      {editForm.item_type === 'CIG_BOX' ? 'Cigarros por caja' : 'Shots por botella'}
                    </label>
                    <input type="number" min={1} value={editForm.shots_per_bottle}
                      onChange={e => setEditForm({ ...editForm, shots_per_bottle: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      {editForm.item_type === 'CIG_BOX' ? 'Artículo individual' : 'Copa/Shot producido'}
                    </label>
                    <select value={editForm.yields_item_id} onChange={e => setEditForm({ ...editForm, yields_item_id: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                      <option value="">— Sin vincular —</option>
                      {items.filter(i =>
                        editForm.item_type === 'CIG_BOX' ? i.item_type === 'CIG_SINGLE' : i.item_type === 'STANDARD' && i.id !== editing.id
                      ).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                  </div>
                </>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setEditing(null)} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              {isAdmin && (
                <button onClick={() => { setEditing(null); handleDelete(editing!) }}
                  className="py-2 px-3 bg-red-900 hover:bg-red-700 text-red-300 rounded-lg text-sm">🗑</button>
              )}
              <button onClick={handleEdit} disabled={!editForm.name.trim() || saving}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold disabled:opacity-50">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Movements Modal ───────────────────────────────────────────────── */}
      {viewingMovements && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-2xl border border-slate-600 flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <div>
                <h2 className="font-bold">📋 {t('inventory.movements')}: {viewingMovements.name}</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Stock actual: {fmtQty(viewingMovements.stock_quantity)} {getUnitName(viewingMovements.base_unit_key)}
                  {viewingMovements.unit_cost_cents > 0 && ` · WAC: ${formatMXN(viewingMovements.unit_cost_cents)}`}
                </p>
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
                      <th className="text-right pb-2 pr-2">{t('inventory.balance')}</th>
                      <th className="text-right pb-2 pr-2">Costo/u</th>
                      <th className="text-left pb-2 pr-2">Usuario</th>
                      <th className="text-left pb-2">Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(movements as any[]).map((m: any) => {
                      const pos = m.quantity_delta > 0
                      const unitLabel = getUnitName(viewingMovements.base_unit_key)
                      const evLabel = (t as any)(`inventory.eventType.${m.event_type}`, { defaultValue: m.event_type })
                      return (
                        <tr key={m.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                          <td className="py-2 text-xs text-slate-400 whitespace-nowrap pr-2">
                            {new Date(m.created_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}
                          </td>
                          <td className={`py-2 text-xs font-medium whitespace-nowrap pr-2 ${EVENT_TYPE_COLORS[m.event_type] ?? 'text-slate-300'}`}>
                            {evLabel}
                          </td>
                          <td className={`py-2 text-right font-mono font-bold pr-2 text-xs ${pos ? 'text-green-400' : 'text-red-400'}`}>
                            {pos ? '+' : ''}{fmtQty(m.quantity_delta)} {unitLabel}
                          </td>
                          <td className="py-2 text-right font-mono text-slate-200 text-xs pr-2">
                            {m.quantity_after != null ? `${fmtQty(m.quantity_after)} ${unitLabel}` : '—'}
                          </td>
                          <td className="py-2 text-right text-xs text-slate-400 pr-2">
                            {m.unit_cost_cents != null ? formatMXN(m.unit_cost_cents) : '—'}
                          </td>
                          <td className="py-2 text-xs text-slate-400 whitespace-nowrap pr-2">
                            {m.performer_name ?? '—'}
                          </td>
                          <td className="py-2 text-xs text-slate-400 truncate max-w-[120px]">
                            {m.reason || (m.reference_id ? `Ticket …${m.reference_id.slice(-6)}` : '—')}
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
                <span className="text-white font-semibold">{addToMenu.name}</span>
                {' '}— al vender se descuenta 1 {getUnitName(addToMenu.base_unit_key)}
              </p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Categoría del menú *</label>
                <select value={menuForm.category_id} onChange={e => setMenuForm({ ...menuForm, category_id: e.target.value })}
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
                  <span className="text-slate-400 text-sm">{formatMXN(menuForm.price_cents)}</span>
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
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300">Cancelar</button>
              <button onClick={handleAddToMenu} disabled={!menuForm.category_id || menuForm.price_cents <= 0 || saving}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-bold disabled:opacity-50">
                {saving ? 'Agregando…' : '✅ Agregar al Menú'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Unit Catalog Modal (Admin) ────────────────────────────────────── */}
      {showCatalog && <UnitCatalogModal onClose={() => setShowCatalog(false)} isAdmin={isAdmin} units={units} getUnitName={getUnitName} />}
    </div>
  )
}

// ── Unit Catalog Modal ────────────────────────────────────────────────────────

function UnitCatalogModal({ onClose, isAdmin, units, getUnitName }: {
  onClose: () => void
  isAdmin: boolean
  units: any[]
  getUnitName: (key: string) => string
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [dirtyRows, setDirtyRows] = useState<Record<string, { name_es: string; name_en: string; active: boolean }>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newEs, setNewEs] = useState('')
  const [newEn, setNewEn] = useState('')
  const [adding, setAdding] = useState(false)

  const getRow = (u: any) => dirtyRows[u.key] ?? { name_es: u.name_es, name_en: u.name_en, active: u.active }
  const isDirty = (u: any) => !!dirtyRows[u.key]

  const patch = (key: string, field: string, value: any) => {
    const base = units.find(u => u.key === key)
    setDirtyRows(prev => {
      const current = prev[key] ?? { name_es: base?.name_es ?? '', name_en: base?.name_en ?? '', active: base?.active ?? true }
      return { ...prev, [key]: { ...current, [field]: value } }
    })
  }

  const saveRow = async (key: string) => {
    const data = dirtyRows[key]
    if (!data) return
    setSaving(key)
    try {
      await client.patch(`/inventory/units/${key}`, data)
      qc.invalidateQueries({ queryKey: ['unit-catalog'] })
      setDirtyRows(prev => { const n = { ...prev }; delete n[key]; return n })
      toast.success('Unidad actualizada')
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error') }
    finally { setSaving(null) }
  }

  const addUnit = async () => {
    if (!newKey.trim() || !newEs.trim() || !newEn.trim()) return toast.error('Todos los campos son requeridos')
    setAdding(true)
    try {
      await client.post('/inventory/units', { key: newKey.trim().toLowerCase(), name_es: newEs.trim(), name_en: newEn.trim() })
      qc.invalidateQueries({ queryKey: ['unit-catalog'] })
      toast.success('Unidad creada')
      setShowAdd(false); setNewKey(''); setNewEs(''); setNewEn('')
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error') }
    finally { setAdding(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-600 shadow-xl flex flex-col max-h-[85vh]">
        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-bold">⚙️ {t('inventory.unitCatalog')}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-2">
          <div className="grid grid-cols-[90px_1fr_1fr_80px_40px] gap-2 text-xs text-slate-400 px-2 pb-1">
            <span>Clave</span><span>Español</span><span>English</span><span>Activo</span><span></span>
          </div>
          {units.map(u => {
            const row = getRow(u)
            return (
              <div key={u.key} className={`grid grid-cols-[90px_1fr_1fr_80px_40px] gap-2 items-center rounded-lg px-2 py-1.5 ${isDirty(u) ? 'bg-slate-700/70' : 'bg-slate-700/30'}`}>
                <span className="font-mono text-xs text-slate-300">{u.key}</span>
                {isAdmin ? (
                  <>
                    <input value={row.name_es} onChange={e => patch(u.key, 'name_es', e.target.value)}
                      className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm w-full" />
                    <input value={row.name_en} onChange={e => patch(u.key, 'name_en', e.target.value)}
                      className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm w-full" />
                    <div className="flex items-center justify-center">
                      <button onClick={() => patch(u.key, 'active', !row.active)}
                        className={`px-3 py-1 rounded text-xs font-semibold ${row.active ? 'bg-emerald-800 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>
                        {row.active ? 'Activo' : 'Inactivo'}
                      </button>
                    </div>
                    <button disabled={!isDirty(u) || saving === u.key} onClick={() => saveRow(u.key)}
                      className="bg-sky-700 hover:bg-sky-600 rounded px-2 py-1 text-xs font-bold disabled:opacity-30">
                      {saving === u.key ? '…' : '✓'}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-sm text-slate-300">{u.name_es}</span>
                    <span className="text-sm text-slate-300">{u.name_en}</span>
                    <span className={`text-xs text-center ${u.active ? 'text-emerald-400' : 'text-slate-500'}`}>
                      {u.active ? 'Activo' : 'Inactivo'}
                    </span>
                    <span />
                  </>
                )}
              </div>
            )
          })}

          {isAdmin && (
            showAdd ? (
              <div className="bg-slate-700/50 rounded-xl border border-slate-600 p-4 space-y-3 mt-2">
                <p className="text-xs text-slate-400 font-semibold">Nueva Unidad</p>
                <div className="grid grid-cols-3 gap-2">
                  <input value={newKey} onChange={e => setNewKey(e.target.value)}
                    placeholder="clave (ej. frasco)" className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm" />
                  <input value={newEs} onChange={e => setNewEs(e.target.value)}
                    placeholder="Español" className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm" />
                  <input value={newEn} onChange={e => setNewEn(e.target.value)}
                    placeholder="English" className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setShowAdd(false); setNewKey(''); setNewEs(''); setNewEn('') }}
                    className="flex-1 py-1.5 border border-slate-600 rounded text-sm">Cancelar</button>
                  <button onClick={addUnit} disabled={adding}
                    className="flex-1 py-1.5 bg-sky-600 hover:bg-sky-500 rounded text-sm font-bold disabled:opacity-50">
                    {adding ? 'Creando…' : 'Crear'}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowAdd(true)}
                className="w-full py-2 border border-dashed border-slate-600 rounded-xl text-slate-400 hover:text-white hover:border-slate-400 text-sm mt-2">
                + Nueva Unidad
              </button>
            )
          )}
        </div>

        <div className="p-4 border-t border-slate-700">
          <button onClick={onClose} className="w-full py-2 border border-slate-600 rounded-lg text-sm">Cerrar</button>
        </div>
      </div>
    </div>
  )
}
