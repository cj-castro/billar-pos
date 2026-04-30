import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import NavBar from '../../components/NavBar'
import { useAuthStore } from '../../stores/authStore'

export default function ManagerDashboard() {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'ADMIN'

  const tiles = [
    { to: '/manager/cash', icon: '💰', label: t('manager.cashSession'), desc: 'Open/close bar, tips, expenses' },
    { to: '/manager/inventory', icon: '📦', label: t('manager.inventory'), desc: 'Stock levels & adjustments' },
    { to: '/manager/menu', icon: '🍽️', label: t('manager.menu'), desc: 'Artículos, precios, modificadores' },
    { to: '/manager/modifiers', icon: '🧩', label: 'Modificadores', desc: 'Grupos de sabores, salsas, extras' },
    { to: '/manager/users', icon: '👥', label: t('manager.users'), desc: 'Manage staff accounts' },
    { to: '/manager/pool-config', icon: '🕒', label: t('manager.poolBilling'), desc: 'Rates, modes & free minutes' },
    { to: '/manager/tables', icon: '🗂', label: t('manager.tableSetup'), desc: 'Add/remove pool, floor & bar seats' },
    { to: '/floor', icon: '🎱', label: t('manager.floorView'), desc: 'Live table status' },
    { to: '/manager/settings', icon: '⚙️', label: t('manager.settings'), desc: 'Language & preferences' },
  ]

  const adminTiles = [
    { to: '/manager/reports', icon: '📊', label: t('manager.reports'), desc: 'Sales, pool time, payments' },
    { to: '/manager/earnings', icon: '💹', label: 'Ganancias', desc: 'Ingresos, COGS, margen bruto' },
  ]

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">{t('manager.title')}</h1>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {tiles.map((t) => (
            <Link key={t.to} to={t.to} className="bg-slate-800 hover:bg-slate-700 rounded-2xl p-5 border border-slate-700 hover:border-sky-600 transition-all">
              <div className="text-3xl mb-2">{t.icon}</div>
              <div className="font-bold">{t.label}</div>
              <div className="text-xs text-slate-400 mt-1">{t.desc}</div>
            </Link>
          ))}
          {isAdmin && adminTiles.map((t) => (
            <Link key={t.to} to={t.to} className="bg-slate-800 hover:bg-slate-700 rounded-2xl p-5 border border-violet-800 hover:border-violet-500 transition-all">
              <div className="text-3xl mb-2">{t.icon}</div>
              <div className="font-bold text-violet-300">{t.label}</div>
              <div className="text-xs text-slate-400 mt-1">{t.desc}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
