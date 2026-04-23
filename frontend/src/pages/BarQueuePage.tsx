import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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

function printBarTicket(item: any, mode: 'new' | 'delivery' = 'new') {
  const modLines = groupModifiers(item.modifiers ?? [])
    .map((m) => `<div class="mod">→ ${m.count > 1 ? `${m.name} ×${m.count}` : m.name}</div>`)
    .join('')
  const noteLines = item.notes ? `<div class="note">${item.notes}</div>` : ''
  const now = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
  const heading = mode === 'new' ? '🍺 NUEVO PEDIDO' : '🍺 ENTREGAR'
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${heading}</title><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: 80mm auto; margin: 3mm; }
    body { font-family: 'Courier New', Courier, monospace; font-size: 13px; width: 74mm; padding: 3mm; color: #000; }
    .center { text-align: center; }
    .big { font-size: 24px; font-weight: bold; margin: 2mm 0; }
    .table { font-size: 20px; font-weight: bold; border: 3px solid #000; padding: 2mm 4mm; display: inline-block; margin: 2mm 0; }
    .item { font-size: 18px; font-weight: bold; margin: 3mm 0 1mm; }
    .mod { font-size: 13px; padding-left: 4mm; }
    .note { font-size: 12px; font-style: italic; padding-left: 4mm; color: #333; }
    .divider { border-top: 2px dashed #000; margin: 3mm 0; }
    .time { font-size: 11px; color: #555; margin-top: 2mm; }
  </style></head><body>
    <div class="center"><div class="big">${heading}</div><div class="table">${item.resource_code}</div></div>
    <div class="divider"></div>
    <div class="item">${item.quantity}× ${item.menu_item_name}</div>
    ${modLines}${noteLines}
    <div class="divider"></div>
    <div class="center time">Recibido a las ${now}</div>
  </body></html>`
  const win = window.open('', '_blank', 'width=400,height=400')
  if (!win) { toast.error('Permite ventanas emergentes para imprimir'); return }
  win.document.write(html); win.document.close(); win.focus()
  setTimeout(() => { win.print(); win.close() }, 300)
}

function QueueColumn({ items, status, onStatusChange, onPrint }: { items: any[]; status: string; onStatusChange: (id: string, s: string) => void; onPrint?: (item: any) => void }) {
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
              <div className="flex items-center gap-1">
                {status === 'SENT' && onPrint && (
                  <button onClick={() => onPrint(item)} className="text-slate-400 hover:text-white text-base px-1" title="Imprimir">🖨️</button>
                )}
                <span className="text-xs text-slate-400">{item.sent_at ? formatDistanceToNow(new Date(item.sent_at), { addSuffix: true }) : ''}</span>
              </div>
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
  const qc = useQueryClient()
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
      const item = (items as any[]).find((i: any) => i.id === itemId)
      await client.patch(`/queue/${itemId}/status`, { status: newStatus })
      if (newStatus === 'SERVED' && item) printBarTicket(item, 'delivery')
      refetch()
      qc.invalidateQueries({ queryKey: ['queue-counts'] })
    } catch {
      toast.error('No se pudo actualizar el estado')
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <div className="p-4">
        <h1 className="text-xl font-bold mb-4">🍺 {t('queue.bar')}</h1>
        <div className="flex gap-4 overflow-x-auto pb-4">
          {STATUS_ORDER.map((s) => (
            <QueueColumn key={s} items={items} status={s} onStatusChange={handleStatusChange} onPrint={(item) => printBarTicket(item, 'new')} />
          ))}
        </div>
      </div>
    </div>
  )
}
