import { useState } from 'react'

/**
 * Pick a reason from a short list, or "Otro" with a few words (batch E5).
 * Returns "Cumpleaños" or "Otro: <text>" — the format the server validates.
 */
export default function ReasonDialog({ title, options, hint, confirmLabel = 'Continuar', onConfirm, onCancel }: {
  title: string
  options: string[]
  hint?: React.ReactNode
  confirmLabel?: string
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [pick, setPick] = useState<string>('')
  const [other, setOther] = useState('')
  const isOther = pick === 'Otro'
  const ok = !!pick && (!isOther || other.trim().length >= 3)
  const reason = isOther ? `Otro: ${other.trim()}` : pick

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[80] p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-600 p-5 space-y-3">
        <h2 className="font-bold text-lg">{title}</h2>
        {hint && <div className="text-xs text-amber-200 bg-amber-900/30 border border-amber-700 rounded-lg px-3 py-2">{hint}</div>}
        <div className="grid grid-cols-1 gap-1.5">
          {options.map(o => (
            <button key={o} type="button" onClick={() => setPick(o)}
              className={`text-left px-3 py-2 rounded-lg border text-sm ${pick === o
                ? 'bg-sky-900/60 border-sky-500 text-white font-semibold'
                : 'bg-slate-700/60 border-slate-600 text-slate-200 hover:border-slate-400'}`}>{o}</button>
          ))}
        </div>
        {isOther && (
          <input autoFocus value={other} onChange={e => setOther(e.target.value)} placeholder="Escribe el motivo"
            onKeyDown={e => { if (e.key === 'Enter' && ok) onConfirm(reason) }}
            className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm" />
        )}
        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm font-bold">Cancelar</button>
          <button onClick={() => ok && onConfirm(reason)} disabled={!ok}
            className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 rounded-xl text-sm font-bold disabled:opacity-40">{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
