import { useState } from 'react'
import toast from 'react-hot-toast'
import client from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { localDateTimeInput } from '../utils/dates'
import ManagerPinDialog from './ManagerPinDialog'

/**
 * Editar horas de billar (batch E7): correct when a game started / ended. The
 * charge is recalculated by the same rules as the close; a reason is required
 * and a manager authorizes (logged in, or with a PIN). Times are bar-local.
 */
export default function TimerEditDialog({ ticketId, session, onDone, onCancel }: {
  ticketId: string
  session: { id: string; resource_code: string; start_time: string; end_time: string | null }
  onDone: () => void
  onCancel: () => void
}) {
  const role = useAuthStore(s => s.user?.role)
  const isManager = role === 'MANAGER' || role === 'ADMIN'
  const [start, setStart] = useState(localDateTimeInput(session.start_time))
  const [end, setEnd] = useState(session.end_time ? localDateTimeInput(session.end_time) : '')
  const [reason, setReason] = useState('')
  const [askPin, setAskPin] = useState(false)
  const running = !session.end_time
  const ok = !!start && (running || !!end) && reason.trim().length >= 3 && (running || end > start)

  const save = async (pin?: string) => {
    try {
      await client.patch(`/tickets/${ticketId}/timer/${session.id}`, {
        start_time: start, ...(running ? {} : { end_time: end }), reason: reason.trim(), ...(pin ? { pin } : {}),
      })
      toast.success('Tiempo corregido')
      onDone()
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo corregir')
    }
  }

  if (askPin) {
    return <ManagerPinDialog action="Autorizar corrección de tiempo"
      onConfirm={(_i, _n, pin) => { setAskPin(false); save(pin) }} onCancel={() => setAskPin(false)} />
  }
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[80] p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-yellow-700 p-5 space-y-3">
        <h2 className="font-bold text-lg">✏️ Corregir tiempo · {session.resource_code}</h2>
        <label className="block text-xs text-slate-400">Inicio
          <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)}
            className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
        </label>
        {running ? (
          <p className="text-xs text-slate-400">Sigue corriendo: solo se corrige el inicio.</p>
        ) : (
          <label className="block text-xs text-slate-400">Fin
            <input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
          </label>
        )}
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo (obligatorio), p. ej. se olvidó iniciar"
          className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm" />
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-bold">Cancelar</button>
          <button onClick={() => (isManager ? save() : setAskPin(true))} disabled={!ok}
            className="flex-1 py-2 bg-yellow-600 hover:bg-yellow-500 text-slate-900 rounded-xl text-sm font-bold disabled:opacity-40">Guardar</button>
        </div>
      </div>
    </div>
  )
}
