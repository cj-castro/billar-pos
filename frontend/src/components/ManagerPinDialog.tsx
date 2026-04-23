import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import client from '../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../hooks/useEscKey'

interface Props {
  action: string
  onConfirm: (managerId: string, managerName: string) => void
  onCancel: () => void
}

export default function ManagerPinDialog({ action, onConfirm, onCancel }: Props) {
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()
  useEscKey(onCancel)

  // Focus container so it captures keystrokes
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  // Physical keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (loading) return
      if (e.key >= '0' && e.key <= '9') {
        setPin(p => p.length < 4 ? p + e.key : p)
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        setPin(p => p.slice(0, -1))
      } else if (e.key === 'Enter') {
        handleSubmit()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pin, loading])

  const handleSubmit = async () => {
    if (pin.length !== 4) return
    setLoading(true)
    try {
      const res = await client.post('/auth/verify-pin', { pin })
      onConfirm(res.data.manager_id, res.data.manager_name)
    } catch {
      toast.error(t('pin.incorrect'))
      setPin('')
      setShake(true)
      setTimeout(() => { setShake(false); onCancel() }, 600)
    } finally {
      setLoading(false)
    }
  }

  const digits = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div
        ref={containerRef}
        tabIndex={-1}
        outline-none
        className={`bg-slate-800 rounded-2xl p-6 w-full max-w-xs shadow-2xl border border-slate-600 outline-none ${shake ? 'animate-shake' : ''}`}
      >
        <div className="flex items-center gap-2 mb-4">
          <span className="text-2xl">🔒</span>
          <div>
            <div className="font-bold">{t('pin.title')}</div>
            <div className="text-xs text-slate-400">{action}</div>
          </div>
        </div>

        <div className="text-xs text-slate-500 text-center mb-2">{t('pin.hint')}</div>

        <div className="flex justify-center gap-3 my-4">
          {[0,1,2,3].map((i) => (
            <div key={i} className={`w-5 h-5 rounded-full border-2 transition-all ${i < pin.length ? 'bg-sky-400 border-sky-400 scale-110' : 'border-slate-500'}`} />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          {digits.map((d, i) => (
            <button
              key={i}
              onClick={() => {
                if (d === '⌫') setPin(p => p.slice(0,-1))
                else if (d !== '') setPin(p => p.length < 4 ? p + d : p)
              }}
              className="bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-white font-bold py-3 rounded-lg text-lg disabled:opacity-30 select-none"
              disabled={loading || d === ''}
            >
              {d}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700">
            {t('pin.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={pin.length !== 4 || loading}
            className="flex-1 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 font-bold disabled:opacity-50"
          >
            {loading ? '...' : t('pin.authorize')}
          </button>
        </div>
      </div>
    </div>
  )
}
