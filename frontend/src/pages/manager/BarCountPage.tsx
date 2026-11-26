/**
 * Conteo de barra (batch E2, step 2) — MANAGER / ADMIN.
 *
 * Blind count: for every spirit, each OPEN bottle is marked Vacía / ¼ / ½ / ¾ /
 * Llena (or exact ml) and the SEALED bottles on the shelf are counted. The
 * screen never shows what the system expects. On save the differences go to
 * the ledger; only the owner sees them (here, right after saving, and in
 * Reportes → Inventario → Conteos de barra).
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import NavBar from '../../components/NavBar'
import client from '../../api/client'
import { useAuthStore } from '../../stores/authStore'
import { formatMXN } from '../../utils/money'

type Fraction = 'EMPTY' | 'QUARTER' | 'HALF' | 'THREE_QUARTERS' | 'FULL'
const FRACTIONS: [Fraction, string][] = [
  ['EMPTY', 'Vacía'], ['QUARTER', '¼'], ['HALF', '½'], ['THREE_QUARTERS', '¾'], ['FULL', 'Llena'],
]

interface OpenBottle { id: string; size_ml: number; opened_at: string | null }
interface Spirit {
  bottle_item_id: string; name: string; shot_item_id: string
  bottle_ml: number; pour_ml: number | null; open_bottles: OpenBottle[]
}
type BottleEntry = { fraction?: Fraction; ml?: string }

const since = (iso: string | null) => {
  if (!iso) return ''
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000)
  return h < 1 ? 'abierta hace minutos' : h < 48 ? `abierta hace ${h} h` : `abierta hace ${Math.round(h / 24)} días`
}

export default function BarCountPage() {
  const qc = useQueryClient()
  const isOwner = useAuthStore(s => s.user?.role) === 'ADMIN'
  const { data, isLoading, isError, refetch } = useQuery<{ spirits: Spirit[] }>({
    queryKey: ['bar-count-sheet'],
    queryFn: () => client.get('/inventory/bar-count').then(r => r.data),
  })
  const spirits = data?.spirits ?? []

  const [bottles, setBottles] = useState<Record<string, BottleEntry>>({})
  const [sealed, setSealed] = useState<Record<string, string>>({})
  const [skip, setSkip] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<any>(null)

  const counted = (sp: Spirit) => !skip[sp.shot_item_id]
  const done = (sp: Spirit) =>
    sp.open_bottles.every(b => bottles[b.id]?.fraction || (bottles[b.id]?.ml ?? '') !== '') &&
    (sealed[sp.shot_item_id] ?? '') !== ''
  const pending = useMemo(() => spirits.filter(sp => counted(sp) && !done(sp)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spirits, bottles, sealed, skip])

  const submit = async () => {
    if (pending) return toast.error(`Faltan ${pending} licor(es) por contar (o márcalos "No contar")`)
    const payload = spirits.filter(counted).map(sp => ({
      shot_item_id: sp.shot_item_id,
      bottles: sp.open_bottles.map(b => {
        const e = bottles[b.id] ?? {}
        return (e.ml ?? '') !== '' ? { id: b.id, ml: parseFloat(e.ml!) } : { id: b.id, fraction: e.fraction }
      }),
      sealed: parseInt(sealed[sp.shot_item_id]),
    }))
    if (!payload.length) return toast.error('No hay nada que contar')
    setSaving(true)
    try {
      const r = await client.post('/inventory/bar-count', { spirits: payload, notes: notes.trim() || null })
      toast.success('Conteo guardado')
      setResult(r.data)
      qc.invalidateQueries({ queryKey: ['inventory'] })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo guardar el conteo')
      refetch()
    } finally { setSaving(false) }
  }

  const btn = (on: boolean) =>
    `px-2.5 py-1.5 rounded-lg text-sm border transition-colors ${on
      ? 'bg-amber-600 border-amber-500 text-white font-semibold'
      : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500'}`

  return (
    <div className="min-h-screen bg-slate-950 page-root text-slate-100">
      <NavBar />
      <div className="max-w-3xl mx-auto p-4">
        <div className="flex items-center gap-3 mb-2">
          <Link to="/manager/inventory" className="text-sm text-slate-400 hover:text-sky-400">← Inventario</Link>
          <h1 className="text-xl font-bold">🍾 Conteo de barra</h1>
        </div>

        {result ? (
          <div className="space-y-4">
            <div className="bg-emerald-950/40 border border-emerald-700 rounded-xl p-4">
              <div className="font-semibold">Conteo guardado.</div>
              {!isOwner && <div className="text-sm text-slate-300 mt-1">El dueño verá las diferencias en Reportes.</div>}
            </div>
            {isOwner && result.lines && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
                <div className="px-4 py-3 flex justify-between border-b border-slate-800">
                  <span className="font-semibold">Diferencias</span>
                  <span className={`font-mono font-bold ${result.total_variance_cents < 0 ? 'text-red-400' : 'text-emerald-300'}`}>
                    {formatMXN(result.total_variance_cents)}
                  </span>
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="text-slate-400 text-xs">
                    <th className="p-2 text-left">Artículo</th><th className="p-2 text-right">Sistema</th>
                    <th className="p-2 text-right">Contado</th><th className="p-2 text-right">Diferencia</th>
                    <th className="p-2 text-right">$</th></tr></thead>
                  <tbody>{result.lines.map((l: any, i: number) => {
                    const sp = spirits.find(s => s.shot_item_id === l.inventory_item_id || s.bottle_item_id === l.inventory_item_id)
                    const unit = l.kind === 'OPEN' ? 'ml' : 'bot.'
                    return (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="p-2">{sp?.name ?? '—'} <span className="text-slate-500 text-xs">{l.kind === 'OPEN' ? 'abiertas' : 'cerradas'}</span></td>
                        <td className="p-2 text-right font-mono">{l.expected} {unit}</td>
                        <td className="p-2 text-right font-mono">{l.counted} {unit}</td>
                        <td className={`p-2 text-right font-mono ${l.variance < 0 ? 'text-red-400' : l.variance > 0 ? 'text-emerald-300' : 'text-slate-500'}`}>
                          {l.variance > 0 ? '+' : ''}{l.variance} {unit}
                          {l.kind === 'OPEN' && sp?.pour_ml && l.variance !== 0
                            ? <span className="text-xs text-slate-500"> ({(l.variance / sp.pour_ml).toFixed(1)} shots)</span> : null}
                        </td>
                        <td className="p-2 text-right font-mono">{formatMXN(l.variance_cents)}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            )}
            <div className="flex gap-3">
              <Link to="/manager/inventory" className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm">Volver a inventario</Link>
              {isOwner && <Link to="/manager/reportes/inventario/conteos" className="px-4 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 text-sm">Ver historial de conteos</Link>}
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-400 mb-4">
              Anota lo que ves, sin consultar el sistema: cuánto queda en cada botella abierta y cuántas
              botellas cerradas hay en el estante.
            </p>
            {isLoading && <div className="text-slate-500 p-6 text-center">Cargando…</div>}
            {isError && <div className="text-red-300 p-6 text-center">No se pudo cargar la lista. <button className="underline" onClick={() => refetch()}>Reintentar</button></div>}
            {!isLoading && !spirits.length && <div className="text-slate-500 p-6 text-center">No hay licores que se abran por botella.</div>}

            <div className="space-y-3">
              {spirits.map(sp => (
                <div key={sp.shot_item_id}
                  className={`rounded-xl border p-3 ${skip[sp.shot_item_id] ? 'border-slate-800 opacity-50'
                    : done(sp) ? 'border-emerald-800 bg-emerald-950/20' : 'border-slate-700 bg-slate-900'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold">{sp.name}</div>
                    <label className="text-xs text-slate-400 flex items-center gap-1">
                      <input type="checkbox" checked={!!skip[sp.shot_item_id]}
                        onChange={e => setSkip({ ...skip, [sp.shot_item_id]: e.target.checked })} />
                      No contar
                    </label>
                  </div>
                  {!skip[sp.shot_item_id] && (
                    <>
                      {sp.open_bottles.length === 0 && <div className="text-xs text-slate-500 mb-2">Sin botellas abiertas.</div>}
                      {sp.open_bottles.map((b, i) => {
                        const e = bottles[b.id] ?? {}
                        return (
                          <div key={b.id} className="mb-2">
                            <div className="text-xs text-slate-400 mb-1">
                              Abierta {sp.open_bottles.length > 1 ? `#${i + 1}` : ''} · {b.size_ml} ml · {since(b.opened_at)}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {FRACTIONS.map(([f, label]) => (
                                <button key={f} type="button" className={btn(e.fraction === f && (e.ml ?? '') === '')}
                                  onClick={() => setBottles({ ...bottles, [b.id]: { fraction: f } })}>{label}</button>
                              ))}
                              <input type="number" min={0} max={b.size_ml} placeholder="ml exactos" value={e.ml ?? ''}
                                onChange={ev => setBottles({ ...bottles, [b.id]: { ml: ev.target.value } })}
                                className="w-28 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm" />
                            </div>
                          </div>
                        )
                      })}
                      <label className="text-xs text-slate-400 flex items-center gap-2 mt-2">
                        Cerradas en el estante
                        <input type="number" min={0} step={1} value={sealed[sp.shot_item_id] ?? ''}
                          onChange={e => setSealed({ ...sealed, [sp.shot_item_id]: e.target.value })}
                          className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-white" />
                      </label>
                    </>
                  )}
                </div>
              ))}
            </div>

            {spirits.length > 0 && (
              <div className="mt-4 space-y-3">
                <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notas (opcional)"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" />
                <button onClick={submit} disabled={saving}
                  className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 font-bold disabled:opacity-50">
                  {saving ? 'Guardando…' : pending ? `Faltan ${pending} por contar` : 'Guardar conteo'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
