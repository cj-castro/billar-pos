import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import NavBar from '../components/NavBar'
import client from '../api/client'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const STATUS_ORDER = ['SENT', 'IN_PROGRESS', 'READY']
const NEXT_STATUS: Record<string, string> = { SENT: 'IN_PROGRESS', IN_PROGRESS: 'READY', READY: 'SERVED' }

const STATUS_CONFIG = {
  SENT:        { label: 'En espera',      tabBg: 'bg-amber-500',  headerBg: 'bg-amber-900/40',  border: 'border-amber-700',   dot: 'bg-amber-400',  btnBg: 'bg-blue-700 hover:bg-blue-600',    btnLabel: 'En Preparación →' },
  IN_PROGRESS: { label: 'En preparación', tabBg: 'bg-blue-600',   headerBg: 'bg-blue-900/40',   border: 'border-blue-700',    dot: 'bg-blue-400',   btnBg: 'bg-green-700 hover:bg-green-600',  btnLabel: '✓ Marcar Listo'   },
  READY:       { label: 'Listo',          tabBg: 'bg-green-600',  headerBg: 'bg-green-900/40',  border: 'border-green-700',   dot: 'bg-green-400',  btnBg: 'bg-slate-600 hover:bg-slate-500',  btnLabel: 'Entregar ✓'       },
}

function groupModifiers(modifiers: Array<{ name: string }>) {
  const map = new Map<string, number>()
  for (const m of modifiers) map.set(m.name, (map.get(m.name) ?? 0) + 1)
  return Array.from(map.entries()).map(([name, count]) => ({ name, count }))
}

function QueueCard({ item, status, onStatusChange, onPrint }: {
  item: any; status: string
  onStatusChange: (id: string, s: string) => void
  onPrint?: (id: string) => void
}) {
  const cfg = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
  const mods = groupModifiers(item.modifiers ?? [])
  const timeAgo = item.sent_at ? formatDistanceToNow(new Date(item.sent_at), { addSuffix: true }) : ''
  const [printing, setPrinting] = useState(false)

  const handlePrint = async () => {
    if (!onPrint) return
    setPrinting(true)
    try { await onPrint(item.id) } finally { setPrinting(false) }
  }

  const showPrintBtn = (status === 'SENT' || item.needs_reprint) && !!onPrint

  return (
    <div className={`bg-slate-800 rounded-2xl border ${cfg.border} overflow-hidden shadow-lg`}>
      <div className={`flex items-center justify-between px-4 py-2.5 ${cfg.headerBg} border-b ${cfg.border}`}>
        <span className="font-black text-xl tracking-widest text-white">{item.resource_code}</span>
        <div className="flex items-center gap-2">
          {showPrintBtn && (
            <button
              onClick={handlePrint}
              disabled={printing}
              className="text-slate-300 hover:text-white active:scale-90 transition-transform text-base disabled:opacity-40"
              title="Reimprimir comanda"
            >
              {printing ? '⏳' : '🖨️'}
            </button>
          )}
          <span className="text-xs text-slate-400 font-medium">{timeAgo}</span>
        </div>
      </div>
      <div className="px-4 py-3 space-y-2">
        <div className="font-bold text-base leading-snug">
          <span className="text-orange-300 font-black mr-1">{item.quantity}×</span>
          {item.menu_item_name}
        </div>
        {mods.length > 0 && (
          <div className="space-y-1">
            {mods.map((m) => (
              <div key={m.name} className="flex items-center gap-2 text-sm">
                <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
                <span className="text-slate-300">{m.count > 1 ? `${m.name} ×${m.count}` : m.name}</span>
              </div>
            ))}
          </div>
        )}
        {item.notes && (
          <div className="text-xs text-amber-300 italic bg-amber-900/20 rounded-lg px-3 py-1.5 border border-amber-800/40">
            📝 {item.notes}
          </div>
        )}
        {item.needs_reprint && (
          <div className="text-xs text-red-300 bg-red-950/60 border border-red-700/50 rounded-lg px-3 py-1.5 flex items-center gap-2">
            <span>⚠️</span><span>Comanda no impresa — toca 🖨️ para reintentar</span>
          </div>
        )}
        <button
          onClick={() => onStatusChange(item.id, NEXT_STATUS[status])}
          className={`w-full py-3.5 rounded-xl font-bold text-base ${cfg.btnBg} active:scale-95 transition-transform`}
        >
          {cfg.btnLabel}
        </button>
      </div>
    </div>
  )
}

function QueueColumn({ items, status, onStatusChange, onPrint }: {
  items: any[]; status: string
  onStatusChange: (id: string, s: string) => void
  onPrint?: (id: string) => void
}) {
  const cfg = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
  const filtered = items.filter((i) => i.status === status)
  return (
    <div className="flex-1 min-w-[240px]">
      <div className={`flex items-center justify-between px-3 py-2.5 rounded-xl mb-3 ${cfg.headerBg} border ${cfg.border}`}>
        <span className="font-bold text-sm text-white">{cfg.label}</span>
        <span className={`${cfg.tabBg} text-white text-xs font-bold px-2.5 py-0.5 rounded-full`}>{filtered.length}</span>
      </div>
      <div className="space-y-3">
        {filtered.map((item) => (
          <QueueCard key={item.id} item={item} status={status} onStatusChange={onStatusChange} onPrint={onPrint} />
        ))}
        {filtered.length === 0 && (
          <div className="text-center py-10 text-slate-600 text-sm">Sin artículos</div>
        )}
      </div>
    </div>
  )
}

export default function KitchenQueuePage() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('SENT')

  // Socket events handled globally in useSocket.ts — no local handlers needed.
  // 5s fallback poll keeps the queue in sync even without socket events.
  const { data: items = [], refetch } = useQuery({
    queryKey: ['kitchen-queue'],
    queryFn: () => client.get('/queue/kitchen').then((r) => r.data),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })

  // Auto-clear READY items every 10 minutes
  useEffect(() => {
    const interval = setInterval(async () => {
      const readyItems = (items as any[]).filter((i: any) => i.status === 'READY')
      if (readyItems.length === 0) return
      await Promise.allSettled(readyItems.map((i: any) => client.patch(`/queue/${i.id}/status`, { status: 'SERVED' })))
      refetch()
    }, 10 * 60 * 1000)
    return () => clearInterval(interval)
  }, [items])

  const handleStatusChange = async (itemId: string, newStatus: string) => {
    try {
      await client.patch(`/queue/${itemId}/status`, { status: newStatus })
      refetch()
      qc.invalidateQueries({ queryKey: ['queue-counts'] })
    } catch {
      toast.error('No se pudo actualizar el estado')
    }
  }

  const handlePrint = async (itemId: string) => {
    try {
      await client.post(`/queue/${itemId}/print`)
      toast.success('Imprimiendo orden...')
    } catch {
      toast.error('Error al imprimir')
    }
  }

  const countOf = (s: string) => (items as any[]).filter((i: any) => i.status === s).length
  const activeCfg = STATUS_CONFIG[activeTab as keyof typeof STATUS_CONFIG]
  const activeItems = (items as any[]).filter((i: any) => i.status === activeTab)

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <div className="p-3 sm:p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">🍳 {t('queue.kitchen')}</h1>
          <button
            onClick={() => refetch()}
            className="text-slate-400 hover:text-white active:scale-90 transition-transform text-xl"
            title="Actualizar"
          >
            🔄
          </button>
        </div>

        {/* ── Mobile: tab switcher + single column ── */}
        <div className="md:hidden">
          <div className="flex gap-2 mb-4">
            {STATUS_ORDER.map((s) => {
              const c = STATUS_CONFIG[s as keyof typeof STATUS_CONFIG]
              const active = activeTab === s
              const n = countOf(s)
              return (
                <button
                  key={s}
                  onClick={() => setActiveTab(s)}
                  className={`flex-1 flex flex-col items-center py-3 rounded-xl border font-bold transition-all ${
                    active ? `${c.tabBg} text-white border-transparent` : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  <span className="text-2xl font-black leading-none">{n}</span>
                  <span className="text-xs mt-0.5 leading-tight text-center px-1">{c.label}</span>
                </button>
              )
            })}
          </div>

          <div className="space-y-3">
            {activeItems.map((item) => (
              <QueueCard key={item.id} item={item} status={activeTab} onStatusChange={handleStatusChange} onPrint={handlePrint} />
            ))}
            {activeItems.length === 0 && (
              <div className="text-center py-20 text-slate-600">
                <div className="text-5xl mb-3">✅</div>
                <div className="font-semibold text-lg">Todo al día</div>
                <div className="text-sm mt-1">Sin artículos en "{activeCfg.label}"</div>
              </div>
            )}
          </div>
        </div>

        {/* ── Desktop: kanban columns ── */}
        <div className="hidden md:flex gap-4">
          {STATUS_ORDER.map((s) => (
            <QueueColumn key={s} items={items as any[]} status={s} onStatusChange={handleStatusChange} onPrint={handlePrint} />
          ))}
        </div>
      </div>
    </div>
  )
}
