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
  status: string
  position: number
  created_at: string
  wait_seconds: number | null
  assigned_resource_code?: string
  assigned_ticket_id?: string
}

interface Props {
  poolTables: ResourceState[]
  isManager: boolean
}

/** Live elapsed timer component — counts up from created_at */
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

  const display = h > 0
    ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
    : `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`

  const color = secs > 3600
    ? 'bg-red-900 text-red-300'
    : secs > 1800
      ? 'bg-orange-900 text-orange-300'
      : 'bg-slate-700 text-slate-300'

  return (
    <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${color}`}>
      ⏱ {display}
    </span>
  )
}

export default function WaitingListPanel({ poolTables, isManager }: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [isOpen, setIsOpen] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newEntry, setNewEntry] = useState({ party_name: '', party_size: 1, notes: '' })
  const [adding, setAdding] = useState(false)
  const [assigningId, setAssigningId] = useState<string | null>(null)  // waiting entry id being assigned

  const { data: waiting = [], refetch } = useQuery<WaitingEntry[]>({
    queryKey: ['waiting-list'],
    queryFn: () => client.get('/waiting-list').then(r => r.data),
    refetchInterval: 15_000,
  })

  // Live timer: refresh wait_seconds display every 10s
  useEffect(() => {
    const interval = setInterval(() => refetch(), 10_000)
    return () => clearInterval(interval)
  }, [refetch])

  const availableTables = poolTables.filter(r => r.status === 'AVAILABLE')

  const handleAdd = async () => {
    if (!newEntry.party_name.trim()) return toast.error('Party name required')
    setAdding(true)
    try {
      await client.post('/waiting-list', newEntry)
      toast.success(`${newEntry.party_name} added to wait list`)
      setShowAdd(false)
      setNewEntry({ party_name: '', party_size: 1, notes: '' })
      refetch()
      qc.invalidateQueries({ queryKey: ['waiting-list'] })
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed')
    } finally {
      setAdding(false) }
  }

  const handleUpdateStatus = async (id: string, status: 'CANCELLED' | 'NO_SHOW') => {
    const entry = waiting.find(e => e.id === id)
    if (!confirm(`Mark "${entry?.party_name}" as ${status}?`)) return
    try {
      await client.patch(`/waiting-list/${id}/status`, { status })
      toast.success('Updated')
      refetch()
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed')
    }
  }

  const handleAssign = async (entryId: string, resourceId: string) => {
    try {
      const res = await client.post(`/waiting-list/${entryId}/assign`, { resource_id: resourceId })
      const ticket = res.data.ticket
      toast.success(`Assigned! Ticket opened.`)
      setAssigningId(null)
      refetch()
      qc.invalidateQueries({ queryKey: ['resources'] })
      navigate(`/ticket/${ticket.id}`)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to assign')
    }
  }

  const handleMove = async (id: string, direction: 'up' | 'down') => {
    try {
      await client.patch(`/waiting-list/${id}/move`, { direction })
      refetch()
    } catch { toast.error('Failed') }
  }

  const count = waiting.length

  return (
    <div className="mb-6">
      {/* Header bar */}
      <div
        className="flex items-center justify-between cursor-pointer mb-2"
        onClick={() => setIsOpen(o => !o)}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-slate-300 uppercase tracking-wide">
            ⏳ Waiting List
          </h2>
          {count > 0 && (
            <span className="bg-yellow-500 text-black text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
              {count} waiting
            </span>
          )}
          {availableTables.length > 0 && count > 0 && (
            <span className="bg-green-700 text-green-200 text-xs font-semibold px-2 py-0.5 rounded-full">
              {availableTables.length} table{availableTables.length > 1 ? 's' : ''} free!
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={e => { e.stopPropagation(); setShowAdd(true) }}
            className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold px-3 py-1.5 rounded-lg text-sm"
          >
            + Add to List
          </button>
          <span className="text-slate-400 text-lg">{isOpen ? '▲' : '▼'}</span>
        </div>
      </div>

      {isOpen && (
        <div className="bg-slate-900 rounded-xl border border-slate-700 overflow-hidden">
          {count === 0 ? (
            <div className="p-6 text-center text-slate-500">
              <div className="text-3xl mb-2">🎱</div>
              <p>No one waiting right now</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-700">
              {waiting.map((entry) => (
                <div key={entry.id} className="p-4">
                  <div className="flex items-start gap-4">
                    {/* Position badge */}
                    <div className="w-10 h-10 rounded-full bg-yellow-600 text-black font-black text-lg flex items-center justify-center flex-shrink-0">
                      {entry.position}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-white text-lg">{entry.party_name}</span>
                        <span className="text-slate-400 text-sm">
                          👥 {entry.party_size} {entry.party_size === 1 ? 'person' : 'people'}
                        </span>
                        {entry.created_at && (
                          <WaitTimer createdAt={entry.created_at} />
                        )}
                      </div>
                      {entry.notes && (
                        <p className="text-slate-400 text-sm mt-0.5 truncate">{entry.notes}</p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-1.5 flex-shrink-0">
                      {/* Assign button (only when tables free) */}
                      {availableTables.length > 0 ? (
                        <button
                          onClick={() => setAssigningId(entry.id)}
                          className="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap"
                        >
                          🎱 Assign Table
                        </button>
                      ) : (
                        <span className="text-slate-600 text-xs px-3 py-1.5">No tables free</span>
                      )}

                      <div className="flex gap-1">
                        {isManager && (
                          <>
                            <button
                              onClick={() => handleMove(entry.id, 'up')}
                              disabled={entry.position === 1}
                              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-30 px-2 py-1 rounded text-xs"
                            >↑</button>
                            <button
                              onClick={() => handleMove(entry.id, 'down')}
                              disabled={entry.position === count}
                              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-30 px-2 py-1 rounded text-xs"
                            >↓</button>
                          </>
                        )}
                        <button
                          onClick={() => handleUpdateStatus(entry.id, 'NO_SHOW')}
                          className="bg-slate-700 hover:bg-yellow-800 px-2 py-1 rounded text-xs text-yellow-400"
                          title="No show"
                        >👻</button>
                        <button
                          onClick={() => handleUpdateStatus(entry.id, 'CANCELLED')}
                          className="bg-slate-700 hover:bg-red-900 px-2 py-1 rounded text-xs text-red-400"
                          title="Cancel"
                        >✕</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Add to Wait List Modal ─────────────────────────────────────────── */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">Add to Wait List</h2>
              <p className="text-slate-400 text-sm mt-1">
                {availableTables.length === 0
                  ? 'All pool tables occupied — add party to queue'
                  : `${availableTables.length} table(s) available — or queue if preferred`}
              </p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Party / Guest Name *</label>
                <input
                  value={newEntry.party_name}
                  onChange={e => setNewEntry({ ...newEntry, party_name: e.target.value })}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-lg"
                  placeholder="e.g. López, Table 4, Carlos..."
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Party Size</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5, 6].map(n => (
                    <button
                      key={n}
                      onClick={() => setNewEntry({ ...newEntry, party_size: n })}
                      className={`flex-1 py-2 rounded-lg border text-sm font-bold transition-colors ${
                        newEntry.party_size === n
                          ? 'bg-sky-700 border-sky-500 text-white'
                          : 'bg-slate-700 border-slate-600 text-slate-300'
                      }`}
                    >{n}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Notes (optional)</label>
                <input
                  value={newEntry.notes}
                  onChange={e => setNewEntry({ ...newEntry, notes: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="e.g. birthday, regulars, prefers PT2..."
                />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button
                onClick={() => { setShowAdd(false); setNewEntry({ party_name: '', party_size: 1, notes: '' }) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700"
              >Cancel</button>
              <button
                onClick={handleAdd}
                disabled={!newEntry.party_name.trim() || adding}
                className="flex-1 py-2.5 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded-xl disabled:opacity-50"
              >{adding ? 'Adding…' : 'Add to Queue'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign to Table Modal ──────────────────────────────────────────── */}
      {assigningId && (() => {
        const entry = waiting.find(e => e.id === assigningId)
        return (
          <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
              <div className="p-5 border-b border-slate-700">
                <h2 className="text-lg font-bold">Assign Pool Table</h2>
                <p className="text-slate-300 mt-1">
                  Assigning <span className="font-bold text-yellow-400">{entry?.party_name}</span>
                  {entry?.party_size ? ` · ${entry.party_size} people` : ''}
                </p>
              </div>
              <div className="p-5">
                <p className="text-slate-400 text-sm mb-3">Select an available pool table:</p>
                <div className="grid grid-cols-2 gap-3">
                  {availableTables.map(table => (
                    <button
                      key={table.id}
                      onClick={() => handleAssign(assigningId, table.id)}
                      className="bg-green-800 hover:bg-green-700 border border-green-600 rounded-xl p-4 text-center"
                    >
                      <div className="text-2xl mb-1">🎱</div>
                      <div className="font-bold text-lg">{table.code}</div>
                      <div className="text-green-300 text-xs">Available</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-5 border-t border-slate-700">
                <button
                  onClick={() => setAssigningId(null)}
                  className="w-full py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700"
                >Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
