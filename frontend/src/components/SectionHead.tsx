import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  color?: string   // text color class for the label, e.g. 'text-amber-400'; defaults to muted
  badge?: ReactNode
  className?: string
}

// The crest system's section-header device: a dot, the label, and a hairline
// trailing off — replaces uppercase-text-plus-emoji headers app-wide.
export default function SectionHead({ children, color = 'text-zinc-500', badge, className = '' }: Props) {
  return (
    <div className={`flex items-center gap-2.5 mb-3 ${className}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${color.replace('text-', 'bg-')}`} />
      <span className={`font-display font-bold text-[13px] tracking-[.12em] uppercase ${color}`}>{children}</span>
      {badge}
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  )
}
