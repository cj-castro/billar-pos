import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import client from '../api/client'
import ManagerPinDialog from './ManagerPinDialog'

// Must match backend comp_svc.STAFF_REASONS.
const STAFF_REASONS = ['Comida de turno', 'Bebida de turno', 'Capacitación / prueba', 'Otro']

/**
 * Consumo de personal (batch E5): who, why, a manager's PIN -> a STAFF order
 * that goes to the kitchen / bar like any other and is closed without charge.
 */
export default function StaffOrderDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { data: people = [] } = useQuery<{ id: string; name: string; role: string }[]>({
    queryKey: ['staff-members'],
    queryFn: () => client.get('/tickets/staff-members').then(r => r.data),
  })
  const [who, setWho] = useState('')
  const [pick, setPick] = useState('')
  const [other, setOther] = useState('')
  const [askPin, setAskPin] = useState(false)
  const reason = pick === 'Otro' ? `Otro: ${other.trim()}` : pick
  const ok = !!who && !!pick && (pick !== 'Otro' || other.trim().length >= 3)

  const open = async (pin: string) => {
    try {
      const r = await client.post('/tickets/staff', { pin, staff_user_id: who, reason })
      toast.success('Consumo de personal abierto')
      onClose()
      navigate(`/ticket/${r.data.id}`)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo abrir')
    }
  }

  if (askPin) {
    return <ManagerPinDialog action="Autorizar consumo de personal"
      onConfirm={(_id, _name, pin) => { setAskPin(false); open(pin) }}
      onCancel={() => setAskPin(false)} />
  }
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-teal-700 p-5 space-y-3">
        <h2 className="font-bold text-lg">🍽 Consumo de personal</h2>
        <p className="text-xs text-slate-400">Va a cocina / barra como cualquier orden. No se cobra ni entra a caja; su costo queda registrado a nombre de la persona.</p>
        <label className="block text-xs text-slate-400">¿Para quién?
          <select value={who} onChange={e => setWho(e.target.value)}
            className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
            <option value="">— elige —</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {STAFF_REASONS.map(o => (
            <button key={o} type="button" onClick={() => setPick(o)}
              className={`text-left px-2.5 py-2 rounded-lg border text-xs ${pick === o
                ? 'bg-teal-900/60 border-teal-500 text-white font-semibold'
                : 'bg-slate-700/60 border-slate-600 text-slate-200 hover:border-slate-400'}`}>{o}</button>
          ))}
        </div>
        {pick === 'Otro' && (
          <input autoFocus value={other} onChange={e => setOther(e.target.value)} placeholder="Escribe el motivo"
            className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm" />
        )}
        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-bold">Cancelar</button>
          <button onClick={() => setAskPin(true)} disabled={!ok}
            className="flex-1 py-2 bg-teal-600 hover:bg-teal-500 rounded-xl text-sm font-bold disabled:opacity-40">Continuar</button>
        </div>
      </div>
    </div>
  )
}
