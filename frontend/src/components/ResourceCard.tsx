import { useNavigate } from 'react-router-dom'
import { useTimer } from '../hooks/useTimer'
import type { ResourceState } from '../stores/floorStore'
import clsx from 'clsx'

interface Props {
  resource: ResourceState
  onOpenNew: (resourceId: string) => void
  barOpen?: boolean
}

export default function ResourceCard({ resource, onOpenNew, barOpen = true }: Props) {
  const navigate = useNavigate()
  const elapsed = useTimer(resource.status === 'IN_USE' ? resource.timer_start : undefined)

  const isPool = resource.type === 'POOL_TABLE'
  const inUse = resource.status === 'IN_USE'
  const isAvailable = resource.status === 'AVAILABLE'
  // Available tables are locked when bar is closed
  const locked = isAvailable && !barOpen

  const handleClick = () => {
    if (inUse && resource.active_ticket_id) {
      navigate(`/ticket/${resource.active_ticket_id}`)
    } else if (isAvailable && !locked) {
      onOpenNew(resource.id)
    }
  }

  return (
    <div
      onClick={handleClick}
      className={clsx(
        'rounded-xl p-4 border-2 transition-all select-none',
        inUse
          ? 'cursor-pointer bg-red-950 border-red-700 pulse-red'
          : locked
            ? 'cursor-not-allowed bg-slate-900 border-slate-700 opacity-50'
            : 'cursor-pointer bg-slate-800 border-slate-600 hover:border-sky-500',
        !isPool && 'min-w-[120px]'
      )}
    >
      <div className="font-bold text-lg">{resource.code}</div>
      <div className="text-xs text-slate-400 mb-2">{resource.name}</div>

      {inUse ? (
        <div className="text-center">
          <span className="text-red-400 text-xs font-semibold block">IN USE</span>
          {resource.customer_name && (
            <span className="text-white text-sm font-bold block truncate max-w-[110px] mx-auto" title={resource.customer_name}>
              👤 {resource.customer_name}
            </span>
          )}
          {isPool && elapsed && (
            <span className="text-yellow-300 font-mono text-lg">{elapsed}</span>
          )}
          {resource.active_ticket_id && (
            <span className="text-slate-400 text-xs block mt-1">Tap to view ticket</span>
          )}
        </div>
      ) : locked ? (
        <div className="text-center">
          <span className="text-slate-500 text-xs font-semibold">🔒 CERRADO</span>
          <span className="text-slate-600 text-xs block mt-1">Bar cerrado</span>
        </div>
      ) : (
        <div className="text-center">
          <span className="text-green-400 text-xs font-semibold">AVAILABLE</span>
          <span className="text-slate-500 text-xs block mt-1">Tap to open</span>
        </div>
      )}
    </div>
  )
}
