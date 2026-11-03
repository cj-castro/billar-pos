import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './i18n'
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      // Keep showing the last server payload while a refetch is in flight so a
      // key change never flashes an empty floor or waiting list.
      placeholderData: keepPreviousData,
      // Survive a backgrounded tab / disconnected shift: an inactive query used
      // to be evicted after 5 min, so returning to it rendered the `= []`
      // destructuring default before the refetch landed.
      gcTime: 60 * 60_000,
      // A dropped socket means we missed events; refetch rather than trust cache.
      refetchOnReconnect: 'always',
      // Retries must not resolve to undefined data while offline: keep the
      // cached payload and retry when the browser regains connectivity.
      networkMode: 'offlineFirst',
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster position="top-right" />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
