import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../hooks/useLanguage'
import client from '../api/client'

export default function NavBar() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { lang, setLanguage } = useLanguage()

  const handleLogout = async () => {
    try { await client.post('/auth/logout') } catch {}
    logout()
    navigate('/login')
  }

  const toggleLang = () => setLanguage(lang === 'es' ? 'en' : 'es')

  return (
    <nav className="bg-slate-900 border-b border-slate-700 px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <Link to="/floor" className="flex items-center gap-2">
          <img src="/logo.jpg" alt="Bola 8" className="w-8 h-8 rounded-full object-cover border border-slate-600" />
          <span className="text-xl font-bold text-sky-400">Bola 8 POS</span>
        </Link>
        {user && (
          <div className="flex gap-4 text-sm">
            <Link to="/floor" className="text-slate-300 hover:text-white">{t('nav.floor')}</Link>
            {(user.role === 'KITCHEN_STAFF' || user.role === 'MANAGER' || user.role === 'ADMIN') && (
              <Link to="/queue/kitchen" className="text-slate-300 hover:text-white">{t('nav.kitchen')}</Link>
            )}
            {(user.role === 'BAR_STAFF' || user.role === 'MANAGER' || user.role === 'ADMIN') && (
              <Link to="/queue/bar" className="text-slate-300 hover:text-white">{t('nav.bar')}</Link>
            )}
            {(user.role === 'MANAGER' || user.role === 'ADMIN') && (
              <Link to="/manager" className="text-slate-300 hover:text-white">{t('nav.manager')}</Link>
            )}
          </div>
        )}
      </div>
      {user && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-400">{user.name} · <span className="text-sky-400">{user.role}</span></span>
          <button
            onClick={toggleLang}
            title={t('common.language')}
            className="text-lg leading-none px-2 py-1 rounded hover:bg-slate-700 transition-colors"
          >
            {lang === 'es' ? '🇲🇽' : '🇺🇸'}
          </button>
          <button onClick={handleLogout} className="text-sm text-red-400 hover:text-red-300 border border-red-800 px-3 py-1 rounded">
            {t('nav.logout')}
          </button>
        </div>
      )}
    </nav>
  )
}
