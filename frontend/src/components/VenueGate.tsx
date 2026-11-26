import React, { useRef, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import client from '../api/client'
import { getVenue, onVenueChange, setVenue, Venue } from '../utils/venue'

/** Current venue; re-renders when the owner changes it in Ajustes. */
export function useVenue(): Venue {
  return useSyncExternalStore(onVenueChange, getVenue)
}

/**
 * Loads the venue (name, timezone, currency, locale, logo) before rendering the
 * app, so the first screen already shows the right name and formats money and
 * dates correctly. If the server can't be reached it renders with the defaults
 * rather than blocking the POS.
 */
export function VenueGate({ children }: { children: React.ReactNode }) {
  const q = useQuery<Venue>({
    queryKey: ['venue'],
    queryFn: () => client.get('/venue').then(r => r.data),
    staleTime: Infinity,
    retry: 1,
  })
  const applied = useRef<Venue | null>(null)
  if (q.data && q.data !== applied.current) {
    applied.current = q.data
    setVenue(q.data)          // idempotent; formatters read it synchronously
  }
  if (q.isLoading) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">…</div>
  }
  return <>{children}</>
}
