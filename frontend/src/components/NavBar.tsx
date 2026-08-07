import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../hooks/useLanguage'
import { useQuery } from '@tanstack/react-query'
import client from '../api/client'
import { IconHouse, IconFlame, IconMug, IconChart, IconUser, IconLock, IconTrend, IconDoor } from './Icon'

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
      <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold leading-none">
        {count > 99 ? '99+' : count}
      </span>
    ) : null

  // Bottom tab item helper
  const isActive = (path: string) => location.pathname.startsWith(path)

  const tabCls = (active: boolean) =>
    `relative flex flex-col items-center justify-center flex-1 py-2 gap-1 text-[10px] font-semibold transition-colors
     ${active ? 'text-white' : 'text-zinc-500 active:text-white'}`

  return (
    <>
      {/* ── Top bar ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-zinc-950 border-b border-zinc-800 px-4 py-2.5 flex items-center justify-between">
        {/* Crest mark */}
        <Link to="/floor" className="flex items-center gap-3 flex-shrink-0" onClick={close}>
          <img src="/logo-mark.png" alt="Bola 8 Pool Club" className="w-9 h-9 flex-shrink-0" />
          <div className="leading-none">
            <div className="font-display font-extrabold text-lg tracking-tight text-white">BOLA 8</div>
            <div className="text-[9px] tracking-[.22em] text-zinc-500 font-semibold uppercase mt-0.5">Pool Club</div>
          </div>
        </Link>

        {/* Desktop nav links */}
        {user && (
          <div className="hidden md:flex gap-6 text-sm items-center">
            <Link to="/floor" className={`hover:text-white transition-colors ${isActive('/floor') ? 'text-white font-semibold' : 'text-zinc-400'}`}>
              {t('nav.floor')}
            </Link>
            {showKitchen && (
              <Link to="/queue/kitchen" className={`hover:text-white transition-colors flex items-center gap-0.5 ${isActive('/queue/kitchen') ? 'text-white font-semibold' : 'text-zinc-400'}`}>
                {t('nav.kitchen')}<Badge count={kitchenCount} />
              </Link>
            )}
            {showBar && (
              <Link to="/queue/bar" className={`hover:text-white transition-colors flex items-center gap-0.5 ${isActive('/queue/bar') ? 'text-white font-semibold' : 'text-zinc-400'}`}>
                {t('nav.bar')}<Badge count={barCount} />
              </Link>
            )}
            {showManager && (
              <Link to="/manager" className={`hover:text-white transition-colors ${isActive('/manager') ? 'text-white font-semibold' : 'text-zinc-400'}`}>
                {t('nav.manager')}
              </Link>
            )}
            {showSafe && (
              <Link to="/manager/safe" className="flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300">
                <IconLock className="w-3.5 h-3.5" />Caja
              </Link>
            )}
            {showSafe && (
              <Link to="/manager/earnings" className="flex items-center gap-1.5 text-violet-400 hover:text-violet-300">
                <IconTrend className="w-3.5 h-3.5" />Ganancias
              </Link>
            )}
          </div>
        )}

        {/* Desktop right: user + lang + logout */}
        {user && (
          <div className="hidden md:flex items-center gap-3">
            <span className="text-xs text-zinc-500">{user.name} · <span className="text-zinc-300 capitalize">{user.role.toLowerCase().replace('_', ' ')}</span></span>
            <button onClick={toggleLang} className="text-base px-2 py-1 rounded hover:bg-zinc-800">{lang === 'es' ? '🇲🇽' : '🇺🇸'}</button>
            <button onClick={handleLogout} className="flex items-center gap-1.5 text-sm text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded">
              <IconDoor className="w-3.5 h-3.5" />{t('nav.logout')}
            </button>
          </div>
        )}

        {/* Mobile top-right: lang only */}
        {user && (
          <div className="flex md:hidden items-center gap-1">
            <button onClick={toggleLang} className="text-base px-2 py-1 rounded hover:bg-zinc-800">{lang === 'es' ? '🇲🇽' : '🇺🇸'}</button>
          </div>
        )}
      </nav>

      {/* ── Mobile bottom tab bar ── */}
      {user && (
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-zinc-950 border-t border-zinc-800 flex items-stretch safe-area-inset-bottom">

          {/* Floor */}
          <Link to="/floor" onClick={close} className={tabCls(isActive('/floor') && !isActive('/queue'))}>
            <IconHouse className="w-5 h-5" />
            <span>{t('nav.floor')}</span>
          </Link>

          {/* Kitchen */}
          {showKitchen && (
            <Link to="/queue/kitchen" onClick={close} className={tabCls(isActive('/queue/kitchen'))}>
              {kitchenCount > 0 && (
                <span className="absolute top-1 right-[calc(50%-18px)] min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold leading-none">
                  {kitchenCount > 99 ? '99+' : kitchenCount}
                </span>
              )}
              <IconFlame className="w-5 h-5" />
              <span>{t('nav.kitchen')}</span>
            </Link>
          )}

          {/* Bar */}
          {showBar && (
            <Link to="/queue/bar" onClick={close} className={tabCls(isActive('/queue/bar'))}>
              {barCount > 0 && (
                <span className="absolute top-1 right-[calc(50%-18px)] min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold leading-none">
                  {barCount > 99 ? '99+' : barCount}
                </span>
              )}
              <IconMug className="w-5 h-5" />
              <span>{t('nav.bar')}</span>
            </Link>
          )}

          {/* Manager */}
          {showManager && (
            <Link to="/manager" onClick={close} className={tabCls(isActive('/manager'))}>
              <IconChart className="w-5 h-5" />
              <span>{t('nav.manager')}</span>
            </Link>
          )}

          {/* Account / logout */}
          <button onClick={() => setMenuOpen(o => !o)} className={tabCls(menuOpen)}>
            <IconUser className="w-5 h-5" />
            <span>{user.name.split(' ')[0]}</span>
          </button>
        </nav>
      )}

      {/* Mobile account popup (logout, safe, lang already in top bar) */}
      {menuOpen && user && (
        <div className="md:hidden fixed bottom-[57px] left-0 right-0 z-40 bg-zinc-950 border-t border-zinc-800 shadow-2xl">
          <div className="flex flex-col divide-y divide-zinc-800">
            <div className="px-4 py-3 text-sm text-zinc-300">
              <span className="font-semibold">{user.name}</span>
              <span className="ml-2 text-xs text-zinc-400 capitalize">{user.role.toLowerCase().replace('_', ' ')}</span>
            </div>
            {showSafe && (
              <Link to="/manager/safe" onClick={close} className="px-4 py-3 flex items-center gap-2 text-emerald-400 hover:bg-zinc-800 active:bg-zinc-700 text-sm">
                <IconLock className="w-4 h-4" />Caja Fuerte
              </Link>
            )}
            {showSafe && (
              <Link to="/manager/earnings" onClick={close} className="px-4 py-3 flex items-center gap-2 text-violet-400 hover:bg-zinc-800 active:bg-zinc-700 text-sm">
                <IconTrend className="w-4 h-4" />Ganancias
              </Link>
            )}
            <button onClick={handleLogout} className="px-4 py-3 flex items-center gap-2 text-left text-red-400 hover:bg-zinc-800 active:bg-zinc-700 text-sm">
              <IconDoor className="w-4 h-4" />{t('nav.logout')}
            </button>
          </div>
        </div>
      )}

      {/* Spacer — top */}
      <div className="h-[57px]" />
    </>
  )
}
