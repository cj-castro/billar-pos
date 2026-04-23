import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../hooks/useLanguage'
import { useQuery } from '@tanstack/react-query'
import client from '../api/client'

export default function NavBar() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { lang, setLanguage } = useLanguage()
  const [menuOpen, setMenuOpen] = useState(false)

  // Queue counts — poll every 20s, includes SENT + IN_PROGRESS + READY
  const { data: queueCounts } = useQuery({
    queryKey: ['queue-counts'],
    queryFn: () => client.get('/queue/counts').then(r => r.data),
    refetchInterval: 20_000,
    enabled: !!user,
    staleTime: 10_000,
  })
  const kitchenCount: number = queueCounts?.kitchen ?? 0
  const barCount: number = queueCounts?.bar ?? 0

  const handleLogout = async () => {
    try { await client.post('/auth/logout') } catch {}
    logout()
    navigate('/login')
    setMenuOpen(false)
  }

  const toggleLang = () => setLanguage(lang === 'es' ? 'en' : 'es')
  const close = () => setMenuOpen(false)

  const showKitchen = user && ['KITCHEN_STAFF','BAR_STAFF','WAITER','MANAGER','ADMIN'].includes(user.role)
  const showBar     = user && ['KITCHEN_STAFF','BAR_STAFF','WAITER','MANAGER','ADMIN'].includes(user.role)
  const showManager = user && ['MANAGER','ADMIN'].includes(user.role)
  const showSafe    = user?.role === 'ADMIN'

  // Badge for desktop nav links
  const Badge = ({ count }: { count: number }) =>
    count > 0 ? (
      <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
        {count > 99 ? '99+' : count}
      </span>
    ) : null

  // Bottom tab item helper
  const isActive = (path: string) => location.pathname.startsWith(path)

  const tabCls = (active: boolean) =>
    `relative flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-[10px] font-semibold transition-colors
     ${active ? 'text-sky-400' : 'text-slate-400 active:text-white'}`

  return (
    <>
      {/* ── Top bar ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-slate-900 border-b border-slate-700 px-4 py-2.5 flex items-center justify-between">
        {/* Logo */}
        <Link to="/floor" className="flex items-center gap-2 flex-shrink-0" onClick={close}>
          <img src="/logo.jpg" alt="Bola 8" className="w-8 h-8 rounded-full object-cover border border-slate-600" />
          <span className="text-lg font-bold text-sky-400">Bola 8</span>
        </Link>

        {/* Desktop nav links */}
        {user && (
          <div className="hidden md:flex gap-5 text-sm items-center">
            <Link to="/floor" className={`hover:text-white transition-colors ${isActive('/floor') ? 'text-white font-semibold' : 'text-slate-300'}`}>
              {t('nav.floor')}
            </Link>
            {showKitchen && (
              <Link to="/queue/kitchen" className={`hover:text-white transition-colors flex items-center gap-0.5 ${isActive('/queue/kitchen') ? 'text-white font-semibold' : 'text-slate-300'}`}>
                {t('nav.kitchen')}<Badge count={kitchenCount} />
              </Link>
            )}
            {showBar && (
              <Link to="/queue/bar" className={`hover:text-white transition-colors flex items-center gap-0.5 ${isActive('/queue/bar') ? 'text-white font-semibold' : 'text-slate-300'}`}>
                {t('nav.bar')}<Badge count={barCount} />
              </Link>
            )}
            {showManager && (
              <Link to="/manager" className={`hover:text-white transition-colors ${isActive('/manager') ? 'text-white font-semibold' : 'text-slate-300'}`}>
                {t('nav.manager')}
              </Link>
            )}
            {showSafe && (
              <Link to="/manager/safe" className="text-emerald-400 hover:text-emerald-300">🔐 Caja</Link>
            )}
          </div>
        )}

        {/* Desktop right: user + lang + logout */}
        {user && (
          <div className="hidden md:flex items-center gap-3">
            <span className="text-xs text-slate-400">{user.name} · <span className="text-sky-400 capitalize">{user.role.toLowerCase().replace('_', ' ')}</span></span>
            <button onClick={toggleLang} className="text-base px-2 py-1 rounded hover:bg-slate-700">{lang === 'es' ? '🇲🇽' : '🇺🇸'}</button>
            <button onClick={handleLogout} className="text-sm text-red-400 hover:text-red-300 border border-red-800 px-3 py-1 rounded">
              {t('nav.logout')}
            </button>
          </div>
        )}

        {/* Mobile top-right: lang only */}
        {user && (
          <div className="flex md:hidden items-center gap-1">
            <button onClick={toggleLang} className="text-base px-2 py-1 rounded hover:bg-slate-700">{lang === 'es' ? '🇲🇽' : '🇺🇸'}</button>
          </div>
        )}
      </nav>

      {/* ── Mobile bottom tab bar ── */}
      {user && (
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-slate-900 border-t border-slate-700 flex items-stretch safe-area-inset-bottom">

          {/* Floor */}
          <Link to="/floor" onClick={close} className={tabCls(isActive('/floor') && !isActive('/queue'))}>
            <span className="text-xl">🏠</span>
            <span>{t('nav.floor')}</span>
          </Link>

          {/* Kitchen */}
          {showKitchen && (
            <Link to="/queue/kitchen" onClick={close} className={tabCls(isActive('/queue/kitchen'))}>
              {kitchenCount > 0 && (
                <span className="absolute top-1 right-[calc(50%-18px)] min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                  {kitchenCount > 99 ? '99+' : kitchenCount}
                </span>
              )}
              <span className="text-xl">🍳</span>
              <span>{t('nav.kitchen')}</span>
            </Link>
          )}

          {/* Bar */}
          {showBar && (
            <Link to="/queue/bar" onClick={close} className={tabCls(isActive('/queue/bar'))}>
              {barCount > 0 && (
                <span className="absolute top-1 right-[calc(50%-18px)] min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                  {barCount > 99 ? '99+' : barCount}
                </span>
              )}
              <span className="text-xl">🍺</span>
              <span>{t('nav.bar')}</span>
            </Link>
          )}

          {/* Manager */}
          {showManager && (
            <Link to="/manager" onClick={close} className={tabCls(isActive('/manager'))}>
              <span className="text-xl">📊</span>
              <span>{t('nav.manager')}</span>
            </Link>
          )}

          {/* Account / logout */}
          <button onClick={() => setMenuOpen(o => !o)} className={tabCls(menuOpen)}>
            <span className="text-xl">👤</span>
            <span>{user.name.split(' ')[0]}</span>
          </button>
        </nav>
      )}

      {/* Mobile account popup (logout, safe, lang already in top bar) */}
      {menuOpen && user && (
        <div className="md:hidden fixed bottom-[57px] left-0 right-0 z-40 bg-slate-900 border-t border-slate-700 shadow-2xl">
          <div className="flex flex-col divide-y divide-slate-700">
            <div className="px-4 py-3 text-sm text-slate-300">
              <span className="font-semibold">{user.name}</span>
              <span className="ml-2 text-xs text-sky-400 capitalize">{user.role.toLowerCase().replace('_', ' ')}</span>
            </div>
            {showSafe && (
              <Link to="/manager/safe" onClick={close} className="px-4 py-3 text-emerald-400 hover:bg-slate-800 active:bg-slate-700 text-sm">
                🔐 Caja Fuerte
              </Link>
            )}
            <button onClick={handleLogout} className="px-4 py-3 text-left text-red-400 hover:bg-slate-800 active:bg-slate-700 text-sm">
              🚪 {t('nav.logout')}
            </button>
          </div>
        </div>
      )}

      {/* Spacer — top */}
      <div className="h-[53px]" />
    </>
  )
}
