// Single-stroke line icons in the crest's engraved-seal grammar — replaces
// the emoji vocabulary. One consistent stroke weight (1.6), no fill except
// where a glyph needs it (the 8-ball's number disc).

type Props = { className?: string }

const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export function IconBall8({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
      <text x="12" y="14.8" fontSize="5.5" textAnchor="middle" fill="var(--icon-bg,#09090b)" fontFamily="Archivo" fontWeight="800">8</text>
    </svg>
  )
}

export function IconHouse({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6 10v9h12v-9" />
      <path d="M10 19v-5h4v5" />
    </svg>
  )
}

export function IconFlame({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M12 3c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1.5-1-2-1-3 1.5 1 3 3 3 5.5A5 5 0 0 1 7 13.5C7 8 12 7 12 3Z" />
    </svg>
  )
}

export function IconMug({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M5 8h11v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8Z" />
      <path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 5.5c0-1 1-1 1-2M11.5 5.5c0-1 1-1 1-2" />
    </svg>
  )
}

export function IconChart({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  )
}

export function IconUser({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20c1-4 4-6 7-6s6 2 7 6" />
    </svg>
  )
}

export function IconLock({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export function IconTrend({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M3 17 9.5 10.5 13.5 14.5 21 6" />
      <path d="M15 6h6v6" />
    </svg>
  )
}

export function IconDoor({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M15 4H6v16h9" />
      <path d="M15 3v18" />
      <path d="M19 12h-8M16 9l3 3-3 3" />
    </svg>
  )
}

export function IconClock({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  )
}

export function IconReceipt({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3Z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  )
}

export function IconBox({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M3 8 12 4l9 4-9 4-9-4Z" />
      <path d="M3 8v9l9 4 9-4V8" />
      <path d="M12 12v9" />
    </svg>
  )
}

export function IconSpark({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" strokeLinejoin="round" />
    </svg>
  )
}

export function IconPin({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="12" cy="10" r="3" />
      <path d="M12 21c4-5 7-8.5 7-12a7 7 0 0 0-14 0c0 3.5 3 7 7 12Z" />
    </svg>
  )
}

export function IconPrinter({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M7 9V3h10v6" />
      <rect x="4" y="9" width="16" height="8" rx="1.5" />
      <path d="M7 14h10v7H7z" />
    </svg>
  )
}

export function IconChair({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M6 4v9h12V4" />
      <path d="M6 13v7M18 13v7M6 17h12" />
    </svg>
  )
}

export function IconUsers({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c.8-3.4 3-5 6-5s5.2 1.6 6 5" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8M20.5 19c-.6-2.5-1.8-3.9-3.5-4.6" />
    </svg>
  )
}

export function IconGhost({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M5 20V11a7 7 0 0 1 14 0v9l-2.5-2-2 2-2.5-2-2 2-2.5-2Z" />
      <path d="M9.5 11h.01M14.5 11h.01" />
    </svg>
  )
}

export function IconX({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M5 5l14 14M19 5 5 19" />
    </svg>
  )
}

export function IconWarning({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M12 3 22 20H2Z" strokeLinejoin="round" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  )
}

export function IconCheck({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M4 13l5 5L20 6" />
    </svg>
  )
}

export function IconTrash({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

export function IconPencil({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M4 20l.8-4L16 4.8a1.5 1.5 0 0 1 2.1 0l1.1 1.1a1.5 1.5 0 0 1 0 2.1L8 19.2 4 20Z" strokeLinejoin="round" />
      <path d="M14 6.5 17.5 10" />
    </svg>
  )
}

export function IconSearch({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.5-4.5" />
    </svg>
  )
}

export function IconSettings({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5M18.4 18.4l-1.5-1.5M7.1 7.1 5.6 5.6" />
    </svg>
  )
}

export function IconRefresh({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M4 12a8 8 0 0 1 14-5.3L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-14 5.3L4 16" />
      <path d="M4 20v-4h4" />
    </svg>
  )
}

export function IconBell({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M6 17h12l-1.5-2.5V10a4.5 4.5 0 0 0-9 0v4.5Z" strokeLinejoin="round" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  )
}

export function IconGlobe({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
    </svg>
  )
}

export function IconCash({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <rect x="2.5" y="6.5" width="19" height="11" rx="1.5" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

export function IconCard({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <rect x="2.5" y="5.5" width="19" height="13" rx="1.5" />
      <path d="M2.5 10h19" />
    </svg>
  )
}

export function IconTag({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M12 3h6a1.5 1.5 0 0 1 1.5 1.5v6L10 20 3.5 13.5 12 3Z" strokeLinejoin="round" />
      <circle cx="16" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconEye({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  )
}
