import NavBar from '../../components/NavBar'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../../hooks/useLanguage'
import toast from 'react-hot-toast'

export default function SettingsPage() {
  const { t } = useTranslation()
  const { lang, setLanguage } = useLanguage()

  const handleChange = (newLang: 'es' | 'en') => {
    setLanguage(newLang)
    toast.success(t('settings.saved'))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <NavBar />
      <div className="max-w-lg mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">⚙️ {t('settings.title')}</h1>

        <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700">
          <div className="font-semibold mb-4">🌐 {t('settings.language')}</div>
          <div className="flex gap-3">
            <button
              onClick={() => handleChange('es')}
              className={`flex-1 py-4 rounded-xl font-bold text-lg border-2 transition-all ${
                lang === 'es'
                  ? 'bg-sky-600 border-sky-400 text-white'
                  : 'bg-slate-700 border-slate-600 hover:border-sky-600'
              }`}
            >
              🇲🇽 {t('settings.spanish')}
            </button>
            <button
              onClick={() => handleChange('en')}
              className={`flex-1 py-4 rounded-xl font-bold text-lg border-2 transition-all ${
                lang === 'en'
                  ? 'bg-sky-600 border-sky-400 text-white'
                  : 'bg-slate-700 border-slate-600 hover:border-sky-600'
              }`}
            >
              🇺🇸 {t('settings.english')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
