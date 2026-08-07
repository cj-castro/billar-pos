import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import NavBar from '../../components/NavBar'
import { useAuthStore } from '../../stores/authStore'

export default function ManagerDashboard() {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'ADMIN'

  const tiles = [
    { to: '/manager/cash', icon: '💰', label: t('manager.cashSession'), desc: t('manager.desc.cashSession') },
    { to: '/manager/inventory', icon: '📦', label: t('manager.inventory'), desc: t('manager.desc.inventory') },
    { to: '/manager/menu', icon: '🍽️', label: t('manager.menu'), desc: t('manager.desc.menu') },
    { to: '/manager/modifiers', icon: '🧩', label: t('manager.modifiers'), desc: t('manager.desc.modifiers') },
    { to: '/manager/promotions', icon: '🏷️', label: t('manager.promotions'), desc: t('manager.desc.promotions') },
    { to: '/manager/users', icon: '👥', label: t('manager.users'), desc: t('manager.desc.users') },
    { to: '/manager/pool-config', icon: '🕒', label: t('manager.poolBilling'), desc: t('manager.desc.poolBilling') },
    { to: '/manager/tables', icon: '🗂', label: t('manager.tableSetup'), desc: t('manager.desc.tableSetup') },
    { to: '/floor', icon: '🎱', label: t('manager.floorView'), desc: t('manager.desc.floorView') },
    { to: '/manager/settings', icon: '⚙️', label: t('manager.settings'), desc: t('manager.desc.settings') },
  ]

  const adminTiles = [
    { to: '/manager/reports', icon: '📊', label: t('manager.reports'), desc: t('manager.desc.reports') },
    { to: '/manager/earnings', icon: '💹', label: t('manager.earnings'), desc: t('manager.desc.earnings') },
    { to: '/manager/analytics', icon: '🧠', label: t('manager.analytics'), desc: t('manager.desc.analytics') },
  ]

  // The 3 screens a manager actually opens every shift get a featured
  // treatment; everything else (setup, occasional config) stays compact.
  // Real hierarchy from the system's own vocabulary — size, weight, color —
  // not a new visual language.
  const FEATURED = new Set(['/floor', '/manager/cash', '/manager/inventory'])

  return (
    <div className="min-h-screen bg-zinc-950 page-root">
      <NavBar />
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-3xl font-extrabold mb-6 tracking-tight">{t('manager.title')}</h1>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {tiles.map((t) => {
            const featured = FEATURED.has(t.to)
            return (
              <Link key={t.to} to={t.to}
                className={featured
                  ? 'col-span-2 bg-zinc-800 hover:bg-zinc-700 rounded-2xl p-6 border-2 border-zinc-600 hover:border-white transition-all'
                  : 'bg-zinc-800 hover:bg-zinc-700 rounded-2xl p-4 border border-zinc-700 hover:border-white transition-all'}>
                <div className={featured ? 'text-5xl mb-3' : 'text-2xl mb-1.5'}>{t.icon}</div>
                <div className={featured ? 'font-extrabold text-lg' : 'font-semibold text-sm'}>{t.label}</div>
                <div className={featured ? 'text-sm text-zinc-400 mt-1' : 'text-[11px] text-zinc-500 mt-0.5'}>{t.desc}</div>
              </Link>
            )
          })}
          {isAdmin && adminTiles.map((t) => (
            <Link key={t.to} to={t.to} className="bg-zinc-800 hover:bg-zinc-700 rounded-2xl p-4 border border-violet-800 hover:border-violet-500 transition-all">
              <div className="text-2xl mb-1.5">{t.icon}</div>
              <div className="font-semibold text-sm text-violet-300">{t.label}</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">{t.desc}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
