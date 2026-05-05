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
  const [reprintingId, setReprintingId] = useState<string | null>(null)

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

  const [namePrompt, setNamePrompt] = useState<{ resourceId: string; code: string; isPool: boolean } | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [selectedWlEntry, setSelectedWlEntry] = useState<string>('')  // waiting list entry id

  const { data: waitingList = [] } = useQuery({
    queryKey: ['waiting-list'],
    queryFn: () => client.get('/waiting-list').then(r => r.data),
    refetchInterval: 15_000,
  })

  // Set of resource IDs that have a SEATED waiting list customer (waiting for pool)
  const seatedResourceIds = new Set<string>(
    waitingList
      .filter((e: any) => e.status === 'SEATED' && e.floor_resource_id)
      .map((e: any) => e.floor_resource_id)
  )

  useEscKey(() => {
    if (showAddTable) { setShowAddTable(false); return }
    if (namePrompt) { setNamePrompt(null); return }
  }, showAddTable || !!namePrompt)

  const handleOpenNew = (resourceId: string) => {
    const resource = resources.find(r => r.id === resourceId)
    setNamePrompt({ resourceId, code: resource?.code ?? '', isPool: resource?.type === 'POOL_TABLE' })
    setPendingName('')
    setSelectedWlEntry('')
  }

  const confirmOpen = async (customerName: string) => {
    if (!namePrompt) return
    setOpeningResource(namePrompt.resourceId)
    setNamePrompt(null)
    try {
      if (!barOpen) { toast.error('El bar está cerrado. El gerente debe iniciar la sesión de caja primero.'); setOpeningResource(null); return }
      // If a waiting list entry was selected, use their name
      const wlEntry = waitingList.find((e: any) => e.id === selectedWlEntry)
      const finalName = wlEntry ? wlEntry.party_name : (customerName.trim() || undefined)
      const res = await client.post('/tickets', {
        resource_id: namePrompt.resourceId,
        customer_name: finalName,
        waiting_list_entry_id: selectedWlEntry || undefined,
      })
      if (selectedWlEntry) {
        qc.invalidateQueries({ queryKey: ['waiting-list'] })
      }
      navigate(`/ticket/${res.data.id}`)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo abrir el ticket')
      refetch()
    } finally {
      setOpeningResource(null)
    }
  }

  // ── Create floating table ──────────────────────────────────────────────────
  const handleAddTable = async (overrideName?: string, overrideType?: string) => {
    const tableType = overrideType || newTable.type
    const tableName = (overrideName || newTable.name).trim()
    if (!tableName) return toast.error('Se requiere un nombre')

    // Auto-generate code: find highest existing numeric suffix for this type
    const prefix = tableType === 'BAR_SEAT' ? 'B' : 'T'
    const existingNums = resources
      .filter(r => r.type === tableType && r.code?.startsWith(prefix))
      .map(r => parseInt(r.code.slice(prefix.length), 10))
      .filter(n => !isNaN(n))
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1
    const autoCode = `${prefix}${nextNum}`

    setAddingTable(true)
    try {
      await client.post('/resources', {
        code: autoCode,
        name: tableName,
        type: tableType,
        sort_order: 99,
        is_temp: true,
      })
      toast.success(`${autoCode} añadido al piso`)
      setShowAddTable(false)
      setNewTable({ code: '', name: '', type: 'REGULAR_TABLE' })
      const fresh = await client.get('/resources').then(r => r.data)
      setResources(fresh)
      qc.setQueryData(['resources'], fresh)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo añadir la mesa')
    } finally {
      setAddingTable(false)
    }
  }

  // ── Deactivate floating table ──────────────────────────────────────────────
  const handleRemoveTable = async (resource: typeof resources[0]) => {
    if (!confirm(`¿Eliminar "${resource.code}" del piso? (Sin tickets abiertos)`)) return
    try {
      await client.patch(`/resources/${resource.id}`, { is_active: false })
      toast.success(`${resource.code} eliminado`)
      const fresh = await client.get('/resources').then(r => r.data)
      setResources(fresh)
      qc.setQueryData(['resources'], fresh)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se puede eliminar')
    }
  }

  const poolTables = resources.filter((r) => r.type === 'POOL_TABLE')
  const regularTables = resources.filter((r) => r.type === 'REGULAR_TABLE')
  const barSeats = resources.filter((r) => r.type === 'BAR_SEAT')

  // Floating = tables added dynamically (is_temp flag)
  const isFloating = (r: typeof resources[0]) => (r as any).is_temp === true

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <div className="p-4 max-w-5xl mx-auto">

        {/* Bar closed banner */}
        {!barOpen && (
          <div className="mb-4 bg-red-900/60 border border-red-600 rounded-xl px-4 py-3 flex items-center justify-between">
            <div>
              <span className="font-bold text-red-300">🔒 Bar Cerrado</span>
              <span className="text-red-400 text-sm ml-2">No se pueden abrir tickets hasta que un gerente inicie la caja.</span>
            </div>
            {isManager && (
              <button onClick={() => navigate('/manager/cash')} className="bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg text-sm font-bold ml-4 whitespace-nowrap">
                Abrir Bar →
              </button>
            )}
          </div>
        )}

        {/* Floor action bar */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-slate-400 text-sm">
            {resources.filter(r => r.status === 'IN_USE').length} en uso
            &nbsp;·&nbsp;
            {resources.filter(r => r.status === 'AVAILABLE').length} disponible(s)
          </span>
        </div>

        {/* Pool Tables */}
        <div className="mb-6">
          <h2 className="text-lg font-bold text-slate-300 mb-3 uppercase tracking-wide">🎱 {t('floor.poolTables')}</h2>
          <div className="flex flex-wrap gap-3">
            {poolTables.map((r) => (
              <ResourceCard key={r.id} resource={r} onOpenNew={handleOpenNew} barOpen={barOpen} isWaitingPool={seatedResourceIds.has(r.id)} />
            ))}
          </div>
        </div>

        {/* Waiting List */}
        <WaitingListPanel allResources={resources} isManager={isManager} />

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
              + Mesa Flotante
            </button>
          )}
          <div className="flex flex-wrap gap-3">
            {regularTables.map((r) => (
              <div key={r.id} className="relative group">
                <ResourceCard resource={r} onOpenNew={handleOpenNew} barOpen={barOpen} isWaitingPool={seatedResourceIds.has(r.id)} />
                {isManager && isFloating(r) && r.status === 'AVAILABLE' && (
                  <button
                    onClick={() => handleRemoveTable(r)}
                    title="Eliminar mesa flotante"
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
                <ResourceCard resource={r} onOpenNew={handleOpenNew} barOpen={barOpen} isWaitingPool={seatedResourceIds.has(r.id)} />
                {isManager && isFloating(r) && r.status === 'AVAILABLE' && (
                  <button
                    onClick={() => handleRemoveTable(r)}
                    title="Eliminar asiento flotante"
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
                        if (reprintingId === t.id) return
                        setReprintingId(t.id)
                        try {
                          await client.post(`/tickets/${t.id}/print?unpaid=true`)
                          toast.success('Impreso ✓')
                        } catch (err: any) {
                          const msg = err?.response?.data?.error || 'Agente de impresión no disponible'
                          toast.error(`No se pudo imprimir: ${msg}`)
                        } finally {
                          setReprintingId(null)
                        }
                      }}
                      disabled={reprintingId === t.id}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold ${reprintingId === t.id ? 'bg-amber-900 text-amber-500 cursor-not-allowed' : 'bg-amber-700 hover:bg-amber-600'}`}
                    >{reprintingId === t.id ? '⏳ Imprimiendo…' : '🖨️ Reimprimir'}</button>
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
                  <div className="text-xs text-orange-400 font-semibold mb-1">REABIERTO</div>
                  <div className="font-bold text-white text-sm">{t.customer_name || '(sin nombre)'}</div>
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
              <h2 className="text-lg font-bold">Agregar Mesa Flotante</h2>
              <p className="text-slate-400 text-sm mt-1">El código se asignará automáticamente</p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Tipo</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { value: 'REGULAR_TABLE', label: '🪑 Mesa Regular' },
                    { value: 'BAR_SEAT', label: '🍺 Asiento de Bar' },
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
                <label className="text-xs text-slate-400 block mb-1">Nombre de Exhibición *</label>
                <input
                  value={newTable.name}
                  onChange={e => setNewTable({ ...newTable, name: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2"
                  placeholder="p.ej. Mesa Terraza o Juan García"
                  autoFocus
                />
              </div>
              {/* Auto-code preview */}
              {newTable.name.trim() && (() => {
                const prefix = newTable.type === 'BAR_SEAT' ? 'B' : 'T'
                const nums = resources.filter(r => r.type === newTable.type && r.code?.startsWith(prefix))
                  .map(r => parseInt(r.code.slice(prefix.length), 10)).filter(n => !isNaN(n))
                const next = nums.length > 0 ? Math.max(...nums) + 1 : 1
                return <div className="text-xs text-slate-400 text-center">Código asignado: <span className="font-mono font-bold text-sky-400">{prefix}{next}</span></div>
              })()}
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button
                onClick={() => { setShowAddTable(false); setNewTable({ code: '', name: '', type: 'REGULAR_TABLE' }) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700"
              >Cancelar</button>
              <button
                onClick={() => handleAddTable()}
                disabled={!newTable.name.trim() || addingTable}
                className="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold disabled:opacity-50"
              >{addingTable ? 'Añadiendo…' : 'Añadir al Piso'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Name Prompt Modal ────────────────────────────────────────────────── */}
      {namePrompt && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 shadow-xl">
            <div className="p-5 border-b border-slate-700">
              <h2 className="text-lg font-bold">Abrir Ticket — {namePrompt.code}</h2>
              <p className="text-slate-400 text-sm mt-1">¿Quién está en esta mesa?</p>
            </div>
            <div className="p-5 space-y-4">
              {/* Waiting list picker — shown when there are waiting entries */}
              {waitingList.length > 0 && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">📋 Desde lista de espera</label>
                  <select
                    value={selectedWlEntry}
                    onChange={e => {
                      setSelectedWlEntry(e.target.value)
                      const entry = waitingList.find((w: any) => w.id === e.target.value)
                      if (entry) setPendingName(entry.party_name)
                      else setPendingName('')
                    }}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">— Seleccionar de lista de espera —</option>
                    {waitingList.map((e: any) => (
                      <option key={e.id} value={e.id}>
                        #{e.position} · {e.party_name} ({e.party_size} personas)
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs text-slate-400 block mb-1">
                  {waitingList.length > 0 ? 'O escribir nombre manualmente' : 'Nombre del Grupo / Invitado'}
                </label>
                <input
                  value={pendingName}
                  onChange={e => { setPendingName(e.target.value); setSelectedWlEntry('') }}
                  onKeyDown={e => { if (e.key === 'Enter') confirmOpen(pendingName) }}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-3 text-lg"
                  placeholder="p.ej. López, Clientes frecuentes…"
                  autoFocus={waitingList.length === 0}
                />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-700">
              <button
                onClick={() => { setNamePrompt(null) }}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-300 hover:bg-slate-700"
              >Cancelar</button>
              <button
                onClick={() => confirmOpen('')}
                className="flex-1 py-2.5 border border-slate-600 rounded-xl text-slate-400 hover:bg-slate-700 text-sm"
              >Omitir Nombre</button>
              <button
                onClick={() => confirmOpen(pendingName)}
                className="flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl font-bold"
              >Abrir →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
