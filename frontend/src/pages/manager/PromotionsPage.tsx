import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'
import { IconTag, IconPencil, IconTrash } from '../../components/Icon'

type PromoForm = {
  name: string
  promo_type: string
  scope: 'ITEM' | 'CATEGORY'
  applies_to_item_id: string
  applies_to_category_id: string
  eligible_item_ids: string[]
  required_quantity: number
  free_quantity: number
  discounted_quantity: number
  discount_value: number
  max_applications_per_ticket: string   // '' = unlimited
  is_stackable: boolean
  combine_across_items: boolean
  valid_from: string
  valid_to: string
  happy_hour_start: string
  happy_hour_end: string
  requires_confirmation: boolean
  priority: number
  is_active: boolean
}

const BLANK: PromoForm = {
  name: '',
  promo_type: 'BOGO',
  scope: 'ITEM',
  applies_to_item_id: '',
  applies_to_category_id: '',
  eligible_item_ids: [],
  required_quantity: 2,
  free_quantity: 1,
  discounted_quantity: 1,
  discount_value: 50,
  max_applications_per_ticket: '',
  is_stackable: false,
  combine_across_items: false,
  valid_from: '',
  valid_to: '',
  happy_hour_start: '',
  happy_hour_end: '',
  requires_confirmation: false,
  priority: 0,
  is_active: true,
}

const TYPE_LABELS: Record<string, string> = {
  BOGO: '2x1 — Paga 1, llévate 2',
  QTY_PERCENT_DISCOUNT: '% de descuento por cantidad',
  HAPPY_HOUR: 'Happy Hour',
  ITEM_DISCOUNT: 'Descuento por artículo',
  BUNDLE: 'Paquete',
  POOL_TIME_FREE_MINUTES: 'Minutos de mesa gratis',
}

// Types this page can create/edit with the quantity form
const QUANTITY_TYPES = ['BOGO', 'QTY_PERCENT_DISCOUNT']

const ERROR_MESSAGES: Record<string, string> = {
  NAME_REQUIRED: 'Se requiere un nombre',
  INVALID_PROMO_TYPE: 'Tipo de promoción inválido',
  INVALID_DISCOUNT_TYPE: 'Tipo de descuento inválido',
  ELIGIBLE_PRODUCTS_REQUIRED: 'Selecciona al menos un producto o categoría',
  REQUIRED_QUANTITY_MUST_BE_POSITIVE: 'La cantidad requerida debe ser mayor a 0',
  FREE_QUANTITY_MUST_BE_POSITIVE: 'Las unidades gratis deben ser mayor a 0',
  FREE_QUANTITY_MUST_BE_LESS_THAN_REQUIRED: 'Las unidades gratis deben ser menores a la cantidad requerida',
  DISCOUNTED_QUANTITY_MUST_BE_POSITIVE: 'Las unidades con descuento deben ser mayor a 0',
  DISCOUNT_TYPE_MUST_BE_PERCENTAGE: 'El descuento debe ser porcentual',
  DISCOUNT_VALUE_OUT_OF_RANGE: 'El porcentaje debe estar entre 1 y 100',
  MAX_APPLICATIONS_MUST_BE_POSITIVE: 'El máximo de aplicaciones debe ser mayor a 0',
  INVALID_DATE_RANGE: 'La fecha final debe ser posterior a la inicial',
  INCOMPLETE_TIME_RANGE: 'Indica ambos horarios o deja los dos vacíos',
  INVALID_TIME_FORMAT: 'Horario inválido, usa el formato HH:MM',
  INVALID_TIME_RANGE: 'El horario inicial y final no pueden ser iguales',
}

function money(cents: number): string {
  return `$${((cents || 0) / 100).toFixed(2)}`
}

export default function PromotionsPage() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [form, setForm] = useState<PromoForm>({ ...BLANK })
  const [saving, setSaving] = useState(false)

  useEscKey(() => { setShowNew(false); setEditing(null) }, showNew || !!editing)

  const { data: promos = [], refetch } = useQuery({
    queryKey: ['promotions'],
    queryFn: () => client.get('/promotions').then(r => r.data),
    staleTime: 0,
  })

  const { data: items = [] } = useQuery({
    queryKey: ['all-items'],
    queryFn: () => client.get('/menu/items', { params: { include_inactive: true } }).then(r => r.data),
  })

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => client.get('/menu/categories').then(r => r.data),
  })

  const itemById = useMemo(() => {
    const map = new Map<string, any>()
    for (const i of items as any[]) map.set(i.id, i)
    return map
  }, [items])

  const categoryById = useMemo(() => {
    const map = new Map<string, any>()
    for (const c of categories as any[]) map.set(c.id, c)
    return map
  }, [categories])

  // ── Payload ────────────────────────────────────────────────────────────────
  const buildPayload = (f: PromoForm) => {
    const payload: any = {
      name: f.name.trim(),
      promo_type: f.promo_type,
      applies_to_item_id: f.scope === 'ITEM' ? (f.applies_to_item_id || null) : null,
      applies_to_category_id: f.scope === 'CATEGORY' ? (f.applies_to_category_id || null) : null,
      eligible_item_ids: f.scope === 'ITEM' ? f.eligible_item_ids : [],
      required_quantity: Number(f.required_quantity),
      max_applications_per_ticket:
        f.max_applications_per_ticket === '' ? null : Number(f.max_applications_per_ticket),
      is_stackable: f.is_stackable,
      combine_across_items: f.combine_across_items,
      valid_from: f.valid_from || null,
      valid_to: f.valid_to || null,
      happy_hour_start: f.happy_hour_start || null,
      happy_hour_end: f.happy_hour_end || null,
      requires_confirmation: f.requires_confirmation,
      priority: Number(f.priority),
      is_active: f.is_active,
    }
    if (f.promo_type === 'BOGO') {
      payload.free_quantity = Number(f.free_quantity)
    } else {
      payload.discounted_quantity = Number(f.discounted_quantity)
      payload.discount_type = 'PERCENTAGE'
      payload.discount_value = Number(f.discount_value)
    }
    return payload
  }

  const showError = (err: any, fallback: string) => {
    const code = err.response?.data?.error
    toast.error(ERROR_MESSAGES[code] || err.response?.data?.message || code || fallback)
  }

  const handleCreate = async () => {
    if (!form.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      await client.post('/promotions', buildPayload(form))
      toast.success(`Promoción "${form.name}" creada`)
      refetch()
      qc.invalidateQueries({ queryKey: ['promotions'] })
      setShowNew(false)
      setForm({ ...BLANK })
    } catch (err: any) {
      showError(err, 'Error al crear la promoción')
    } finally { setSaving(false) }
  }

  const handleUpdate = async () => {
    if (!form.name.trim()) return toast.error('Se requiere un nombre')
    setSaving(true)
    try {
      await client.patch(`/promotions/${editing.id}`, buildPayload(form))
      toast.success('Promoción actualizada')
      refetch()
      qc.invalidateQueries({ queryKey: ['promotions'] })
      setEditing(null)
    } catch (err: any) {
      showError(err, 'Error al guardar')
    } finally { setSaving(false) }
  }

  const handleToggle = async (promo: any) => {
    try {
      await client.patch(`/promotions/${promo.id}`, { is_active: !promo.is_active })
      toast.success(promo.is_active ? 'Promoción desactivada' : 'Promoción activada')
      refetch()
    } catch (err: any) {
      showError(err, 'Error al cambiar el estado')
    }
  }

  const handleDelete = async (promo: any) => {
    if (!window.confirm(`¿Desactivar la promoción "${promo.name}"? Dejará de aplicarse en cuentas nuevas. El historial de ventas se conserva.`)) return
    try {
      await client.delete(`/promotions/${promo.id}`)
      toast.success('Promoción desactivada')
      refetch()
    } catch (err: any) {
      showError(err, 'Error al eliminar')
    }
  }

  const openNew = () => { setForm({ ...BLANK }); setShowNew(true) }

  const openEdit = (promo: any) => {
    setForm({
      name: promo.name || '',
      promo_type: promo.promo_type,
      scope: promo.applies_to_category_id ? 'CATEGORY' : 'ITEM',
      applies_to_item_id: promo.applies_to_item_id || '',
      applies_to_category_id: promo.applies_to_category_id || '',
      eligible_item_ids: promo.eligible_item_ids || [],
      required_quantity: promo.required_quantity ?? 2,
      free_quantity: promo.free_quantity ?? 1,
      discounted_quantity: promo.discounted_quantity ?? 1,
      discount_value: promo.discount_value ?? 50,
      max_applications_per_ticket:
        promo.max_applications_per_ticket == null ? '' : String(promo.max_applications_per_ticket),
      is_stackable: !!promo.is_stackable,
      combine_across_items: !!promo.combine_across_items,
      valid_from: promo.valid_from || '',
      valid_to: promo.valid_to || '',
      happy_hour_start: promo.happy_hour_start || '',
      happy_hour_end: promo.happy_hour_end || '',
      requires_confirmation: !!promo.requires_confirmation,
      priority: promo.priority ?? 0,
      is_active: promo.is_active !== false,
    })
    setEditing(promo)
  }

  // ── Live preview of what the customer pays ────────────────────────────────
  const preview = useMemo(() => {
    const item = itemById.get(form.applies_to_item_id)
    if (!item || form.scope !== 'ITEM' || !QUANTITY_TYPES.includes(form.promo_type)) return null
    const qty = Number(form.required_quantity) || 0
    if (qty <= 0) return null
    const price = item.price_cents || 0
    const gross = price * qty
    const discount = form.promo_type === 'BOGO'
      ? price * Math.min(Number(form.free_quantity) || 0, qty)
      : Math.floor(price * (Number(form.discount_value) || 0) / 100) * Math.min(Number(form.discounted_quantity) || 0, qty)
    return { name: item.name, qty, gross, discount, total: Math.max(0, gross - discount) }
  }, [form, itemById])

  const describe = (p: any): string => {
    if (p.promo_type === 'BOGO') {
      return `Compra ${p.required_quantity} → paga ${Math.max(0, (p.required_quantity || 0) - (p.free_quantity || 0))}`
    }
    if (p.promo_type === 'QTY_PERCENT_DISCOUNT') {
      return `Compra ${p.required_quantity} → ${p.discount_value}% de descuento en ${p.discounted_quantity} unidad(es)`
    }
    if (p.promo_type === 'HAPPY_HOUR') {
      return `${p.happy_hour_start || '?'}–${p.happy_hour_end || '?'} · ${p.discount_type === 'PERCENTAGE' ? `${p.discount_value}%` : money(p.discount_value)}`
    }
    return p.discount_type === 'PERCENTAGE' ? `${p.discount_value}% de descuento` : money(p.discount_value)
  }

  const scopeLabel = (p: any): string => {
    if (p.applies_to_category_id) {
      return `Categoría: ${categoryById.get(p.applies_to_category_id)?.name || '—'}`
    }
    const names = [p.applies_to_item_id, ...(p.eligible_item_ids || [])]
      .filter(Boolean)
      .map((id: string) => itemById.get(id)?.name || '—')
    const unique = Array.from(new Set(names))
    return unique.length ? `Producto: ${unique.join(', ')}` : 'Sin productos configurados'
  }

  const isQuantityForm = QUANTITY_TYPES.includes(form.promo_type)

  const PromoFormFields = (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Nombre</label>
        <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="ej. 2x1 Cubetazo"
          className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">Tipo de promoción</label>
        <select value={form.promo_type} onChange={e => setForm(f => ({ ...f, promo_type: e.target.value }))}
          className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm">
          <option value="BOGO">{TYPE_LABELS.BOGO}</option>
          <option value="QTY_PERCENT_DISCOUNT">{TYPE_LABELS.QTY_PERCENT_DISCOUNT}</option>
        </select>
      </div>

      {/* Scope */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Aplica a</label>
        <div className="flex gap-2 mb-2">
          {(['ITEM', 'CATEGORY'] as const).map(s => (
            <button key={s} type="button" onClick={() => setForm(f => ({ ...f, scope: s }))}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${form.scope === s ? 'bg-zinc-700 border-zinc-400' : 'bg-transparent border-zinc-600 text-zinc-400'}`}>
              {s === 'ITEM' ? 'Productos' : 'Categoría'}
            </button>
          ))}
        </div>

        {form.scope === 'ITEM' ? (
          <>
            <select value={form.applies_to_item_id}
              onChange={e => setForm(f => ({ ...f, applies_to_item_id: e.target.value }))}
              className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm">
              <option value="">— Seleccionar producto —</option>
              {(items as any[]).map((i: any) => (
                <option key={i.id} value={i.id}>{i.name} · {money(i.price_cents)}</option>
              ))}
            </select>

            {/* Extra eligible products */}
            <div className="mt-2">
              <label className="block text-xs text-zinc-500 mb-1">
                Productos adicionales elegibles (opcional)
              </label>
              <div className="max-h-28 overflow-y-auto bg-zinc-900/50 rounded-lg border border-zinc-700 p-2 space-y-1">
                {(items as any[])
                  .filter((i: any) => i.id !== form.applies_to_item_id)
                  .map((i: any) => (
                    <label key={i.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input type="checkbox" checked={form.eligible_item_ids.includes(i.id)}
                        onChange={e => setForm(f => ({
                          ...f,
                          eligible_item_ids: e.target.checked
                            ? [...f.eligible_item_ids, i.id]
                            : f.eligible_item_ids.filter(id => id !== i.id),
                        }))} />
                      <span className="truncate">{i.name}</span>
                    </label>
                  ))}
              </div>
            </div>
          </>
        ) : (
          <select value={form.applies_to_category_id}
            onChange={e => setForm(f => ({ ...f, applies_to_category_id: e.target.value }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm">
            <option value="">— Seleccionar categoría —</option>
            {(categories as any[]).map((c: any) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Quantity rules */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Cantidad requerida</label>
          <input type="number" min={1} value={form.required_quantity}
            onChange={e => setForm(f => ({ ...f, required_quantity: Number(e.target.value) }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
        {form.promo_type === 'BOGO' ? (
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Unidades gratis</label>
            <input type="number" min={1} value={form.free_quantity}
              onChange={e => setForm(f => ({ ...f, free_quantity: Number(e.target.value) }))}
              className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
          </div>
        ) : (
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Unidades con descuento</label>
            <input type="number" min={1} value={form.discounted_quantity}
              onChange={e => setForm(f => ({ ...f, discounted_quantity: Number(e.target.value) }))}
              className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
          </div>
        )}
      </div>

      {form.promo_type === 'QTY_PERCENT_DISCOUNT' && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Porcentaje de descuento (%)</label>
          <input type="number" min={1} max={100} value={form.discount_value}
            onChange={e => setForm(f => ({ ...f, discount_value: Number(e.target.value) }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Máx. por cuenta</label>
          <input type="number" min={1} placeholder="Sin límite"
            value={form.max_applications_per_ticket}
            onChange={e => setForm(f => ({ ...f, max_applications_per_ticket: e.target.value }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Prioridad</label>
          <input type="number" value={form.priority}
            onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Vigente desde</label>
          <input type="date" value={form.valid_from}
            onChange={e => setForm(f => ({ ...f, valid_from: e.target.value }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Vigente hasta</label>
          <input type="date" value={form.valid_to}
            onChange={e => setForm(f => ({ ...f, valid_to: e.target.value }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Horario desde</label>
          <input type="time" value={form.happy_hour_start}
            onChange={e => setForm(f => ({ ...f, happy_hour_start: e.target.value }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Horario hasta</label>
          <input type="time" value={form.happy_hour_end}
            onChange={e => setForm(f => ({ ...f, happy_hour_end: e.target.value }))}
            className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm" />
        </div>
        <p className="col-span-2 text-xs text-zinc-500 -mt-1">
          {form.happy_hour_start && form.happy_hour_end
            ? (form.happy_hour_start > form.happy_hour_end
                ? `Solo aplica de ${form.happy_hour_start} a ${form.happy_hour_end} del día siguiente.`
                : `Solo aplica de ${form.happy_hour_start} a ${form.happy_hour_end}.`)
            : 'Déjalo vacío para que aplique todo el día. Se evalúa con la hora en que se ordenó el producto, así que la promoción no se pierde al cobrar más tarde.'}
        </p>
      </div>

      <div className="space-y-2 pt-1">
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input type="checkbox" className="mt-1" checked={form.requires_confirmation}
            onChange={e => setForm(f => ({ ...f, requires_confirmation: e.target.checked }))} />
          <span>
            Preguntar antes de aplicar
            <span className="block text-xs text-zinc-500">
              {form.requires_confirmation
                ? 'El mesero verá la promoción en la cuenta y decidirá si la aplica.'
                : 'La promoción se aplica automáticamente al cumplirse la cantidad.'}
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={form.is_stackable}
            onChange={e => setForm(f => ({ ...f, is_stackable: e.target.checked }))} />
          <span>Acumulable con otras promociones</span>
        </label>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input type="checkbox" className="mt-1" checked={form.combine_across_items}
            onChange={e => setForm(f => ({ ...f, combine_across_items: e.target.checked }))} />
          <span>
            Combinar productos distintos para alcanzar la cantidad
            <span className="block text-xs text-zinc-500">
              {form.combine_across_items
                ? 'Cualquier mezcla de productos elegibles activa la promoción; el descuento se aplica al más barato de cada grupo.'
                : 'La cantidad debe alcanzarse con el mismo producto (recomendado).'}
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={form.is_active}
            onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
          <span>Activa</span>
        </label>
      </div>

      {preview && (
        <div className="bg-zinc-900/60 border border-green-800 rounded-xl p-3 text-xs">
          <div className="text-green-400 font-semibold mb-1.5">Vista previa</div>
          <div className="flex justify-between text-zinc-300">
            <span>{preview.qty} × {preview.name}</span>
            <span className="font-mono">{money(preview.gross)}</span>
          </div>
          <div className="flex justify-between text-green-400">
            <span>Descuento</span>
            <span className="font-mono">-{money(preview.discount)}</span>
          </div>
          <div className="flex justify-between font-bold border-t border-zinc-700 mt-1 pt-1">
            <span>Paga</span>
            <span className="font-mono">{money(preview.total)}</span>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="min-h-screen bg-zinc-950 page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-2xl mx-auto p-4">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Promociones</h1>
            <p className="text-xs text-zinc-400 mt-0.5">2x1 y descuentos por cantidad — se aplican solos en la cuenta</p>
          </div>
          <button onClick={openNew}
            className="bg-white text-zinc-900 hover:bg-zinc-200 px-4 py-1.5 rounded-lg text-sm font-semibold">
            + Nueva
          </button>
        </div>

        {(promos as any[]).length === 0 && (
          <div className="text-center text-zinc-500 py-16">
            <div className="mb-3 flex justify-center"><IconTag className="w-10 h-10" /></div>
            <div>Sin promociones</div>
            <div className="text-xs mt-1">Crea un 2x1 o un descuento por cantidad</div>
          </div>
        )}

        <div className="space-y-3">
          {(promos as any[]).map((p: any) => {
            const active = p.is_active !== false
            const editable = QUANTITY_TYPES.includes(p.promo_type)
            return (
              <div key={p.id}
                className={`bg-zinc-800 rounded-2xl border p-4 ${active ? 'border-zinc-700' : 'border-zinc-800 opacity-60'}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{p.name}</span>
                      <span className="text-xs bg-zinc-800 text-zinc-200 px-1.5 py-0.5 rounded-full">
                        {TYPE_LABELS[p.promo_type] || p.promo_type}
                      </span>
                      {!active && <span className="text-xs text-zinc-500 italic">inactiva</span>}
                      {p.is_stackable && <span className="text-xs bg-violet-900 text-violet-300 px-1.5 py-0.5 rounded-full">Acumulable</span>}
                      {p.requires_confirmation && <span className="text-xs bg-amber-900 text-amber-300 px-1.5 py-0.5 rounded-full">Requiere confirmación</span>}
                    </div>
                    <div className="text-xs text-zinc-400 mt-1">{describe(p)}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">{scopeLabel(p)}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {p.max_applications_per_ticket
                        ? `Máx. ${p.max_applications_per_ticket} por cuenta`
                        : 'Sin límite por cuenta'}
                      {(p.valid_from || p.valid_to) && ` · ${p.valid_from || '…'} → ${p.valid_to || '…'}`}
                      {p.happy_hour_start && p.happy_hour_end && ` · ${p.happy_hour_start}–${p.happy_hour_end}`}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {editable && (
                      <button onClick={() => openEdit(p)}
                        className="bg-zinc-700 hover:bg-zinc-700 px-3 py-1.5 rounded-lg text-sm" title="Editar"><IconPencil className="w-4 h-4 inline" /></button>
                    )}
                    <button onClick={() => handleToggle(p)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${active ? 'bg-yellow-900 hover:bg-yellow-700 text-yellow-300' : 'bg-green-900 hover:bg-green-700 text-green-300'}`}
                      title={active ? 'Desactivar' : 'Activar'}>
                      {active ? '⏸' : '▶'}
                    </button>
                    <button onClick={() => handleDelete(p)}
                      className="bg-zinc-700 hover:bg-red-800 px-3 py-1.5 rounded-lg text-sm text-red-400" title="Eliminar"><IconTrash className="w-4 h-4 inline" /></button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── New Promotion Modal ──────────────────────────────────────────────── */}
      {showNew && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-800 rounded-2xl p-6 w-full max-w-md border border-zinc-600 max-h-[90vh] overflow-y-auto">
            <h2 className="font-bold mb-4 text-zinc-200">+ Nueva Promoción</h2>
            {PromoFormFields}
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowNew(false)} className="flex-1 py-2 border border-zinc-600 rounded-lg">Cancelar</button>
              <button onClick={handleCreate} disabled={!form.name.trim() || saving}
                className="flex-1 py-2 bg-white text-zinc-900 hover:bg-zinc-200 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Creando…' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Promotion Modal ─────────────────────────────────────────────── */}
      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-800 rounded-2xl p-6 w-full max-w-md border border-zinc-600 max-h-[90vh] overflow-y-auto">
            <h2 className="font-bold mb-4">Editar: {editing.name}</h2>
            {isQuantityForm ? PromoFormFields : (
              <p className="text-sm text-zinc-400">
                Este tipo de promoción no se edita desde esta pantalla.
              </p>
            )}
            <div className="flex gap-3 mt-5">
              <button onClick={() => setEditing(null)} className="flex-1 py-2 border border-zinc-600 rounded-lg">Cancelar</button>
              <button onClick={handleUpdate} disabled={!form.name.trim() || saving}
                className="flex-1 py-2 bg-white text-zinc-900 hover:bg-zinc-200 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
