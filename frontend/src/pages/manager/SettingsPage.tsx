import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../../hooks/useLanguage'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import client from '../../api/client'
import toast from 'react-hot-toast'

export default function SettingsPage() {
  const { t } = useTranslation()
  const { lang, setLanguage } = useLanguage()
  const qc = useQueryClient()

  const handleChange = (newLang: 'es' | 'en') => {
    setLanguage(newLang)
    toast.success(t('settings.saved'))
  }

  // KDS sound setting
  const { data: kdsSound, isLoading: kdsSoundLoading } = useQuery({
    queryKey: ['settings', 'kds_sound_enabled'],
    queryFn: () => client.get('/settings/kds_sound_enabled').then((r) => r.data.value === 'true'),
    staleTime: 30_000,
  })

  const toggleKDSSound = async () => {
    const newValue = kdsSound === false ? 'true' : 'false'
    await client.put('/settings/kds_sound_enabled', { value: newValue })
    qc.invalidateQueries({ queryKey: ['settings', 'kds_sound_enabled'] })
    toast.success(t('settings.saved'))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-lg mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">⚙️ {t('settings.title')}</h1>

        <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 mb-4">
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

        <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700">
          <div className="font-semibold mb-1">🔔 Alerta sonora KDS</div>
          <div className="text-sm text-slate-400 mb-4">
            Activa o desactiva el beep de alerta en las pantallas de cocina y barra cuando hay
            pedidos en espera. El efecto es inmediato en todos los dispositivos.
          </div>
          <button
            onClick={toggleKDSSound}
            disabled={kdsSoundLoading}
            className={`w-full py-4 rounded-xl font-bold text-lg border-2 transition-all disabled:opacity-40 ${
              kdsSound !== false
                ? 'bg-green-700 border-green-500 text-white'
                : 'bg-slate-700 border-slate-600 text-slate-300'
            }`}
          >
            {kdsSound !== false ? '🔔 Sonido activo — toca para desactivar' : '🔕 Sonido desactivado — toca para activar'}
          </button>
        </div>
      </div>
    </div>
  )
}
