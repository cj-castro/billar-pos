import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'
import { useSocket } from '../../hooks/useSocket'
import { useAuthStore } from '../../stores/authStore'
import { useUnitCatalog } from '../../hooks/useUnitCatalog'
import { formatMXN, formatUnitCost } from '../../utils/money'
import { PesoInput } from '../../components/PesoInput'
import { CostEntry, packMissing } from '../../components/CostEntry'
import PortionDialog from '../../components/PortionDialog'

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
  purchase_cost_cents: number | null
  shots_per_bottle: number | null
  yields_item_id: string | null
  /** open-spirit item (ml): the standard pour = "1 shot" (batch E2) */
  pour_ml: number | null
  /** bottle: its size in ml */
  bottle_ml: number | null
  /** open spirit: bottles open right now */
  open_bottles: number | null
  /** pack portioned in house from this raw item (E8) */
  portion_source_id: string | null
  portion_size: number | null
  stock_nature?: string
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
  // exact, like the backend (unit cost carries 4 decimals of a centavo since 044)
  return (oldQty * oldWacCents + deltaQty * incomingCostCents) / (oldQty + deltaQty)
}

function fmtQty(qty: number): string {
  const n = parseFloat(qty.toFixed(4))
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2).replace(/\.?0+$/, '')
}

// ── SupplierSelect: dropdown + inline add-new ────────────────────────────────

function SupplierSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const { data: suppliers = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['suppliers'],
    queryFn: () => client.get('/suppliers').then(r => r.data),
    staleTime: 60_000,
  })

  async function handleSave() {
    const name = newName.trim()
    if (!name) return
    try {
      await client.post('/suppliers', { name })
      await qc.invalidateQueries({ queryKey: ['suppliers'] })
      onChange(name)
      setAdding(false)
      setNewName('')
    } catch {
      // show nothing — user can retry
    }
  }

  return (
    <div>
      <select
        value={adding ? '__add__' : (value || '')}
        onChange={e => {
          if (e.target.value === '__add__') { setAdding(true); setNewName('') }
          else { onChange(e.target.value); setAdding(false) }
        }}
        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
      >
        <option value="">— sin proveedor —</option>
        {suppliers.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
        <option value="__add__">✚ Agregar proveedor...</option>
      </select>
      {adding && (
        <div className="flex gap-1 mt-1">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setAdding(false); setNewName('') } }}
            placeholder="Nombre del proveedor"
            autoFocus
            className="flex-1 bg-slate-700 border border-blue-500 rounded-lg px-3 py-1.5 text-sm"
          />
          <button onClick={handleSave} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-semibold">✓</button>
          <button onClick={() => { setAdding(false); setNewName('') }} className="px-3 py-1 bg-slate-600 hover:bg-slate-500 rounded-lg text-xs">✕</button>
        </div>
      )}
    </div>
  )
}

// ── Blank form states ─────────────────────────────────────────────────────────

const BLANK_NEW = {
  name: '', sku: '', supplier: '', category: 'beer', item_type: 'STANDARD',
  base_unit_key: 'botella', stock_quantity: '', low_stock_threshold: '6',
  initial_cost_pesos: '', purchase_unit_key: '', purchase_pack_size: '1',
  shots_per_bottle: '', yields_item_id: '', bottle_ml: '', pour_ml: '50',
}

/** Pack size when the unit pair changes: same unit -> 1; a different unit ->
 *  keep a real count, otherwise empty so it must be typed (never a silent 1). */
const packFor = (base: string, purchase: string, current: string) =>
  !purchase || purchase === base ? '1' : (parseFloat(current) > 1 ? current : '')

/** Whole shots in an amount of ml (floor: a 20 ml remainder is not a shot). */
const shotsIn = (ml: number, pour: number | null | undefined) =>
  pour && pour > 0 ? Math.floor(ml / pour + 1e-9) : 0

const WEIGHT_UNITS = ['kilogramo', 'gramo', 'litro', 'ml']
const PACK_UNITS = ['pieza', 'paquete', 'porcion']

/** Raw items a pack can be cut from: stocked by weight / volume; same category first. */
function rawCandidates(items: InventoryItem[], selfId: string | undefined, category: string) {
  return items
    .filter(i => WEIGHT_UNITS.includes(i.base_unit_key) && !i.portion_source_id && i.id !== selfId
                 && i.is_active && i.stock_nature !== 'DERIVED')
    .sort((a, b) => (a.category === category ? 0 : 1) - (b.category === category ? 0 : 1) || a.name.localeCompare(b.name))
}

/**
 * On a RAW item (kg / g / l / ml): the packs portioned from it (batch E8).
 * Linking happens on the pack (portion_source_id + weight), right away.
 */
function RawPacksSection({ raw, items, onChanged }: {
  raw: InventoryItem; items: InventoryItem[]; onChanged: () => void
}) {
  const [pick, setPick] = useState('')
  const [size, setSize] = useState('')
  const [busy, setBusy] = useState(false)
  const g = ['litro', 'ml'].includes(raw.base_unit_key) ? 'ml' : 'g'
  const linked = items.filter(i => i.portion_source_id === raw.id && i.is_active)
  const candidates = items
    .filter(i => PACK_UNITS.includes(i.base_unit_key) && !i.portion_source_id && i.is_active
                 && i.item_type === 'STANDARD' && i.id !== raw.id)
    .sort((a, b) => (a.category === raw.category ? 0 : 1) - (b.category === raw.category ? 0 : 1) || a.name.localeCompare(b.name))
  const link = async (packId: string, grams: number | null) => {
    setBusy(true)
    try {
      await client.patch(`/inventory/${packId}`, grams ? { portion_source_id: raw.id, portion_size: grams }
                                                       : { portion_source_id: null })
      toast.success(grams ? 'Paquete ligado' : 'Paquete desligado')
      setPick(''); setSize('')
      onChanged()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo')
    } finally { setBusy(false) }
  }
  return (
    <div className="rounded-xl border border-orange-800 bg-orange-950/20 p-3 space-y-2">
      <div className="text-xs font-semibold text-orange-200">🔪 Paquetes que salen de este producto</div>
      {linked.length === 0 && <div className="text-xs text-slate-400">Ninguno todavía. Agrega los paquetes que porcionas (p. ej. Alitas 300gr, 300 {g}).</div>}
      {linked.map(p => (
        <div key={p.id} className="flex items-center justify-between text-sm">
          <span>{p.name} <span className="text-slate-400">· {p.portion_size} {g}</span></span>
          <button type="button" disabled={busy} onClick={() => link(p.id, null)}
            className="text-xs text-slate-400 hover:text-red-300">Quitar</button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <select value={pick} onChange={e => setPick(e.target.value)}
          className="flex-1 min-w-0 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-sm text-white">
          <option value="">— elegir paquete —</option>
          {candidates.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <input type="number" min={1} value={size} onChange={e => setSize(e.target.value)} placeholder={g}
          className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-sm" />
        <button type="button" disabled={busy || !pick || !(parseFloat(size) > 0)} onClick={() => link(pick, parseFloat(size))}
          className="px-3 py-1.5 rounded-lg bg-orange-700 hover:bg-orange-600 text-sm font-semibold disabled:opacity-40">Agregar</button>
      </div>
      <p className="text-[11px] text-slate-500">El paquete se cuenta en paquetes y ya no se reabastece: sale de 🔪 Porcionar.</p>
    </div>
  )
}

/** Bottle size + standard pour (batch E2: opened spirits are tracked in ml). */
function BottleSizeFields({ bottle, pour, onChange }: {
  bottle: string; pour: string; onChange: (bottle: string, pour: string) => void
}) {
  const b = parseFloat(bottle), p = parseFloat(pour)
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-400 block">Tamaño de botella (ml)
          <input type="number" min={50} step={1} value={bottle} placeholder="750"
            onChange={e => onChange(e.target.value, pour)}
            className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
        </label>
        <label className="text-xs text-slate-400 block">Shot estándar (ml)
          <input type="number" min={5} step={1} value={pour} placeholder="50"
            onChange={e => onChange(bottle, e.target.value)}
            className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
        </label>
      </div>
      <p className="text-[11px] text-slate-500 mt-1">
        {b > 0 && p > 0
          ? <>Rinde <span className="text-amber-300 font-semibold">{shotsIn(b, p)} shots</span> por botella. Las recetas pueden usar otras cantidades (doble, un chorrito de 20 ml…).</>
          : 'Con el tamaño podrás abrir la botella y vender shots y bebidas preparadas. Vacío = solo se vende la botella cerrada.'}
      </p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const socket = useSocket()
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'ADMIN'
  const { units, getUnitName, qtyStep } = useUnitCatalog()

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
  const [portioning, setPortioning] = useState<InventoryItem | null>(null)   // batch E8
  const [openingBox, setOpeningBox] = useState<InventoryItem | null>(null)
  // Set when the server answers 409 STILL_HAS_UNITS (our list was stale);
  // the next click then confirms.
  const [openStillMsg, setOpenStillMsg] = useState<string | null>(null)
  // Sizes vary between purchases: ask for THIS bottle's size, pre-filled.
  const [openSize, setOpenSize] = useState('')
  const [viewingMovements, setViewingMovements] = useState<InventoryItem | null>(null)
  const [showCatalog, setShowCatalog] = useState(false)
  const [showSupplierCatalog, setShowSupplierCatalog] = useState(false)
  const [addToMenu, setAddToMenu] = useState<InventoryItem | null>(null)
  const [menuForm, setMenuForm] = useState({ category_id: '', price_cents: 0, requires_flavor: false })

  // restock form
  const [restockPurchaseQty, setRestockPurchaseQty] = useState('')
  const [restockCostPesos, setRestockCostPesos] = useState('')
  const [restockPackOverride, setRestockPackOverride] = useState('')
  const [restockPortionCount, setRestockPortionCount] = useState('')
  const [restockTotalCostPesos, setRestockTotalCostPesos] = useState('')
  const [restockNote, setRestockNote] = useState('')
  // Batch E4: every purchase carries its price. Owner-only exception for goods
  // that came free; a price far from the last one asks before saving.
  const [restockFree, setRestockFree] = useState(false)
  const [priceCheckMsg, setPriceCheckMsg] = useState<string | null>(null)

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
    if (showCatalog)         { setShowCatalog(false); return }
    if (showSupplierCatalog) { setShowSupplierCatalog(false); return }
    if (showNew)             { setShowNew(false); return }
    if (addToMenu)           { setAddToMenu(null); return }
  }, showNew || !!editing || !!restocking || !!adjusting || !!openingBottle || !!openingBox || !!viewingMovements || showCatalog || showSupplierCatalog || !!addToMenu)

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

  // Shots / loose cigarettes are not managed on their own: they only exist by
  // opening their bottle / box. They are folded into the parent's row instead
  // of getting a row (and a Reabastecer button) of their own.
  const childOf = useMemo(() => {
    const byId = new Map(items.map(i => [i.id, i]))
    const m = new Map<string, InventoryItem>()          // parent id -> child
    for (const i of items) {
      if ((i.item_type === 'BOTTLE' || i.item_type === 'CIG_BOX') && i.shots_per_bottle && i.yields_item_id) {
        const c = byId.get(i.yields_item_id)
        if (c) m.set(i.id, c)
      }
    }
    return m
  }, [items])
  const childIds = useMemo(() => new Set([...childOf.values()].map(c => c.id)), [childOf])
  const isOpenedChild = (item: InventoryItem | null) => !!item && childIds.has(item.id)

  const filtered = useMemo(() => {
    let list = items.filter(i => !childIds.has(i.id))
    if (tab !== 'all') list = list.filter(i => i.category === tab)
    if (lowStockOnly)  list = list.filter(i => i.is_low || !!childOf.get(i.id)?.is_low)
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      const matches = (i: InventoryItem) =>
        i.name.toLowerCase().includes(q) ||
        (i.sku ?? '').toLowerCase().includes(q) ||
        (i.supplier ?? '').toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q)
      // Searching for a shot finds its bottle.
      list = list.filter(i => matches(i) || (childOf.has(i.id) && matches(childOf.get(i.id)!)))
    }
    return list
  }, [items, tab, lowStockOnly, debouncedSearch, childOf, childIds])

  // ── Restock WAC preview (client-side) ─────────────────────────────────────

  const restockPreview = useMemo(() => {
    if (!restocking) return null
    const isFood = restocking.category === 'food'
    if (isFood) {
      const portions = parseFloat(restockPortionCount)
      const totalCentavos = Math.round(parseFloat(restockTotalCostPesos || '0') * 100)
      if (!portions || portions <= 0) return null
      const costPerPortion = totalCentavos / portions
      const newWAC = computeWAC(restocking.stock_quantity, restocking.unit_cost_cents, portions, costPerPortion)
      return { delta: portions, costPerBase: costPerPortion, newWAC }
    } else {
      const purchaseQty = parseFloat(restockPurchaseQty)
      const costCents = Math.round(parseFloat(restockCostPesos || '0') * 100)
      const packSize = parseFloat(restockPackOverride || String(restocking.purchase_pack_size)) || 1
      if (!purchaseQty || purchaseQty <= 0) return null
      const delta = purchaseQty * packSize
      const costPerBase = costCents / packSize
      const newWAC = computeWAC(restocking.stock_quantity, restocking.unit_cost_cents, delta, costPerBase)
      return { delta, costPerBase, newWAC }
    }
  }, [restocking, restockPurchaseQty, restockCostPesos, restockPackOverride, restockPortionCount, restockTotalCostPesos])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!newItem.name.trim()) return toast.error('Se requiere un nombre')
    if (!newItem.base_unit_key) return toast.error('Se requiere unidad base')
    if (packMissing(newItem.base_unit_key, newItem.purchase_unit_key, newItem.purchase_pack_size))
      return toast.error(`¿Cuántas ${getUnitName(newItem.base_unit_key).toLowerCase()} trae la ${getUnitName(newItem.purchase_unit_key).toLowerCase()}?`)
    if (parseFloat(newItem.stock_quantity || '0') > 0 && !(parseFloat(newItem.initial_cost_pesos || '0') > 0))
      return toast.error('Con existencia inicial, escribe cuánto costó')
    setSaving(true)
    try {
      const payload: any = {
        name: newItem.name.trim(),
        category: newItem.category,
        item_type: newItem.item_type,
        base_unit_key: newItem.base_unit_key,
        stock_quantity: parseFloat(newItem.stock_quantity as any) || 0,
        low_stock_threshold: parseFloat(newItem.low_stock_threshold as any) || 0,
        // Price of ONE purchase unit (a case, a 3,780 ml bottle). The backend
        // divides by units-per-case, exactly. Without a purchase unit it is the
        // price of one base unit.
        ...(parseFloat(newItem.initial_cost_pesos) > 0
          ? { purchase_cost_cents: Math.round(parseFloat(newItem.initial_cost_pesos) * 100) } : {}),
      }
      if (newItem.sku.trim())      payload.sku = newItem.sku.trim()
      if (newItem.supplier.trim()) payload.supplier = newItem.supplier.trim()
      if (newItem.purchase_unit_key) payload.purchase_unit_key = newItem.purchase_unit_key
      if (newItem.purchase_pack_size) payload.purchase_pack_size = parseFloat(newItem.purchase_pack_size) || 1
      if (newItem.item_type === 'BOTTLE') {
        if (newItem.bottle_ml) { payload.bottle_ml = parseInt(newItem.bottle_ml); payload.pour_ml = parseFloat(newItem.pour_ml) || 50 }
      } else if (newItem.shots_per_bottle) payload.shots_per_bottle = parseInt(newItem.shots_per_bottle)
      if (newItem.yields_item_id)   payload.yields_item_id = newItem.yields_item_id
      await client.post('/inventory', payload)
      toast.success(payload.bottle_ml
        ? `${newItem.name} añadido — se puede abrir (${shotsIn(payload.bottle_ml, payload.pour_ml)} shots de ${payload.pour_ml} ml)`
        : payload.shots_per_bottle ? `${newItem.name} añadido — se puede abrir (${payload.shots_per_bottle} por caja)`
        : `${newItem.name} añadido`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setShowNew(false); setNewItem({ ...BLANK_NEW })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al crear')
    } finally { setSaving(false) }
  }

  const handleEdit = async () => {
    if (!editForm.name.trim()) return toast.error('Se requiere un nombre')
    if (packMissing(editForm.base_unit_key, editForm.purchase_unit_key, editForm.purchase_pack_size))
      return toast.error(`¿Cuántas ${getUnitName(editForm.base_unit_key).toLowerCase()} trae la ${getUnitName(editForm.purchase_unit_key).toLowerCase()}? (más de 1)`)
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
        purchase_cost_cents: editForm.purchase_cost_pesos ? Math.round(parseFloat(editForm.purchase_cost_pesos) * 100) : null,
        yields_item_id: editForm.yields_item_id || null,
        ...((editForm.portion_source_id || editing?.portion_source_id)
          ? { portion_source_id: editForm.portion_source_id || null,
              ...(editForm.portion_source_id ? { portion_size: parseFloat(editForm.portion_size) || null } : {}) }
          : {}),
        ...(editForm.item_type === 'BOTTLE'
          ? { bottle_ml: editForm.bottle_ml ? parseInt(editForm.bottle_ml) : null,
              ...(editForm.bottle_ml ? { pour_ml: parseFloat(editForm.pour_ml) || 50 } : {}) }
          : { shots_per_bottle: editForm.shots_per_bottle ? parseInt(editForm.shots_per_bottle) : null }),
      }
      await client.patch(`/inventory/${editing!.id}`, payload)
      toast.success('Artículo actualizado')
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setEditing(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const handleRestock = async (confirmPrice = false) => {
    if (!restocking) return
    if (restockFree && !restockNote.trim()) { toast.error('Escribe por qué entra sin costo (p. ej. cortesía del proveedor)'); return }
    setSaving(true)
    try {
      const isFood = restocking.category === 'food'
      let payload: any = { reason: restockNote || undefined,
                           ...(restockFree ? { sin_costo: true } : {}),
                           ...(confirmPrice ? { confirm_price: true } : {}) }

      if (isFood) {
        const portions = parseFloat(restockPortionCount)
        if (!portions || portions <= 0) { toast.error('Se requiere cantidad de porciones > 0'); return }
        payload.portion_count = portions
        payload.total_purchase_cost_cents = Math.round(parseFloat(restockTotalCostPesos || '0') * 100)
        if (!restockFree && payload.total_purchase_cost_cents <= 0) { toast.error('Escribe cuánto costó esta compra'); return }
      } else {
        const qty = parseFloat(restockPurchaseQty)
        if (!qty || qty <= 0) { toast.error('Se requiere cantidad > 0'); return }
        const costCents = Math.round(parseFloat(restockCostPesos || '0') * 100)
        if (!restockFree && costCents <= 0) { toast.error('Escribe cuánto costó (precio de la caja o de la pieza)'); return }
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
      setRestockFree(false); setPriceCheckMsg(null)
    } catch (err: any) {
      if (err.response?.status === 409 && err.response?.data?.error === 'PRICE_CHECK') {
        setPriceCheckMsg(err.response.data.message)       // ask, then resend with confirm_price
      } else toast.error(err.response?.data?.message || 'Error al reabastecer')
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

  /** Shots / loose cigarettes still on hand from the item this bottle/box opens into. */
  const remainingFor = (parent: InventoryItem | null): number => {
    if (!parent?.yields_item_id) return 0
    const c = items.find(i => i.id === parent.yields_item_id)
    const left = Number(c?.stock_quantity ?? 0)
    return c?.pour_ml ? shotsIn(left, c.pour_ml) : left   // ml items: whole shots left
  }

  const handleOpenBottle = async () => {
    if (!openingBottle) return
    setSaving(true)
    try {
      const { data } = await client.post(`/inventory/${openingBottle.id}/open-bottle`,
        { confirm_remaining: remainingFor(openingBottle) > 0 || !!openStillMsg,
          ...(openSize ? { size_ml: parseFloat(openSize) } : {}) })
      toast.success(`🍾 +${data?.shots_added ?? openingBottle.shots_per_bottle} shots${data?.ml_added ? ` (${fmtQty(data.ml_added)} ml)` : ''} en ${data?.shots?.name ?? 'inventario'}`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setOpeningBottle(null); setOpenStillMsg(null)
    } catch (err: any) {
      if (err.response?.status === 409 && err.response?.data?.error === 'STILL_HAS_UNITS') {
        setOpenStillMsg(err.response.data.message)
        qc.invalidateQueries({ queryKey: ['inventory'] })
      } else toast.error(err.response?.data?.message || 'Error')
    }
    finally { setSaving(false) }
  }

  const handleOpenBox = async () => {
    if (!openingBox) return
    setSaving(true)
    try {
      await client.post(`/inventory/${openingBox.id}/open-box`,
        { confirm_remaining: remainingFor(openingBox) > 0 || !!openStillMsg })
      toast.success(`🚬 +${openingBox.shots_per_bottle} cigarros disponibles`)
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['open-boxes'] })
      setOpeningBox(null); setOpenStillMsg(null)
    } catch (err: any) {
      if (err.response?.status === 409 && err.response?.data?.error === 'STILL_HAS_UNITS') {
        setOpenStillMsg(err.response.data.message)
        qc.invalidateQueries({ queryKey: ['inventory'] })
      } else toast.error(err.response?.data?.message || 'Error')
    }
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
        // A shot item is stocked in ml: one sale is one pour (50 ml), not 1 ml.
        menu_item_id: res.data.id, inventory_item_id: addToMenu.id,
        quantity: addToMenu.pour_ml || 1, deduction_unit_key: addToMenu.base_unit_key,
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
      bottle_ml: item.bottle_ml ? String(item.bottle_ml) : '',
      portion_source_id: item.portion_source_id ?? '',
      portion_size: item.portion_size ? String(item.portion_size) : '',
      pour_ml: String(items.find(i => i.id === item.yields_item_id)?.pour_ml ?? 50),
      yields_item_id: item.yields_item_id ?? '',
      purchase_cost_pesos: item.purchase_cost_cents ? String((item.purchase_cost_cents / 100).toFixed(2)) : '',
    })
    setEditing(item)
  }

  const openRestock = (item: InventoryItem) => {
    const lastCost = (item as any).purchase_cost_cents
      ? String(((item as any).purchase_cost_cents / 100).toFixed(2))
      : ''
    setRestockPurchaseQty(''); setRestockCostPesos(lastCost)
    setRestockPackOverride(''); setRestockPortionCount('')
    setRestockTotalCostPesos(''); setRestockNote('')
    setRestocking(item)
  }

  const openAdjust = (item: InventoryItem, type?: 'WASTE' | 'COUNT_ADJUSTMENT') => {
    setAdjustType(type ?? (isOpenedChild(item) ? 'WASTE' : 'MANUAL_ADJUSTMENT')); setAdjustDelta('')
    setAdjustCounted(String(item.stock_quantity)); setAdjustWaste('')
    setAdjustReason('')
    setAdjusting(item)
  }

  // ── Unit dropdown helper ───────────────────────────────────────────────────

  // emptyLabel: offer "no unit" as a real choice. Without it an empty value made
  // the browser SHOW the first unit ("Barril") while nothing was selected, so the
  // form looked bought-by-barrel but priced per kg and never asked the pack size.
  const UnitSelect = ({ value, onChange, label, emptyLabel }: { value: string; onChange: (v: string) => void; label: string; emptyLabel?: string }) => (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{label}</label>
      <select value={value ?? ''} onChange={e => onChange(e.target.value)}
        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
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
            <Link to="/manager/bar-count"
              className="bg-amber-800 hover:bg-amber-700 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-100">
              🍾 Conteo de barra
            </Link>
            {isAdmin && (
              <button onClick={() => setShowCatalog(true)}
                className="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-300">
                ⚙️ {t('inventory.unitCatalog')}
              </button>
            )}
            {isAdmin && (
              <button onClick={() => setShowSupplierCatalog(true)}
                className="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-300">
                🏭 Proveedores
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
        <div className="space-y-1.5">
          {filtered.map((item) => {
            const inMenu = (menuItems as any[]).some((m: any) =>
              m.name.toLowerCase() === item.name.toLowerCase()
            )
            const child = childOf.get(item.id) ?? null
            const packsOf = items.filter(i => i.portion_source_id === item.id && i.is_active)
            const rawOf = item.portion_source_id ? items.find(i => i.id === item.portion_source_id) : null
            return (
              <div key={item.id}
                className={`bg-slate-800 rounded-xl px-3 py-2.5 flex items-center gap-3 border ${item.is_low ? 'border-red-700' : 'border-slate-700'}`}>

                {/* Name + meta — grows to fill space */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-semibold text-sm leading-tight">{item.name}</span>
                    {item.is_low && <span className="text-[10px] text-red-400 font-bold bg-red-900/40 px-1.5 py-0.5 rounded">⚠ bajo</span>}
                    {item.item_type === 'BOTTLE' && item.shots_per_bottle && (
                      <span className="text-[10px] text-amber-400">🍾 {item.bottle_ml ? `${fmtQty(item.bottle_ml)} ml · ` : ''}{item.shots_per_bottle} shots</span>
                    )}
                    {item.item_type === 'CIG_BOX' && item.shots_per_bottle && (
                      <span className="text-[10px] text-orange-400">🚬 {item.shots_per_bottle}</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 leading-tight mt-0.5">
                    {getUnitName(item.base_unit_key)} · {CATEGORY_LABELS[item.category]?.replace(/^.+ /, '') ?? item.category}
                    {item.unit_cost_cents > 0 && <span className="ml-2">{formatUnitCost(item.unit_cost_cents)}/{getUnitName(item.base_unit_key).toLowerCase()}</span>}
                  </div>
                  {packsOf.length > 0 && (
                    <div className="mt-1 text-xs text-orange-200/80">
                      ↳ {packsOf.map(p => `${p.name}: ${fmtQty(p.stock_quantity)}`).join(' · ')}
                    </div>
                  )}
                  {rawOf && item.portion_size && (
                    <div className="mt-0.5 text-[11px] text-slate-500">paquete de {fmtQty(item.portion_size)} {['litro', 'ml'].includes(rawOf.base_unit_key) ? 'ml' : 'g'}</div>
                  )}
                  {child && (() => {
                    const isBox = item.item_type === 'CIG_BOX'
                    const noun = isBox ? 'sueltos' : 'shots'
                    const left = Number(child.stock_quantity)
                    const pour = child.pour_ml
                    const shotsLeft = pour ? shotsIn(left, pour) : left
                    const childInMenu = (menuItems as any[]).some((m: any) =>
                      m.name.toLowerCase() === child.name.toLowerCase())
                    return (
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-xs">
                        <span className={left > 0 ? (isBox ? 'text-orange-300' : 'text-amber-300') : 'text-slate-500'}
                          title={child.name}>
                          ↳ {shotsLeft >= 1
                            ? <><span className="font-mono font-bold">{fmtQty(shotsLeft)}</span> {noun} abiertos
                                {pour ? <span className="text-slate-400"> · {fmtQty(left)} ml</span> : null}
                                {child.open_bottles && child.open_bottles > 1
                                  ? <span className="text-slate-400"> · {child.open_bottles} botellas abiertas</span> : null}</>
                            : left > 0 && pour
                              ? <>Quedan {fmtQty(left)} ml (menos de un shot) — usa 🍾 Abrir botella</>
                              : <>Sin {noun} abiertos — usa {isBox ? '🚬 Abrir caja' : '🍾 Abrir botella'}</>}
                        </span>
                        <button onClick={() => openAdjust(child, 'WASTE')} title={`Merma de ${noun} (derrame, rotura)`}
                          className="bg-slate-700 hover:bg-red-800 px-1.5 py-0.5 rounded text-[11px] text-slate-300">Merma</button>
                        <button onClick={() => openAdjust(child, 'COUNT_ADJUSTMENT')} title={`Conteo de ${noun} en la ${isBox ? 'caja' : 'botella'} abierta`}
                          className="bg-slate-700 hover:bg-violet-800 px-1.5 py-0.5 rounded text-[11px] text-slate-300">Conteo</button>
                        <button onClick={() => setViewingMovements(child)} title="Movimientos"
                          className="bg-slate-700 hover:bg-slate-600 px-1.5 py-0.5 rounded text-[11px] text-slate-300">📋</button>
                        <button onClick={() => openEdit(child)} title={`Editar ${child.name}`}
                          className="bg-slate-700 hover:bg-sky-700 px-1.5 py-0.5 rounded text-[11px]">✏️</button>
                        {childInMenu
                          ? <span className="text-[10px] text-emerald-400 font-semibold" title="En el menú">✅</span>
                          : <button onClick={() => { setAddToMenu(child); setMenuForm({ category_id: '', price_cents: 0, requires_flavor: false }) }}
                              title={`Agregar "${child.name}" al menú para poder venderlo`}
                              className="bg-emerald-900/60 hover:bg-emerald-800 px-1.5 py-0.5 rounded text-[11px] text-emerald-200">🍽️ Vender {noun}</button>}
                      </div>
                    )
                  })()}
                </div>

                {/* Stock badge */}
                <div className={`text-right font-mono font-bold text-base leading-tight flex-shrink-0 ${item.is_low ? 'text-red-400' : 'text-white'}`}>
                  {fmtQty(item.stock_quantity)}
                  <div className="text-[10px] font-normal text-slate-400">{getUnitName(item.base_unit_key)}</div>
                </div>

                {/* Action buttons — all horizontal */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {item.item_type === 'BOTTLE' && item.shots_per_bottle && item.yields_item_id && (
                    <button onClick={() => { setOpeningBottle(item); setOpenSize(String(item.bottle_ml ?? 750)) }} title="Abrir botella"
                      className="bg-amber-700 hover:bg-amber-600 px-2 py-1 rounded text-xs font-bold">🍾</button>
                  )}
                  {item.item_type === 'CIG_BOX' && item.shots_per_bottle && item.yields_item_id && (
                    <button onClick={() => setOpeningBox(item)} title="Abrir caja"
                      className="bg-orange-700 hover:bg-orange-600 px-2 py-1 rounded text-xs font-bold">🚬</button>
                  )}
                  {packsOf.length > 0 && (
                    <button onClick={() => setPortioning(item)} title="Porcionar"
                      className="bg-orange-700 hover:bg-orange-600 px-2 py-1 rounded text-xs font-bold whitespace-nowrap">🔪 Porcionar</button>
                  )}
                  {rawOf ? (
                    <span className="text-[11px] text-orange-300 whitespace-nowrap" title={`Se produce porcionando ${rawOf.name}`}>🔪 de {rawOf.name}</span>
                  ) : (
                  <button onClick={() => openRestock(item)}
                    className="bg-emerald-700 hover:bg-emerald-600 px-2.5 py-1 rounded text-xs font-bold text-emerald-100 whitespace-nowrap">
                    📦 Reabastecer
                  </button>
                  )}
                  <button onClick={() => openAdjust(item)} title="Ajustar stock"
                    className="bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded text-xs text-slate-300">
                    ⚡
                  </button>
                  <button onClick={() => openEdit(item)} title="Editar"
                    className="bg-slate-700 hover:bg-sky-700 px-2 py-1 rounded text-xs">✏️</button>
                  <button onClick={() => setViewingMovements(item)} title="Movimientos"
                    className="bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded text-xs text-slate-300">📋</button>
                  {isAdmin && (
                    <button onClick={() => handleDelete(item)} title="Eliminar"
                      className="bg-slate-700 hover:bg-red-800 px-2 py-1 rounded text-xs text-red-400">🗑</button>
                  )}
                  {inMenu
                    ? <span className="text-[10px] text-emerald-400 font-semibold px-1">✅</span>
                    : <button onClick={() => { setAddToMenu(item); setMenuForm({ category_id: '', price_cents: 0, requires_flavor: false }) }}
                        title="Agregar al menú"
                        className="bg-slate-700 hover:bg-emerald-800 px-2 py-1 rounded text-xs">🍽️</button>
                  }
                </div>
              </div>
            )
          })}

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
                  <input type="number" min={qtyStep(restocking.base_unit_key) === 1 ? 1 : 0.01} step={qtyStep(restocking.base_unit_key)} value={restockPortionCount}
                    onChange={e => setRestockPortionCount(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                    placeholder="ej. 45" autoFocus />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('inventory.totalBatchCost')} *</label>
                  <input type="number" min={0} step="0.01" value={restockTotalCostPesos}
                    onChange={e => { setRestockTotalCostPesos(e.target.value); setPriceCheckMsg(null) }}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                    placeholder="0.00" />
                  <p className="text-xs text-slate-500 mt-1">⚠ Verifica el precio actual antes de registrar.</p>
                </div>
                {restockPreview && (
                  <div className="bg-slate-700/50 rounded-lg p-3 text-sm space-y-1">
                    <div className="text-slate-400">
                      Costo por porción: <span className="text-white font-semibold">{formatUnitCost(restockPreview.costPerBase)}</span>
                    </div>
                    <div className="text-emerald-300 font-semibold">
                      {t('inventory.newWAC')}: {formatUnitCost(restockPreview.newWAC)}/{getUnitName(restocking.base_unit_key)}
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
                    <input type="number" min={qtyStep(restocking.purchase_unit_key || restocking.base_unit_key) === 1 ? 1 : 0.01} step={qtyStep(restocking.purchase_unit_key || restocking.base_unit_key)} value={restockPurchaseQty}
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
                    onChange={e => { setRestockCostPesos(e.target.value); setPriceCheckMsg(null) }}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                    placeholder="0.00" />
                  <p className="text-xs text-slate-500 mt-1">⚠ Verifica el precio actual antes de registrar.</p>
                </div>

                {restockPreview && restockCostPesos && (
                  <div className="bg-slate-700/50 rounded-lg p-3 text-sm space-y-1">
                    <div className="text-slate-400">
                      Por {getUnitName(restocking.base_unit_key)}: <span className="text-white font-semibold">{formatUnitCost(restockPreview.costPerBase)}</span>
                    </div>
                    <div className="text-emerald-300 font-semibold">
                      {t('inventory.newWAC')}: {formatUnitCost(restockPreview.newWAC)}/{getUnitName(restocking.base_unit_key)}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="mt-3">
              {isAdmin && (
                <label className="flex items-center gap-2 text-xs text-slate-300 mb-2">
                  <input type="checkbox" checked={restockFree} onChange={e => { setRestockFree(e.target.checked); setPriceCheckMsg(null) }} />
                  Entró sin costo (cortesía del proveedor) — solo dueño, con motivo
                </label>
              )}
              <label className="text-xs text-slate-400 block mb-1">{restockFree ? 'Motivo *' : 'Nota (opcional)'}</label>
              <input value={restockNote} onChange={e => setRestockNote(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                placeholder={restockFree ? 'ej. 2 cajas de cortesía de la cervecería' : 'ej. Pedido de proveedor'} />
            </div>

            {priceCheckMsg && (
              <div className="mt-3 text-sm bg-amber-900/40 border border-amber-600 text-amber-100 rounded-lg px-3 py-2">
                ⚠️ {priceCheckMsg}
              </div>
            )}

            <div className="flex gap-3 mt-5">
              <button onClick={() => { setRestocking(null); setRestockFree(false); setPriceCheckMsg(null) }} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              {(() => {
                const isFood = restocking.category === 'food'
                const priced = restockFree || parseFloat((isFood ? restockTotalCostPesos : restockCostPesos) || '0') > 0
                return (
                  <button onClick={() => handleRestock(!!priceCheckMsg)} disabled={saving || !priced}
                    title={priced ? '' : 'Escribe cuánto costó'}
                    className={`flex-1 py-2 rounded-lg font-bold disabled:opacity-50 ${priceCheckMsg ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
                    {saving ? 'Guardando…' : priceCheckMsg ? 'Sí, el precio es correcto' : priced ? 'Registrar' : 'Falta el precio'}
                  </button>
                )
              })()}
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
            {adjusting.pour_ml ? (
              <p className="text-xs text-amber-300/90 -mt-2 mb-3">
                En ml: 1 shot = {fmtQty(adjusting.pour_ml)} ml · hay {shotsIn(Number(adjusting.stock_quantity), adjusting.pour_ml)} shots
                ({fmtQty(adjusting.stock_quantity)} ml). Media botella de {fmtQty((items.find(i => i.yields_item_id === adjusting.id)?.bottle_ml) ?? 750)} ml
                = {fmtQty(((items.find(i => i.yields_item_id === adjusting.id)?.bottle_ml) ?? 750) / 2)} ml.
              </p>
            ) : null}
            {isOpenedChild(adjusting) && (
              <p className="text-xs text-amber-200/90 bg-amber-900/30 border border-amber-800 rounded-lg px-3 py-2 -mt-2 mb-4">
                Solo aumentan al abrir una {adjusting.item_type === 'CIG_SINGLE' ? 'caja' : 'botella'}.
                {!isAdmin && ' El conteo solo puede bajar; para subirlo, pide al administrador.'}
              </p>
            )}

            <div className="mb-3">
              <label className="text-xs text-slate-400 block mb-1">Tipo de ajuste</label>
              <div className={`grid gap-2 ${isOpenedChild(adjusting) ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {[
                  { value: 'MANUAL_ADJUSTMENT', label: t('inventory.manualAdj'),   color: 'sky' },
                  { value: 'WASTE',              label: t('inventory.waste'),        color: 'red' },
                  { value: 'COUNT_ADJUSTMENT',   label: t('inventory.physicalCount'), color: 'violet' },
                ].filter(o => !(isOpenedChild(adjusting) && o.value === 'MANUAL_ADJUSTMENT'))
                 .map(({ value, label, color }) => (
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
                <input type="number" step={qtyStep(adjusting.base_unit_key)} value={adjustDelta} onChange={e => setAdjustDelta(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder={`+10 o -5 ${getUnitName(adjusting.base_unit_key)}`} autoFocus />
              </div>
            )}

            {adjustType === 'WASTE' && (
              <div className="mb-3">
                <label className="text-xs text-slate-400 block mb-1">
                  Cantidad a dar de baja ({getUnitName(adjusting.base_unit_key)})
                </label>
                <input type="number" min={qtyStep(adjusting.base_unit_key) === 1 ? 1 : 0.01} step={qtyStep(adjusting.base_unit_key)} value={adjustWaste}
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
                <input type="number" min={0} step={qtyStep(adjusting.base_unit_key)} value={adjustCounted}
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

      {portioning && (
        <PortionDialog raw={portioning as any}
          packs={items.filter(i => i.portion_source_id === portioning.id && i.is_active) as any}
          isOwner={isAdmin}
          onDone={() => { setPortioning(null); qc.invalidateQueries({ queryKey: ['inventory'] }) }}
          onCancel={() => setPortioning(null)} />
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
              <span className="text-amber-300 font-bold">{openingBottle.shots_per_bottle} shots
                {openingBottle.bottle_ml ? ` (${fmtQty(openingBottle.bottle_ml)} ml)` : ''}</span> al inventario.
              Botellas restantes: <span className="font-bold text-white">{fmtQty(openingBottle.stock_quantity)}</span>
            </p>
            {openingBottle.bottle_ml && (
              <label className="block text-xs text-slate-400 mb-4 -mt-2">Tamaño de esta botella (ml)
                <input type="number" min={50} max={5000} step={1} value={openSize}
                  onChange={e => setOpenSize(e.target.value)}
                  className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                <span className="block mt-1 text-slate-500">
                  {openingBottle.bottle_ml && parseFloat(openSize) !== openingBottle.bottle_ml
                    ? `Distinta a la habitual (${fmtQty(openingBottle.bottle_ml)} ml): solo para esta botella.`
                    : 'Cámbialo si esta botella es de otro tamaño (p. ej. 1000 ml).'}
                </span>
              </label>
            )}
            {(remainingFor(openingBottle) > 0 || openStillMsg) && (
              <p className="text-sm font-bold text-amber-200 bg-amber-900/40 border border-amber-600 rounded-lg px-3 py-2 -mt-2 mb-4">
                ⚠️ {openStillMsg ?? `Todavía quedan ${fmtQty(remainingFor(openingBottle))} shots, ¿abrir otra?`}
              </p>
            )}
            <div className="flex gap-3">
              <button onClick={() => { setOpeningBottle(null); setOpenStillMsg(null) }} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleOpenBottle} disabled={saving || openingBottle.stock_quantity < 1}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg font-bold disabled:opacity-50 text-slate-900">
                {remainingFor(openingBottle) > 0 || openStillMsg ? 'Sí, abrir otra' : 'Abrir Botella'}
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
            {(remainingFor(openingBox) > 0 || openStillMsg) && (
              <p className="text-sm font-bold text-orange-200 bg-orange-900/40 border border-orange-600 rounded-lg px-3 py-2 -mt-2 mb-4">
                ⚠️ {openStillMsg ?? `Todavía quedan ${fmtQty(remainingFor(openingBox))} cigarros sueltos, ¿abrir otra?`}
              </p>
            )}
            <div className="flex gap-3">
              <button onClick={() => { setOpeningBox(null); setOpenStillMsg(null) }} className="flex-1 py-2 border border-slate-600 rounded-lg">Cancelar</button>
              <button onClick={handleOpenBox} disabled={saving || openingBox.stock_quantity < 1}
                className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg font-bold disabled:opacity-50">
                {remainingFor(openingBox) > 0 || openStillMsg ? 'Sí, abrir otra' : 'Abrir Caja'}
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
                  <SupplierSelect value={newItem.supplier} onChange={v => setNewItem({ ...newItem, supplier: v })} />
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
                  onChange={v => setNewItem({ ...newItem, base_unit_key: v,
                    purchase_pack_size: packFor(v, newItem.purchase_unit_key, newItem.purchase_pack_size) })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Cant. Inicial{newItem.base_unit_key ? ` (${getUnitName(newItem.base_unit_key).toLowerCase()})` : ''}</label>
                  <input type="number" min={0} step={qtyStep(newItem.base_unit_key)} value={newItem.stock_quantity}
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
              {/* How it is bought, then its price per purchase unit. */}
              <UnitSelect label={`${t('inventory.purchaseUnit')} (cómo lo compras)`} value={newItem.purchase_unit_key}
                emptyLabel="— Igual que la unidad base —"
                onChange={v => setNewItem({ ...newItem, purchase_unit_key: v,
                                            purchase_pack_size: packFor(newItem.base_unit_key, v, newItem.purchase_pack_size) })} />
              <CostEntry
                pricePesos={newItem.initial_cost_pesos}
                onPrice={v => setNewItem({ ...newItem, initial_cost_pesos: v })}
                packSize={newItem.purchase_pack_size}
                onPackSize={newItem.purchase_unit_key
                  ? (v => setNewItem({ ...newItem, purchase_pack_size: v })) : undefined}
                baseUnitName={newItem.base_unit_key ? getUnitName(newItem.base_unit_key) : 'unidad'}
                purchaseUnitName={newItem.purchase_unit_key ? getUnitName(newItem.purchase_unit_key) : null}
                baseUnitKey={newItem.base_unit_key} purchaseUnitKey={newItem.purchase_unit_key || null} />
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
              {newItem.item_type === 'BOTTLE' && (
                <BottleSizeFields bottle={newItem.bottle_ml} pour={newItem.pour_ml}
                  onChange={(b, p) => setNewItem({ ...newItem, bottle_ml: b, pour_ml: p })} />
              )}
              {(newItem.item_type === 'BOTTLE' || newItem.item_type === 'CIG_BOX') && (
                <>
                  {newItem.item_type === 'CIG_BOX' && <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      {newItem.item_type === 'CIG_BOX' ? 'Cigarros por caja' : 'Shots por botella'}
                    </label>
                    <input type="number" min={1} value={newItem.shots_per_bottle}
                      onChange={e => setNewItem({ ...newItem, shots_per_bottle: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                      placeholder={newItem.item_type === 'CIG_BOX' ? '20' : '15'} />
                    <p className="text-[11px] text-slate-500 mt-1">
                      {newItem.item_type === 'CIG_BOX'
                        ? 'Con este dato podrás abrir la caja y vender cigarros sueltos. Vacío = solo se vende la caja completa.'
                        : 'Con este dato podrás abrir la botella y vender shots. Vacío = solo se vende la botella cerrada.'}
                    </p>
                  </div>}
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      {newItem.item_type === 'CIG_BOX' ? 'Artículo individual que produce' : 'Copa/Shot que produce'}
                    </label>
                    <select value={newItem.yields_item_id} onChange={e => setNewItem({ ...newItem, yields_item_id: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                      <option value="">— Crear automáticamente —</option>
                      {items.filter(i =>
                        newItem.item_type === 'CIG_BOX' ? i.item_type === 'CIG_SINGLE' : i.item_type === 'STANDARD' && i.base_unit_key === 'ml'
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
              WAC actual: <span className="text-white">{formatUnitCost(editing.unit_cost_cents)}/{getUnitName(editing.base_unit_key)}</span>
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
                  <SupplierSelect value={editForm.supplier} onChange={v => setEditForm({ ...editForm, supplier: v })} />
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
              <UnitSelect label={t('inventory.purchaseUnit')} value={editForm.purchase_unit_key ?? ''}
                emptyLabel="— Igual que la unidad base —"
                onChange={v => setEditForm({ ...editForm, purchase_unit_key: v })} />
              <div>
                <label className="text-xs text-slate-400 block mb-1">
                  Costo por {editForm.purchase_unit_key ? getUnitName(editForm.purchase_unit_key) : 'unidad de compra'} ($)
                </label>
                <input type="number" min={0} step="0.01" value={editForm.purchase_cost_pesos}
                  onChange={e => setEditForm({ ...editForm, purchase_cost_pesos: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="0.00" />
                <p className="text-xs text-slate-500 mt-1">Precio de compra de referencia — se pre-llena en Reabastecer.</p>
              </div>
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
              {editForm.item_type === 'STANDARD' && WEIGHT_UNITS.includes(editForm.base_unit_key) && editing && (
                <RawPacksSection raw={editing} items={items}
                  onChanged={() => qc.invalidateQueries({ queryKey: ['inventory'] })} />
              )}
              {editForm.item_type === 'STANDARD' && !WEIGHT_UNITS.includes(editForm.base_unit_key) && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-400 block">Se porciona de (crudo)
                    <select value={editForm.portion_source_id ?? ''} onChange={e => setEditForm({ ...editForm, portion_source_id: e.target.value })}
                      className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm text-white">
                      <option value="">— no se porciona —</option>
                      {rawCandidates(items, editing?.id, editForm.category)
                        .map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                  </label>
                  {editForm.portion_source_id && (
                    <label className="text-xs text-slate-400 block">Peso por paquete (g / ml)
                      <input type="number" min={1} value={editForm.portion_size ?? ''} placeholder="300"
                        onChange={e => setEditForm({ ...editForm, portion_size: e.target.value })}
                        className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                    </label>
                  )}
                  {editForm.portion_source_id && (
                    <p className="col-span-2 text-[11px] text-slate-500">
                      Se cuenta en paquetes y no se reabastece: sale de 🔪 Porcionar el crudo, que se compra por caja en kg.
                    </p>
                  )}
                </div>
              )}
              {editForm.item_type === 'BOTTLE' && (
                <BottleSizeFields bottle={editForm.bottle_ml} pour={editForm.pour_ml}
                  onChange={(b, p) => setEditForm({ ...editForm, bottle_ml: b, pour_ml: p })} />
              )}
              {(editForm.item_type === 'BOTTLE' || editForm.item_type === 'CIG_BOX') && (
                <>
                  {editForm.item_type === 'CIG_BOX' && <div>
                    <label className="text-xs text-slate-400 block mb-1">Cigarros por caja</label>
                    <input type="number" min={1} value={editForm.shots_per_bottle}
                      onChange={e => setEditForm({ ...editForm, shots_per_bottle: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2" />
                  </div>}
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      {editForm.item_type === 'CIG_BOX' ? 'Artículo individual' : 'Copa/Shot producido'}
                    </label>
                    <select value={editForm.yields_item_id} onChange={e => setEditForm({ ...editForm, yields_item_id: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                      <option value="">— Crear automáticamente —</option>
                      {items.filter(i =>
                        editForm.item_type === 'CIG_BOX' ? i.item_type === 'CIG_SINGLE' : i.item_type === 'STANDARD' && i.base_unit_key === 'ml' && i.id !== editing.id
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
                  {viewingMovements.unit_cost_cents > 0 && ` · WAC: ${formatUnitCost(viewingMovements.unit_cost_cents)}`}
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
                            {(() => {
                              const d = new Date(m.created_at)
                              if (!m.created_at || d.getFullYear() < 2000) return '—'
                              return d.toLocaleString('es-MX', {
                                day: '2-digit', month: 'short', year: '2-digit',
                                hour: '2-digit', minute: '2-digit', hour12: true,
                              })
                            })()}
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
                            {m.unit_cost_cents != null ? formatUnitCost(m.unit_cost_cents) : '—'}
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
                {' '}— al vender se descuenta {addToMenu.pour_ml
                  ? <>1 shot ({fmtQty(addToMenu.pour_ml)} ml)</>
                  : <>1 {getUnitName(addToMenu.base_unit_key)}</>}
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
                <label className="text-xs text-slate-400 block mb-1">Precio de venta (pesos) *</label>
                <PesoInput cents={menuForm.price_cents} placeholder="ej. 166"
                  onChange={c => setMenuForm({ ...menuForm, price_cents: c })} />
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

      {/* ── Supplier Catalog Modal (Admin) ───────────────────────────────── */}
      {showSupplierCatalog && <SupplierCatalogModal onClose={() => setShowSupplierCatalog(false)} />}
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

// ── Supplier Catalog Modal ────────────────────────────────────────────────────

function SupplierCatalogModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  type SupplierRow = { id: string; name: string; contact_phone: string | null; is_active: boolean }
  type DirtyRow = { name: string; contact_phone: string }

  const [dirtyRows, setDirtyRows] = useState<Record<string, DirtyRow>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [adding, setAdding] = useState(false)

  // Fetch active suppliers (catalog view only shows active ones)
  const { data: suppliers = [] } = useQuery<SupplierRow[]>({
    queryKey: ['suppliers'],
    queryFn: () => client.get('/suppliers').then(r => r.data),
  })

  const getRow = (s: SupplierRow): DirtyRow =>
    dirtyRows[s.id] ?? { name: s.name, contact_phone: s.contact_phone ?? '' }
  const isDirty = (s: SupplierRow) => !!dirtyRows[s.id]

  const patch = (id: string, field: keyof DirtyRow, value: string) => {
    const base = suppliers.find(s => s.id === id)
    setDirtyRows(prev => {
      const current = prev[id] ?? { name: base?.name ?? '', contact_phone: base?.contact_phone ?? '' }
      return { ...prev, [id]: { ...current, [field]: value } }
    })
  }

  const saveRow = async (id: string) => {
    const data = dirtyRows[id]
    if (!data) return
    setSaving(id)
    try {
      await client.patch(`/suppliers/${id}`, data)
      await qc.invalidateQueries({ queryKey: ['suppliers'] })
      setDirtyRows(prev => { const n = { ...prev }; delete n[id]; return n })
      toast.success('Proveedor actualizado')
    } catch (err: any) { toast.error(err.response?.data?.error || 'Error') }
    finally { setSaving(null) }
  }

  const deleteRow = async (id: string, name: string) => {
    if (!confirm(`¿Eliminar proveedor "${name}"?`)) return
    try {
      await client.delete(`/suppliers/${id}`)
      await qc.invalidateQueries({ queryKey: ['suppliers'] })
      toast.success('Proveedor eliminado')
    } catch { toast.error('Error al eliminar') }
  }

  const addSupplier = async () => {
    if (!newName.trim()) return toast.error('El nombre es requerido')
    setAdding(true)
    try {
      await client.post('/suppliers', { name: newName.trim(), contact_phone: newPhone.trim() || null })
      await qc.invalidateQueries({ queryKey: ['suppliers'] })
      toast.success('Proveedor creado')
      setShowAdd(false); setNewName(''); setNewPhone('')
    } catch (err: any) { toast.error(err.response?.data?.error || 'Error') }
    finally { setAdding(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-600 shadow-xl flex flex-col max-h-[85dvh]">
        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-bold">🏭 Catálogo de Proveedores</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl">&times;</button>
        </div>

        <div className="overflow-y-scroll flex-1 p-4 space-y-2">
          <div className="grid grid-cols-[1fr_130px_50px_36px] gap-2 text-xs text-slate-400 px-2 pb-1">
            <span>Nombre</span><span>Teléfono</span><span></span><span></span>
          </div>

          {suppliers.map(s => {
            const row = getRow(s)
            return (
              <div key={s.id} className={`grid grid-cols-[1fr_130px_50px_36px] gap-2 items-center rounded-lg px-2 py-1.5 ${isDirty(s) ? 'bg-slate-700/70' : 'bg-slate-700/30'}`}>
                <input
                  value={row.name}
                  onChange={e => patch(s.id, 'name', e.target.value)}
                  className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm w-full"
                />
                <input
                  value={row.contact_phone}
                  onChange={e => patch(s.id, 'contact_phone', e.target.value)}
                  placeholder="tel. opcional"
                  className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm w-full"
                />
                <button
                  disabled={!isDirty(s) || saving === s.id}
                  onClick={() => saveRow(s.id)}
                  className="bg-sky-700 hover:bg-sky-600 rounded px-2 py-1 text-xs font-bold disabled:opacity-30">
                  {saving === s.id ? '…' : '✓'}
                </button>
                <button
                  onClick={() => deleteRow(s.id, s.name)}
                  className="bg-red-900/60 hover:bg-red-800 rounded px-2 py-1 text-xs text-red-300">
                  🗑
                </button>
              </div>
            )
          })}

          {suppliers.length === 0 && (
            <div className="text-center text-slate-500 py-6 text-sm">Sin proveedores registrados</div>
          )}

          {showAdd ? (
            <div className="bg-slate-700/50 rounded-xl border border-slate-600 p-4 space-y-3 mt-2">
              <p className="text-xs text-slate-400 font-semibold">Nuevo Proveedor</p>
              <div className="grid grid-cols-2 gap-2">
                <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSupplier()}
                  placeholder="Nombre *" autoFocus
                  className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm" />
                <input value={newPhone} onChange={e => setNewPhone(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSupplier()}
                  placeholder="Teléfono (opcional)"
                  className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm" />
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setShowAdd(false); setNewName(''); setNewPhone('') }}
                  className="flex-1 py-1.5 border border-slate-600 rounded text-sm">Cancelar</button>
                <button onClick={addSupplier} disabled={adding}
                  className="flex-1 py-1.5 bg-sky-600 hover:bg-sky-500 rounded text-sm font-bold disabled:opacity-50">
                  {adding ? 'Creando…' : 'Crear'}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAdd(true)}
              className="w-full py-2 border border-dashed border-slate-600 rounded-xl text-slate-400 hover:text-white hover:border-slate-400 text-sm mt-2">
              + Nuevo Proveedor
            </button>
          )}
        </div>

        <div className="p-4 border-t border-slate-700">
          <button onClick={onClose} className="w-full py-2 border border-slate-600 rounded-lg text-sm">Cerrar</button>
        </div>
      </div>
    </div>
  )
}
