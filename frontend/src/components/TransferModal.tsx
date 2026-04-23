import { useState } from 'react'
import { useFloorStore } from '../stores/floorStore'
import { useQueryClient } from '@tanstack/react-query'
import client from '../api/client'
import { useNavigate } from 'react-router-dom'
import { useEscKey } from '../hooks/useEscKey'

interface Props {
  ticketId: string
  currentResourceCode: string
  onClose: () => void
}

interface TransferResult {
  fromCode: string
  toCode: string
  toType: string
}

export default function TransferModal({ ticketId, currentResourceCode, onClose }: Props) {
  const resources = useFloorStore((s) => s.resources)
  const setResources = useFloorStore((s) => s.setResources)
  const [loading, setLoading] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [result, setResult] = useState<TransferResult | null>(null)
  const navigate = useNavigate()
  useEscKey(onClose)
  const qc = useQueryClient()

  const available = resources.filter(
    (r) => r.code !== currentResourceCode && r.is_active !== false
  )
  const poolTables = available.filter((r) => r.type === 'POOL_TABLE')
  const regularTables = available.filter((r) => r.type === 'REGULAR_TABLE')
  const barSeats = available.filter((r) => r.type === 'BAR_SEAT')

  const handleTransfer = async (target: typeof resources[0]) => {
    if (loading) return
    setLoading(true)
    setLoadingId(target.id)
    try {
      await client.post(`/tickets/${ticketId}/transfer`, { target_resource_id: target.id })

      // Hard refresh both ticket cache and floor store before showing result
      const [freshTicket, freshResources] = await Promise.all([
        client.get(`/tickets/${ticketId}`).then((r) => r.data),
        client.get('/resources').then((r) => r.data),
      ])
      // Use exact same key as TicketPage: ['ticket', id]
      qc.setQueryData(['ticket', ticketId], freshTicket)
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] })
      qc.setQueryData(['resources'], freshResources)
      setResources(freshResources)

      setResult({ fromCode: currentResourceCode, toCode: target.code, toType: target.type })
    } catch (err: any) {
      const msg = err.response?.data?.message || err.response?.data?.error || 'Transfer failed'
      // show inline error — no toast, keep modal open
      alert(msg)
    } finally {
      setLoading(false)
      setLoadingId(null)
    }
  }

  const handleDone = () => {
    onClose()
    navigate('/floor')
  }

  // ── Success screen ──────────────────────────────────────────────────────────
  if (result) {
    const typeLabel =
      result.toType === 'POOL_TABLE' ? '🎱 Mesa de Billar' :
      result.toType === 'REGULAR_TABLE' ? '🪑 Mesa Regular' : '🍺 Asiento de Bar'
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
        <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-green-700 shadow-2xl shadow-green-900/40">
          <div className="bg-green-700/30 rounded-t-2xl p-6 text-center border-b border-green-700">
            <div className="text-5xl mb-3">✅</div>
            <div className="text-2xl font-extrabold text-green-400">¡Transferencia Completada!</div>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-center gap-4 text-xl font-bold">
              <span className="bg-slate-700 rounded-xl px-4 py-2 text-red-300">{result.fromCode}</span>
              <span className="text-slate-400 text-2xl">→</span>
              <span className="bg-slate-700 rounded-xl px-4 py-2 text-green-300">{result.toCode}</span>
            </div>
            <div className="text-center text-slate-400 text-sm">{typeLabel}</div>
            <div className="bg-slate-700/50 rounded-xl p-3 text-sm text-slate-300 space-y-1">
              <div>✓ Artículos e historial conservados</div>
              {result.toType === 'POOL_TABLE' && <div>✓ Temporizador iniciado en {result.toCode}</div>}
              {result.fromCode.startsWith('PT') && result.toType !== 'POOL_TABLE' && (
                <div>✓ Tiempo de billar facturado al ticket</div>
              )}
              <div>✓ Mapa de piso actualizado</div>
            </div>
            <button
              onClick={handleDone}
              className="w-full py-3 bg-green-600 hover:bg-green-500 rounded-xl font-bold text-lg transition-colors"
            >
              Ver Ticket →
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Picker screen ───────────────────────────────────────────────────────────
  const ResourceBtn = ({ r }: { r: typeof resources[0] }) => {
    const busy = loadingId === r.id
    const available = r.status === 'AVAILABLE'
    return (
      <button
        onClick={() => available && !loading && handleTransfer(r)}
        disabled={!available || loading}
        className={`relative p-3 rounded-xl text-left border-2 transition-all ${
          busy ? 'border-sky-400 bg-sky-900/30' :
          available ? 'border-slate-600 bg-slate-700 hover:border-sky-400 hover:bg-slate-600 cursor-pointer' :
          'border-slate-700 bg-slate-900 opacity-40 cursor-not-allowed'
        }`}
      >
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-sky-900/60">
            <span className="text-sky-300 text-xs font-bold animate-pulse">Moviendo…</span>
          </div>
        )}
        <div className="font-bold text-base">{r.code}</div>
        <div className="text-xs mt-0.5 font-medium">
          {available
            ? <span className="text-green-400">✓ Disponible</span>
            : <span className="text-red-400">✗ En Uso</span>}
        </div>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col border border-slate-600 shadow-xl">
        {/* Header */}
        <div className="p-5 border-b border-slate-700">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold">Transferir Ticket</h2>
              <p className="text-slate-400 text-sm mt-0.5">
                Moviendo ticket de <span className="text-white font-semibold">{currentResourceCode}</span> — selecciona destino
              </p>
            </div>
            <button onClick={onClose} disabled={loading} className="text-slate-500 hover:text-white text-2xl leading-none ml-3">×</button>
          </div>
        </div>

        {/* Resource groups */}
        <div className="overflow-y-auto p-4 space-y-5 flex-1">
          {poolTables.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 uppercase tracking-widest mb-2 font-semibold">🎱 Mesas de Billar</div>
              <div className="grid grid-cols-3 gap-2">
                {poolTables.map((r) => <ResourceBtn key={r.id} r={r} />)}
              </div>
            </div>
          )}
          {regularTables.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 uppercase tracking-widest mb-2 font-semibold">🪑 Mesas Regulares</div>
              <div className="grid grid-cols-3 gap-2">
                {regularTables.map((r) => <ResourceBtn key={r.id} r={r} />)}
              </div>
            </div>
          )}
          {barSeats.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 uppercase tracking-widest mb-2 font-semibold">🍺 Asientos de Bar</div>
              <div className="grid grid-cols-3 gap-2">
                {barSeats.map((r) => <ResourceBtn key={r.id} r={r} />)}
              </div>
            </div>
          )}
          {available.length === 0 && (
            <div className="text-center py-8 text-slate-500">Sin otras ubicaciones disponibles</div>
          )}
        </div>

        <div className="p-4 border-t border-slate-700">
          <button onClick={onClose} disabled={loading} className="w-full py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700 disabled:opacity-50">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
