import { useState } from 'react'
import toast from 'react-hot-toast'
import client from '../api/client'
import { getPendingJob, removePendingJob } from '../utils/printJobStorage'

interface Props {
  ticketId: string
  /** Called after a successful retry so the parent can update its state. */
  onSuccess?: () => void
}

/**
 * Persistent red banner shown whenever sessionStorage contains a failed
 * print job for this ticket. Disappears on successful retry.
 */
export default function PrintRetryBanner({ ticketId, onSuccess }: Props) {
  const [pending, setPending] = useState(() => getPendingJob(ticketId))
  const [retrying, setRetrying] = useState(false)

  if (!pending) return null

  const handleRetry = async () => {
    setRetrying(true)
    try {
      await client.post(`/tickets/${pending.ticketId}/print`, { job_id: pending.job_id })
      removePendingJob(ticketId)
      setPending(null)
      toast.success('Imprimiendo...')
      onSuccess?.()
    } catch (err: any) {
      const newJobId = err.response?.data?.job_id
      if (newJobId && newJobId !== pending.job_id) {
        // Backend assigned a new job_id for this retry cycle — update locally
        setPending((p) => p ? { ...p, job_id: newJobId } : p)
      }
      toast.error('Sigue sin poder imprimir — intenta de nuevo')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="bg-red-950 border border-red-700 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-red-300 text-sm min-w-0">
        <span className="text-base shrink-0">⚠️</span>
        <span className="truncate">Impresión fallida — toca para reintentar</span>
      </div>
      <button
        onClick={handleRetry}
        disabled={retrying}
        className="shrink-0 bg-red-700 hover:bg-red-600 active:scale-95 transition-all px-3 py-1.5 rounded-lg text-white text-sm font-bold disabled:opacity-50"
      >
        {retrying ? '⏳' : '🔄 Reintentar'}
      </button>
    </div>
  )
}
