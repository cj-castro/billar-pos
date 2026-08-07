import type { ReactNode } from 'react'

type Align = 'center' | 'start' | 'bottom-sheet'
type Opacity = 70 | 75 | 80 | 85
type ZIndex = 50 | 60 | 80

// Literal class maps (not string interpolation) so Tailwind's JIT scanner
// can find every class — see DESIGN.md Components > Navigation > Modals.
const ALIGN_CLASS: Record<Align, string> = {
  center: 'items-center',
  start: 'items-start',
  'bottom-sheet': 'items-end sm:items-center',
}
const OPACITY_CLASS: Record<Opacity, string> = {
  70: 'bg-black/70',
  75: 'bg-black/75',
  80: 'bg-black/80',
  85: 'bg-black/85',
}
const Z_CLASS: Record<ZIndex, string> = {
  50: 'z-50',
  60: 'z-[60]',
  80: 'z-[80]',
}

interface ModalProps {
  children: ReactNode
  align?: Align
  opacity?: Opacity
  z?: ZIndex
  scrollable?: boolean
  padding?: string
}

// The backdrop + positioning shell shared by every modal in the app. Callers
// own the inner card (header/body/footer) since that structure genuinely
// varies; this only extracts the truly-identical outer wrapper.
export default function Modal({ children, align = 'center', opacity = 75, z = 50, scrollable = false, padding = 'p-4' }: ModalProps) {
  return (
    <div className={`fixed inset-0 ${OPACITY_CLASS[opacity]} flex ${ALIGN_CLASS[align]} justify-center ${Z_CLASS[z]} ${padding} ${scrollable ? 'overflow-y-auto' : ''}`}>
      {children}
    </div>
  )
}
