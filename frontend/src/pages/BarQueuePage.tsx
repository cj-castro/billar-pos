import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import NavBar from '../components/NavBar'
import client from '../api/client'
import { useSocket } from '../hooks/useSocket'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const STATUS_ORDER = ['SENT', 'IN_PROGRESS', 'READY']
const NEXT_STATUS: Record<string, string> = { SENT: 'IN_PROGRESS', IN_PROGRESS: 'READY', READY: 'SERVED' }

function groupModifiers(modifiers: Array<{ name: string }>) {
  const map = new Map<string, number>()
  for (const m of modifiers) map.set(m.name, (map.get(m.name) ?? 0) + 1)
  return Array.from(map.entries()).map(([name, count]) => ({ name, count }))
}

function QueueColumn({ items, status, onStatusChange }: { items: any[]; status: string; onStatusChange: (id: string, s: string) => void }) {
  const { t } = useTranslation()
  const STATUS_LABEL: Record<string, string> = {
    SENT: t('queue.queued'),
    IN_PROGRESS: t('queue.inProgress'),
    READY: t('queue.ready'),
  }
  const filtered = items.filter((i) => i.status === status)
  return (
    <div className="flex-1 min-w-[200px]">
      <div className={`text-center py-2 font-bold rounded-t-xl mb-2 ${
        status === 'SENT' ? 'bg-yellow-800 text-yellow-200' :
        status === 'IN_PROGRESS' ? 'bg-blue-800 text-blue-200' : 'bg-green-800 text-green-200'
      }`}>
        {STATUS_LABEL[status]} ({filtered.length})
      </div>
      <div className="space-y-2">
        {filtered.map((item) => (
          <div key={item.id} className="bg-slate-800 rounded-xl p-3 border border-slate-700">
            <div className="flex justify-between items-start mb-1">
              <span className="font-bold text-sm">{item.resource_code}</span>
              <span className="text-xs text-slate-400">{item.sent_at ? formatDistanceToNow(new Date(item.sent_at), { addSuffix: true }) : ''}</span>
            </div>
            <div className="font-semibold">{item.quantity}× {item.menu_item_name}</div>
            {groupModifiers(item.modifiers ?? []).map((m) => (
              <div key={m.name} className="text-xs text-sky-300">→ {m.count > 1 ? `${m.name} ×${m.count}` : m.name}</div>
            ))}
            {item.notes && <div className="text-xs text-slate-400 italic mt-1">{item.notes}</div>}
            <button
              onClick={() => onStatusChange(item.id, NEXT_STATUS[status])}
              className={`w-full mt-2 py-1.5 rounded-lg text-sm font-semibold ${
                status === 'SENT' ? 'bg-blue-700 hover:bg-blue-600' :
                status === 'IN_PROGRESS' ? 'bg-green-700 hover:bg-green-600' : 'bg-slate-600 hover:bg-slate-500'
              }`}
            >
              {status === 'SENT' ? t('queue.markInProgress') : status === 'IN_PROGRESS' ? t('queue.markReady') : t('queue.markServed')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function BarQueuePage() {
  const socket = useSocket()
  const { t } = useTranslation()
  const { data: items = [], refetch } = useQuery({
    queryKey: ['bar-queue'],
    queryFn: () => client.get('/queue/bar').then((r) => r.data),
    refetchInterval: 15_000,
  })

  useEffect(() => {
    if (!socket) return
    socket.on('bar:update', () => refetch())
    socket.on('bar:item_update', () => refetch())
    return () => { socket.off('bar:update'); socket.off('bar:item_update') }
  }, [socket])

  const handleStatusChange = async (itemId: string, newStatus: string) => {
    try {
      await client.patch(`/queue/${itemId}/status`, { status: newStatus })
      refetch()
    } catch {
      toast.error('Failed to update status')
    }
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <NavBar />
      <div className="p-4">
        <h1 className="text-xl font-bold mb-4">🍺 {t('queue.bar')}</h1>
        <div className="flex gap-4 overflow-x-auto pb-4">
          {STATUS_ORDER.map((s) => (
            <QueueColumn key={s} items={items} status={s} onStatusChange={handleStatusChange} />
          ))}
        </div>
      </div>
    </div>
  )
}
