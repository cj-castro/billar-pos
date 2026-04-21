import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import NavBar from '../components/NavBar'
import ResourceCard from '../components/ResourceCard'
import WaitingListPanel from '../components/WaitingListPanel'
import { useFloorStore } from '../stores/floorStore'
import { useAuthStore } from '../stores/authStore'
import { useEscKey } from '../hooks/useEscKey'
import client from '../api/client'
import toast from 'react-hot-toast'

export default function FloorMapPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { resources, setResources } = useFloorStore()
  const user = useAuthStore((s) => s.user)
  const isManager = user?.role === 'MANAGER' || user?.role === 'ADMIN'
  const { t } = useTranslation()

  const [openingResource, setOpeningResource] = useState<string | null>(null)
  const [showAddTable, setShowAddTable] = useState(false)
  const [newTable, setNewTable] = useState({ code: '', name: '', type: 'REGULAR_TABLE' })
  const [addingTable, setAddingTable] = useState(false)

  const { data, refetch } = useQuery({
    queryKey: ['resources'],
    queryFn: () => client.get('/resources').then((r) => r.data),
    refetchInterval: 8_000,
  })

  const { data: cashStatus } = useQuery({
    queryKey: ['cash-status'],
    queryFn: () => client.get('/cash/status').then((r) => r.data),
    refetchInterval: 30_000,
  })
  const barOpen = cashStatus?.open === true

  const { data: reopenedTickets = [] } = useQuery({
    queryKey: ['tickets-reopened'],
    queryFn: () => client.get('/tickets/reopened').then(r => r.data),
    refetchInterval: 15_000,
  })

  const { data: pendingPaymentTickets = [] } = useQuery({
    queryKey: ['tickets-pending-payment'],
    queryFn: () => client.get('/tickets/pending-payment').then(r => r.data),
    refetchInterval: 10_000,
  })

  useEffect(() => {
    if (data) setResources(data)
  }, [data])

  const [namePrompt, setNamePrompt] = useState<{ resourceId: string; code: string } | null>(null)
  const [pendingName, setPendingName] = useState('')

  useEscKey(() => {
    if (showAddTable) { setShowAddTable(false); return }
    if (namePrompt) { setNamePrompt(null); return }
  }, showAddTable || !!namePrompt)

  const handleOpenNew = (resourceId: string) => {
    const resource = resources.find(r => r.id === resourceId)
    setNamePrompt({ resourceId, code: resource?.code ?? '' })
    setPendingName('')
  }

  const confirmOpen = async (customerName: string) => {
    if (!namePrompt) return
    setOpeningResource(namePrompt.resourceId)
    setNamePrompt(null)
    try {
      if (!barOpen) { toast.error('Bar is closed. Manager must open the cash session first.'); setOpeningResource(null); return }
      const res = await client.post('/tickets', {
        resource_id: namePrompt.resourceId,
        customer_name: customerName.trim() || undefined,
      })
      navigate(`/ticket/${res.data.id}`)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to open ticket')
      refetch()
    } finally {
      setOpeningResource(null)
    }
  }

  // ── Create floating table ──────────────────────────────────────────────────
  const handleAddTable = async () => {
    if (!newTable.code.trim() || !newTable.name.trim()) return toast.error('Code and name required')
    setAddingTable(true)
    try {
      await client.post('/resources', {
        code: newTable.code.trim().toUpperCase(),
        name: newTable.name.trim(),
        type: newTable.type,
        sort_order: 99,
      })
      toast.success(`${newTable.code.toUpperCase()} added to floor`)
      setShowAddTable(false)
      setNewTable({ code: '', name: '', type: 'REGULAR_TABLE' })
      const fresh = await client.get('/resources').then(r => r.data)
      setResources(fresh)
      qc.setQueryData(['resources'], fresh)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to add table')
    } finally {
      setAddingTable(false)
    }
  }

  // ── Deactivate floating table ──────────────────────────────────────────────
  const handleRemoveTable = async (resource: typeof resources[0]) => {
    if (!confirm(`Remove "${resource.code}" from the floor? (It has no open tickets)`)) return
    try {
      await client.patch(`/resources/${resource.id}`, { is_active: false })
      toast.success(`${resource.code} removed`)
      const fresh = await client.get('/resources').then(r => r.data)
      setResources(fresh)
      qc.setQueryData(['resources'], fresh)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Cannot remove')
    }
  }

  const poolTables = resources.filter((r) => r.type === 'POOL_TABLE')
  const regularTables = resources.filter((r) => r.type === 'REGULAR_TABLE')
  const barSeats = resources.filter((r) => r.type === 'BAR_SEAT')

  // Floating = tables added dynamically (sort_order 99, not seeded tables T01–T08, Bar-01–Bar-06)
  const isFloating = (r: typeof resources[0]) => r.sort_order >= 99

  return (
    <div className="min-h-screen bg-slate-950">
      <NavBar />
      <div className="p-4 max-w-5xl mx-auto">

        {/* Bar closed banner */}
        {!barOpen && (
          <div className="mb-4 bg-red-900/60 border border-red-600 rounded-xl px-4 py-3 flex items-center justify-between">
            <div>
              <span className="font-bold text-red-300">🔒 Bar Closed</span>
              <span className="text-red-400 text-sm ml-2">No new tickets can be opened until a manager starts the cash session.</span>
            </div>
            {isManager && (
              <button onClick={() => navigate('/manager/cash')} className="bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg text-sm font-bold ml-4 whitespace-nowrap">
                Open Bar →
              </button>
            )}
          </div>
        )}

        {/* Floor action bar */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-slate-400 text-sm">
            {resources.filter(r => r.status === 'IN_USE').length} in use
            &nbsp;·&nbsp;
            {resources.filter(r => r.status === 'AVAILABLE').length} available
          </span>
        </div>

        {/* Pool Tables */}
        <div className="mb-6">
          <h2 className="text-lg font-bold text-slate-300 mb-3 uppercase tracking-wide">🎱 {t('floor.poolTables')}</h2>
          <div className="flex flex-wrap gap-3">
            {poolTables.map((r) => (
              <ResourceCard key={r.id} resource={r} onOpenNew={handleOpenNew} barOpen={barOpen} />
            ))}
          </div>
        </div>

        {/* Waiting List */}
        <WaitingListPanel poolTables={poolTables} isManager={isManager} />

        {/* Regular Tables */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-slate-300 uppercase tracking-wide">🪑 {t('floor.floorTables')}</h2>
          </div>
          {isManager && (
            <button
              onClick={() => setShowAddTable(true)}
              className="flex items-center gap-2 bg-sky-700 hover:bg-sky-600 px-4 py-2 rounded-xl text-sm font-semibold mb-3"
            >
              + Floating Table
            </button>
          )}
          <div className="flex flex-wrap gap-3">
            {regularTables.map((r) => (
              <div key={r.id} className="relative group">
                <ResourceCard resource={r} onOpenNew={handleOpenNew} barOpen={barOpen} />
                {isManager && isFloating(r) && r.status === 'AVAILABLE' && (
                  <button
                    onClick={() => handleRemoveTable(r)}
                    title="Remove floating table"
                    className="absolute -top-2 -right-2 w-5 h-5 bg-red-600 hover:bg-red-500 rounded-full text-xs font-bold flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >×</button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Bar Seats */}
        <div className="mb-6">
          <h2 className="text-lg font-bold text-slate-300 mb-3 uppercase tracking-wide">🍺 {t('floor.barSeats')}</h2>
          <div className="flex flex-wrap gap-3">
            {barSeats.map((r) => (
              <div key={r.id} className="relative group">
                <ResourceCard resource={r} onOpenNew={handleOpenNew} barOpen={barOpen} />
                {isManager && isFloating(r) && r.status === 'AVAILABLE' && (
                  <button
                    onClick={() => handleRemoveTable(r)}
                    title="Remove floating seat"
                    className="absolute -top-2 -right-2 w-5 h-5 bg-red-600 hover:bg-red-500 rounded-full text-xs font-bold flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >×</button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Pending Payment / Cuenta Solicitada */}
        {(pendingPaymentTickets as any[]).length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-bold text-amber-400 mb-3 uppercase tracking-wide flex items-center gap-2">
              🧾 Cuenta Solicitada
              <span className="bg-amber-700 text-amber-200 text-xs px-2 py-0.5 rounded-full">{(pendingPaymentTickets as any[]).length}</span>
            </h2>
            <div className="flex flex-wrap gap-3">
              {(pendingPaymentTickets as any[]).map((t: any) => (
                <div
                  key={t.id}
                  className="bg-amber-900/40 border-2 border-amber-600 rounded-2xl p-4 text-left min-w-[160px] max-w-[200px]"
                >
                  <button
                    onClick={() => navigate(`/ticket/${t.id}`)}
                    className="w-full text-left"
                  >
                    <div className="text-xs text-amber-400 font-semibold mb-1">💳 PAGO PENDIENTE</div>
                    <div className="font-bold text-white text-sm">{t.customer_name || '(sin nombre)'}</div>
                    <div className="text-xs text-amber-300 mt-1">
                      {t.resource_code || '—'}
                      {t.resource_type === 'POOL_TABLE' ? ' 🎱' : t.resource_type === 'BAR_SEAT' ? ' 🍺' : ' 🪑'}
                    </div>
                    <div className="text-xs text-amber-200 mt-1 font-mono font-bold">
                      ${((t.total_cents || 0) / 100).toFixed(2)}
                    </div>
                  </button>
                  <div className="flex gap-1 mt-3">
                    <button
                      onClick={async () => {
                        try {
                          const { printReceipt } = await import('../utils/printReceipt')
                          const res = await client.get(`/tickets/${t.id}`)
                          printReceipt(res.data, undefined, true)
                        } catch { toast.error('No se pudo reimprimir') }
                      }}
                      className="flex-1 py-1.5 bg-amber-700 hover:bg-amber-600 rounded-lg text-xs font-semibold"
                    >🖨️ Reimprimir</button>
                    <button
                      onClick={() => navigate(`/ticket/${t.id}`)}
                      className="flex-1 py-1.5 bg-green-700 hover:bg-green-600 rounded-lg text-xs font-semibold"
                    >💳 Cobrar</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Re-opened Tabs */}
        {(reopenedTickets as any[]).length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-bold text-orange-400 mb-3 uppercase tracking-wide flex items-center gap-2">
              ⚠️ {t('floor.reopenedTabs')}
              <span className="bg-orange-700 text-orange-200 text-xs px-2 py-0.5 rounded-full">{(reopenedTickets as any[]).length}</span>
            </h2>
            <div className="flex flex-wrap gap-3">
              {(reopenedTickets as any[]).map((t: any) => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/ticket/${t.id}`)}
                  className="bg-orange-900/50 border-2 border-orange-600 hover:border-orange-400 rounded-2xl p-4 text-left transition-all min-w-[140px]"
                >
                  <div className="text-xs text-orange-400 font-semibold mb-1">RE-OPENED</div>
                  <div className="font-bold text-white text-sm">{t.customer_name || '(no name)'}</div>
                  <div className="text-xs text-orange-300 mt-1">
                    {t.resource_code || '—'}
                    {t.resource_type === 'POOL_TABLE' ? ' 🎱' : t.resource_type === 'BAR_SEAT' ? ' 🍺' : ' 🪑'}
                  </div>
                  <div className="text-xs text-orange-400 mt-1 font-mono font-bold">
                    ${((t.total_cents || 0) / 100).toFixed(2)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Add Floating Table Modal ─────────────────────────────────────────── */}
      {showAddTable && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">Add Floating Table</h2>
              <p className="text-slate-400 text-sm mt-1">Create a temporary table for today's floor</p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { value: 'REGULAR_TABLE', label: '🪑 Regular Table' },
                    { value: 'BAR_SEAT', label: '🍺 Bar Seat' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setNewTable({ ...newTable, type: opt.value })}
                      className={`py-2 rounded-lg border text-sm font-medium transition-colors ${
                        newTable.type === opt.value
                          ? 'bg-sky-700 border-sky-500 text-white'
                          : 'bg-slate-700 border-slate-600 text-slate-300'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Short Code *</label>
                <input
                  value={newTable.code}
                  onChange={e => setNewTable({ ...newTable, code: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 uppercase font-mono"
                  placeholder="e.g. T09 or EXT-1"
                  maxLength={10}
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Display Name *</label>
                <input
                  value={newTable.name}
                  onChange={e => setNewTable({ ...newTable, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="e.g. Table 9 (Floating)"
                />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button
                onClick={() => { setShowAddTable(false); setNewTable({ code: '', name: '', type: 'REGULAR_TABLE' }) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700"
              >Cancel</button>
              <button
                onClick={handleAddTable}
                disabled={!newTable.code.trim() || !newTable.name.trim() || addingTable}
                className="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold disabled:opacity-50"
              >{addingTable ? 'Adding…' : 'Add to Floor'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Name Prompt Modal ────────────────────────────────────────────────── */}
      {namePrompt && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">Open Ticket — {namePrompt.code}</h2>
              <p className="text-slate-400 text-sm mt-1">Who's at this table? (optional)</p>
            </div>
            <div className="p-5">
              <label className="text-xs text-slate-400 block mb-1">Party / Guest Name</label>
              <input
                value={pendingName}
                onChange={e => setPendingName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmOpen(pendingName) }}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-3 text-lg"
                placeholder="e.g. López, Table regulars…"
                autoFocus
              />
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button
                onClick={() => { setNamePrompt(null) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700"
              >Cancel</button>
              <button
                onClick={() => confirmOpen('')}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-400 hover:bg-slate-700 text-sm"
              >Skip Name</button>
              <button
                onClick={() => confirmOpen(pendingName)}
                className="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold"
              >Open →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
