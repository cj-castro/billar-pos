import React from 'react'

/**
 * One way to show loading / error / refreshing for a data screen (batch C).
 *
 * Before this, screens rendered "Sin datos." on a 403 or a 500, so a failure
 * looked like an empty day; and with keepPreviousData the OLD range's numbers
 * stayed on screen while new ones loaded, with nothing saying so.
 */
export function QueryState({ query, children, emptyText }: {
  query: { isLoading: boolean; isError: boolean; isFetching?: boolean; error?: any; data?: any; refetch?: () => void }
  children: React.ReactNode
  emptyText?: string
}) {
  if (query.isLoading) {
    return <div className="text-slate-500 text-sm p-6 text-center animate-pulse">Cargando…</div>
  }
  if (query.isError) {
    const status = query.error?.response?.status
    const msg = status === 403 ? 'No tienes permiso para ver esta información.'
      : status === 503 ? (query.error?.response?.data?.hint || 'Esta sección no está instalada en el servidor.')
      : query.error?.response?.data?.message || 'No se pudo cargar. Revisa la conexión con el servidor.'
    return (
      <div className="bg-red-950/40 border border-red-800 text-red-200 rounded-xl p-4 text-sm flex items-center justify-between gap-3">
        <span>⚠ {msg}</span>
        {query.refetch && status !== 403 && (
          <button onClick={() => query.refetch!()} className="shrink-0 underline font-semibold">Reintentar</button>
        )}
      </div>
    )
  }
  if (query.data == null && emptyText) {
    return <div className="text-slate-500 text-sm p-6 text-center">{emptyText}</div>
  }
  return (
    <div className="relative">
      {query.isFetching && (
        <div className="absolute -top-3 right-0 text-[11px] text-sky-400 animate-pulse">actualizando…</div>
      )}
      {children}
    </div>
  )
}

/** Status line only (no children): for screens with many conditional sections. */
export function QueryStatus({ query }: {
  query?: { isLoading?: boolean; isError?: boolean; isFetching?: boolean; error?: any; refetch?: () => void }
}) {
  if (!query) return null
  if (query.isError) {
    const status = query.error?.response?.status
    return (
      <div className="bg-red-950/40 border border-red-800 text-red-200 rounded-xl p-3 mb-3 text-sm flex justify-between gap-3">
        <span>⚠ {status === 403 ? 'No tienes permiso para ver este reporte.'
          : query.error?.response?.data?.message || 'No se pudo cargar el reporte.'}</span>
        {query.refetch && status !== 403 && (
          <button onClick={() => query.refetch!()} className="underline font-semibold shrink-0">Reintentar</button>
        )}
      </div>
    )
  }
  if (query.isLoading) return <div className="text-slate-500 text-sm mb-3 animate-pulse">Cargando…</div>
  if (query.isFetching) return <div className="text-sky-400 text-xs mb-3 animate-pulse">actualizando…</div>
  return null
}
