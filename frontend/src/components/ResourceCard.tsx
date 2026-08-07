import { useNavigate } from 'react-router-dom'
import { useTimer } from '../hooks/useTimer'
import type { ResourceState } from '../stores/floorStore'
import clsx from 'clsx'
import { clickableDivProps } from '../utils/a11y'
import { IconUser, IconClock, IconLock } from './Icon'

interface Props {
  resource: ResourceState
  onOpenNew: (resourceId: string) => void
  barOpen?: boolean
  isWaitingPool?: boolean
}

export default function ResourceCard({ resource, onOpenNew, barOpen = true, isWaitingPool = false }: Props) {
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

  const clickable = inUse || (isAvailable && !locked)

  return (
    <div
      onClick={handleClick}
      {...clickableDivProps(handleClick, !clickable)}
      aria-label={`${resource.code} ${resource.name} — ${inUse ? 'en uso' : locked ? 'cerrado' : 'disponible'}`}
      className={clsx(
        'rounded-md p-4 border transition-all select-none text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2',
        inUse
          ? 'cursor-pointer bg-zinc-900 border-red-600 pulse-red'
          : locked
            ? 'cursor-not-allowed bg-zinc-950 border-zinc-800 opacity-40'
            : 'cursor-pointer bg-zinc-900 border-zinc-800 hover:border-zinc-500',
        !isPool && 'min-w-[124px]'
      )}
    >
      <div className={clsx(
        'w-16 h-16 mx-auto mb-2.5 rounded-full flex items-center justify-center relative border border-dashed',
        inUse ? 'border-red-600' : locked ? 'border-zinc-700' : 'border-zinc-500'
      )}>
        <div className={clsx(
          'absolute inset-[5px] rounded-full border',
          inUse ? 'border-red-600' : locked ? 'border-zinc-700' : 'border-zinc-600'
        )} />
        <span className="font-display font-extrabold text-xl text-white relative">{resource.code}</span>
      </div>
      <div className="text-[11px] text-zinc-500 mb-2.5">{resource.name}</div>

      {inUse ? (
        <div>
          <span className="inline-flex items-center gap-1 bg-red-950 text-red-400 text-[11px] font-display font-bold uppercase tracking-wide px-2.5 py-0.5 rounded-sm">
            En uso
          </span>
          {resource.customer_name && (
            <div className="text-white text-sm font-bold flex items-center justify-center gap-1 truncate max-w-[110px] mx-auto mt-2" title={resource.customer_name}>
              <IconUser className="w-3 h-3 flex-shrink-0" />{resource.customer_name}
            </div>
          )}
          {isPool && elapsed && (
            <div className="font-mono font-bold text-xl text-amber-400 mt-1.5">{elapsed}</div>
          )}
          {isWaitingPool && (
            <span className="mt-1.5 inline-flex items-center gap-1 bg-amber-950 border border-amber-800 text-amber-400 text-[10px] font-semibold px-2 py-0.5 rounded-full">
              <IconClock className="w-2.5 h-2.5" />Esp. Pool
            </span>
          )}
          {resource.active_ticket_id && (
            <div className="text-zinc-500 text-[10px] mt-1.5">Toca para ver ticket</div>
          )}
        </div>
      ) : locked ? (
        <div>
          <span className="inline-flex items-center gap-1 bg-zinc-900 text-zinc-500 text-[11px] font-display font-bold uppercase tracking-wide px-2.5 py-0.5 rounded-sm">
            <IconLock className="w-2.5 h-2.5" />Cerrado
          </span>
          <div className="text-zinc-600 text-[10px] mt-1.5">Bar cerrado</div>
        </div>
      ) : (
        <div>
          <span className="inline-flex items-center gap-1 bg-green-950 text-green-400 text-[11px] font-display font-bold uppercase tracking-wide px-2.5 py-0.5 rounded-sm">
            Libre
          </span>
          <div className="text-zinc-600 text-[10px] mt-1.5">Toca para abrir</div>
        </div>
      )}
    </div>
  )
}
