import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import client from '../api/client'
import toast from 'react-hot-toast'
import type { ResourceState } from '../stores/floorStore'

interface WaitingEntry {
  id: string
  party_name: string
  party_size: number
  notes: string
  status: string  // WAITING | SEATED
  position: number
  created_at: string
  wait_seconds: number | null
  assigned_resource_code?: string
  assigned_ticket_id?: string
  floor_resource_code?: string
  floor_ticket_id?: string
}

interface Props {
  allResources: ResourceState[]
  isManager: boolean
}

function WaitTimer({ createdAt }: { createdAt: string }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const start = new Date(createdAt).getTime()
    const tick = () => setSecs(Math.max(0, Math.floor((Date.now() - start) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [createdAt])
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const display = h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`
  const color = secs > 3600 ? 'bg-red-900 text-red-300' : secs > 1800 ? 'bg-orange-900 text-orange-300' : 'bg-slate-700 text-slate-300'
  return <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${color}`}>⏱ {display}</span>
}

export default function WaitingListPanel({ allResources, isManager }: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [isOpen, setIsOpen] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newEntry, setNewEntry] = useState({ party_name: '', party_size: 1, notes: '' })
  const [adding, setAdding] = useState(false)
  const [assigningId, setAssigningId] = useState<string | null>(null)
  const [transferingId, setTransferingId] = useState<string | null>(null)  // SEATED → pool table
  const [showFloating, setShowFloating] = useState(false)
  const [floatingName, setFloatingName] = useState('')
  const [floatingEntryId, setFloatingEntryId] = useState<string | null>(null)

  const { data: waiting = [], refetch } = useQuery<WaitingEntry[]>({
    queryKey: ['waiting-list'],
    queryFn: () => client.get('/waiting-list').then(r => r.data),
    refetchInterval: 15_000,
  })

  useEffect(() => {
    const interval = setInterval(() => refetch(), 10_000)
    return () => clearInterval(interval)
  }, [refetch])

  // Pool tables are NOT offered via waiting list — they're assigned directly on the floor
  const floorResources   = allResources.filter(r => r.status === 'AVAILABLE' && r.is_active && !r.is_temp && r.type !== 'POOL_TABLE')
  const availableRegular = floorResources.filter(r => r.type === 'REGULAR_TABLE')
  const availableBar     = floorResources.filter(r => r.type === 'BAR_SEAT')
  const anyAvailable     = floorResources.length > 0
  // Pool tables available for SEATED → transfer
  const availablePool    = allResources.filter(r => r.status === 'AVAILABLE' && r.is_active && r.type === 'POOL_TABLE')

  const handleAdd = async () => {
    if (!newEntry.party_name.trim()) return toast.error('Nombre requerido')
    setAdding(true)
    try {
      const res = await client.post('/waiting-list', newEntry)
      const created = res.data
      toast.success(`${newEntry.party_name} agregado`)
      setShowAdd(false)
      setNewEntry({ party_name: '', party_size: 1, notes: '' })
      refetch()
      qc.invalidateQueries({ queryKey: ['waiting-list'] })
      // Immediately open floor assignment for the new entry
      if (floorResources.length === 0) {
        // No free tables — go straight to floating table
        setFloatingEntryId(created.id)
        setFloatingName(created.party_name)
        setShowFloating(true)
      } else {
        setAssigningId(created.id)
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Error')
    } finally { setAdding(false) }
  }

  const handleUpdateStatus = async (id: string, status: 'CANCELLED' | 'NO_SHOW') => {
    const entry = waiting.find(e => e.id === id)
    if (!confirm(`Marcar "${entry?.party_name}" como ${status}?`)) return
    try {
      await client.patch(`/waiting-list/${id}/status`, { status })
      toast.success('Actualizado')
      refetch()
    } catch (err: any) { toast.error(err.response?.data?.error || 'Error') }
  }

  const handleAssign = async (entryId: string, resourceId: string) => {
    try {
      const res = await client.post(`/waiting-list/${entryId}/assign`, { resource_id: resourceId })
      const ticket = res.data.ticket
      toast.success('Asignado!')
      setAssigningId(null)
      refetch()
      qc.invalidateQueries({ queryKey: ['resources'] })
      navigate(`/ticket/${ticket.id}`)
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error al asignar') }
  }

  const handleCreateFloating = async () => {
    if (!floatingEntryId) return
    try {
      const name = floatingName.trim() || 'Flotante'
      // Auto-generate a short unique code
      const code = `T-${Date.now().toString(36).slice(-4).toUpperCase()}`
      const res = await client.post('/resources', {
        code, name,
        type: 'REGULAR_TABLE', is_temp: true,
      })
      qc.invalidateQueries({ queryKey: ['resources'] })
      await handleAssign(floatingEntryId, res.data.id)
      setShowFloating(false); setFloatingName(''); setFloatingEntryId(null)
    } catch (err: any) { toast.error(err.response?.data?.error || 'Error') }
  }

  const handleMove = async (id: string, direction: 'up' | 'down') => {
    try { await client.patch(`/waiting-list/${id}/move`, { direction }); refetch() }
    catch { toast.error('Error') }
  }

  const handleTransferToPool = async (entryId: string, poolResourceId: string) => {
    try {
      const res = await client.post(`/waiting-list/${entryId}/transfer-to-pool`, {
        pool_resource_id: poolResourceId,
      })
      const ticket = res.data.ticket
      toast.success('Transferido a mesa de pool! 🎱')
      setTransferingId(null)
      refetch()
      qc.invalidateQueries({ queryKey: ['resources'] })
      navigate(`/ticket/${ticket.id}`)
    } catch (err: any) { toast.error(err.response?.data?.message || 'Error al transferir') }
  }

  const count = waiting.length

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between cursor-pointer mb-2" onClick={() => setIsOpen(o => !o)}>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-bold text-slate-300 uppercase tracking-wide">⏳ Waiting List</h2>
          {count > 0 && <span className="bg-yellow-500 text-black text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">{count} waiting</span>}
          {anyAvailable && count > 0 && <span className="bg-green-700 text-green-200 text-xs font-semibold px-2 py-0.5 rounded-full">{floorResources.length} mesas libres</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={e => { e.stopPropagation(); setShowAdd(true) }}
            className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold px-3 py-1.5 rounded-lg text-sm">+ Add</button>
          <span className="text-slate-400 text-lg">{isOpen ? '▲' : '▼'}</span>
        </div>
      </div>

      {isOpen && (
        <div className="bg-slate-900 rounded-xl border border-slate-700 overflow-hidden">
          {count === 0 ? (
            <div className="p-6 text-center text-slate-500"><div className="text-3xl mb-2">🎱</div><p>Nadie esperando</p></div>
          ) : (
            <div className="divide-y divide-slate-700">
              {waiting.map(entry => (
                <div key={entry.id} className={`p-4 ${entry.status === 'SEATED' ? 'bg-sky-950/40' : ''}`}>
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-full font-black text-base flex items-center justify-center flex-shrink-0 ${entry.status === 'SEATED' ? 'bg-sky-600 text-white' : 'bg-yellow-600 text-black'}`}>
                      {entry.position}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-white">{entry.party_name}</span>
                        <span className="text-slate-400 text-xs">👥 {entry.party_size}</span>
                        {entry.created_at && <WaitTimer createdAt={entry.created_at} />}
                      </div>
                      {/* Floor table badge for SEATED entries */}
                      {entry.status === 'SEATED' && entry.floor_resource_code && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="bg-sky-800 text-sky-200 text-xs font-semibold px-2 py-0.5 rounded-full">
                            🪑 En {entry.floor_resource_code}
                          </span>
                          <span className="text-sky-500 text-xs">esperando mesa de pool</span>
                        </div>
                      )}
                      {entry.notes && <p className="text-slate-400 text-xs mt-0.5 truncate">{entry.notes}</p>}
                    </div>
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      {/* SEATED entries: show "Transfer to Pool" button */}
                      {entry.status === 'SEATED' ? (
                        <button onClick={() => setTransferingId(entry.id)}
                          className="bg-green-700 hover:bg-green-600 px-3 py-1.5 rounded-lg text-xs font-bold">
                          🎱 A Pool
                        </button>
                      ) : (
                        <button onClick={() => setAssigningId(entry.id)}
                          className="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-xs font-bold">🪑 Asignar</button>
                      )}
                      <div className="flex gap-1">
                        {isManager && (
                          <>
                            <button onClick={() => handleMove(entry.id, 'up')} disabled={entry.position === 1}
                              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-30 px-2 py-1 rounded text-xs">↑</button>
                            <button onClick={() => handleMove(entry.id, 'down')} disabled={entry.position === count}
                              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-30 px-2 py-1 rounded text-xs">↓</button>
                          </>
                        )}
                        <button onClick={() => handleUpdateStatus(entry.id, 'NO_SHOW')}
                          className="bg-slate-700 hover:bg-yellow-800 px-2 py-1 rounded text-xs text-yellow-400">👻</button>
                        <button onClick={() => handleUpdateStatus(entry.id, 'CANCELLED')}
                          className="bg-slate-700 hover:bg-red-900 px-2 py-1 rounded text-xs text-red-400">✕</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add Modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700"><h2 className="text-lg font-bold">Agregar a Lista de Espera</h2></div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Nombre *</label>
                <input value={newEntry.party_name} onChange={e => setNewEntry({...newEntry, party_name: e.target.value})}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-lg"
                  placeholder="e.g. López, Mesa 4..." autoFocus />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Personas</label>
                <div className="flex gap-2">
                  {[1,2,3,4,5,6].map(n => (
                    <button key={n} onClick={() => setNewEntry({...newEntry, party_size: n})}
                      className={`flex-1 py-2 rounded-lg border text-sm font-bold ${newEntry.party_size === n ? 'bg-sky-700 border-sky-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-300'}`}>{n}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Notas (opcional)</label>
                <input value={newEntry.notes} onChange={e => setNewEntry({...newEntry, notes: e.target.value})}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="cumpleaños, regulares..." />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button onClick={() => { setShowAdd(false); setNewEntry({party_name:'',party_size:1,notes:''}) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">Cancelar</button>
              <button onClick={handleAdd} disabled={!newEntry.party_name.trim() || adding}
                className="flex-1 py-2.5 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded-xl disabled:opacity-50">
                {adding ? 'Agregando…' : 'Agregar'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Modal */}
      {assigningId && (() => {
        const entry = waiting.find(e => e.id === assigningId)
        return (
          <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl max-h-[90vh] flex flex-col">
              <div className="p-4 border-b border-slate-700">
                <h2 className="text-lg font-bold">Asignar Mesa</h2>
                <p className="text-slate-300 text-sm mt-0.5">
                  <span className="font-bold text-yellow-400">{entry?.party_name}</span>
                  {entry?.party_size ? ` · ${entry.party_size} personas` : ''}
                </p>
              </div>
              <div className="p-4 space-y-4 overflow-y-auto flex-1">
                {availableRegular.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-2">🪑 Mesas disponibles</p>
                    <div className="grid grid-cols-3 gap-2">
                      {availableRegular.map(r => (
                        <button key={r.id} onClick={() => handleAssign(assigningId, r.id)}
                          className="bg-sky-900 hover:bg-sky-800 border border-sky-700 rounded-xl p-3 text-center active:scale-95 transition-transform">
                          <div className="text-xl mb-0.5">🪑</div>
                          <div className="font-bold text-sm">{r.code}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {availableBar.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-2">🍺 Barra disponible</p>
                    <div className="grid grid-cols-3 gap-2">
                      {availableBar.map(r => (
                        <button key={r.id} onClick={() => handleAssign(assigningId, r.id)}
                          className="bg-purple-900 hover:bg-purple-800 border border-purple-700 rounded-xl p-3 text-center active:scale-95 transition-transform">
                          <div className="text-xl mb-0.5">🍺</div>
                          <div className="font-bold text-sm">{r.code}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {!anyAvailable && (
                  <div className="py-6 text-center">
                    <div className="text-3xl mb-2">😔</div>
                    <p className="text-slate-400 font-semibold">No hay mesas disponibles</p>
                    <p className="text-slate-500 text-xs mt-1">Crea una mesa flotante para asignar</p>
                  </div>
                )}
                <div className="border-t border-slate-700 pt-3">
                  <p className="text-xs text-slate-400 mb-2">¿No encuentras la mesa en el mapa?</p>
                  <button onClick={() => {
                    const e = waiting.find(w => w.id === assigningId)
                    setFloatingEntryId(assigningId)
                    setFloatingName(e?.party_name || '')
                    setAssigningId(null)
                    setShowFloating(true)
                  }}
                    className="w-full py-2.5 bg-amber-700 hover:bg-amber-600 rounded-xl font-semibold text-sm">
                    ➕ Crear mesa flotante</button>
                </div>
              </div>
              <div className="p-4 border-t border-slate-700 flex gap-3">
                <button onClick={() => setAssigningId(null)}
                  className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">Omitir por ahora</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Floating Table Modal */}
      {showFloating && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">🪑 Mesa Temporal</h2>
              <p className="text-slate-400 text-sm mt-1">
                {floorResources.length === 0
                  ? 'Todas las mesas están ocupadas.'
                  : '¿Prefieres crear una mesa temporal?'}
              </p>
            </div>
            <div className="p-5">
              <div className="bg-slate-700/50 rounded-xl p-4 text-center border border-slate-600">
                <div className="text-3xl mb-2">🪑</div>
                <p className="text-white font-bold text-lg">{floatingName || 'Cliente'}</p>
                <p className="text-slate-400 text-xs mt-1">Se creará una mesa temporal y se abrirá la cuenta.</p>
                <p className="text-slate-500 text-xs mt-0.5">Se elimina automáticamente al transferir o cerrar.</p>
              </div>
              {floorResources.length > 0 && (
                <button
                  onClick={() => { setShowFloating(false); setFloatingName(''); setAssigningId(floatingEntryId); setFloatingEntryId(null) }}
                  className="w-full mt-3 py-2 text-sky-400 hover:text-sky-300 text-sm underline">
                  ← Ver mesas disponibles ({floorResources.length})
                </button>
              )}
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button onClick={() => { setShowFloating(false); setFloatingName(''); setFloatingEntryId(null) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700 text-sm">
                Omitir</button>
              <button onClick={handleCreateFloating}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-black font-bold rounded-xl">
                Crear Mesa ✓</button>
            </div>
          </div>
        </div>
      )}
      {/* Transfer to Pool Modal */}
      {transferingId && (() => {
        const entry = waiting.find(e => e.id === transferingId)
        return (
          <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl max-h-[90vh] flex flex-col">
              <div className="p-4 border-b border-slate-700">
                <h2 className="text-lg font-bold">🎱 Transferir a Mesa de Pool</h2>
                <p className="text-slate-300 text-sm mt-0.5">
                  <span className="font-bold text-yellow-400">{entry?.party_name}</span>
                  {entry?.floor_resource_code && (
                    <span className="text-slate-400"> · desde {entry.floor_resource_code}</span>
                  )}
                </p>
                <p className="text-slate-500 text-xs mt-1">Se libera la mesa actual y se abre el timer de pool.</p>
              </div>
              <div className="p-4 overflow-y-auto flex-1">
                {availablePool.length > 0 ? (
                  <div>
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-3">Mesas de pool disponibles</p>
                    <div className="grid grid-cols-2 gap-3">
                      {availablePool.map(r => (
                        <button key={r.id} onClick={() => handleTransferToPool(transferingId, r.id)}
                          className="bg-green-800 hover:bg-green-700 border border-green-600 rounded-xl p-4 text-center active:scale-95 transition-transform">
                          <div className="text-3xl mb-1">🎱</div>
                          <div className="font-bold text-lg">{r.code}</div>
                          <div className="text-green-300 text-xs mt-0.5">Disponible</div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center">
                    <div className="text-4xl mb-3">😔</div>
                    <p className="text-slate-400 font-semibold">No hay mesas de pool disponibles</p>
                    <p className="text-slate-500 text-xs mt-1">Espera a que se libere una.</p>
                  </div>
                )}
              </div>
              <div className="p-4 border-t border-slate-700">
                <button onClick={() => setTransferingId(null)}
                  className="w-full py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700">Cancelar</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
