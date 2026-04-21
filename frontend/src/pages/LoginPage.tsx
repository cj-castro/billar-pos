import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import client from '../api/client'
import toast from 'react-hot-toast'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const login = useAuthStore((s) => s.login)
  const navigate = useNavigate()
  const { t } = useTranslation()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await client.post('/auth/login', { username, password })
      login(res.data.user, res.data.access_token)
      const role = res.data.user.role
      if (role === 'KITCHEN_STAFF') navigate('/queue/kitchen')
      else if (role === 'BAR_STAFF') navigate('/queue/bar')
      else navigate('/floor')
    } catch (err: any) {
      toast.error(err.response?.data?.message || t('login.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="bg-slate-800 rounded-2xl p-8 w-full max-w-sm border border-slate-700 shadow-2xl">
        <div className="text-center mb-8">
          <img src="/logo.jpg" alt="Bola 8 Pool Club" className="w-24 h-24 rounded-full object-cover mx-auto mb-3 border-2 border-sky-500 shadow-xl" />
          <h1 className="text-2xl font-bold">Bola 8 Pool Club</h1>
          <p className="text-slate-400 text-sm mt-1">{t('login.title')}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-slate-400 block mb-1">{t('login.username')}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 focus:outline-none focus:border-sky-500"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm text-slate-400 block mb-1">{t('login.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 focus:outline-none focus:border-sky-500"
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full py-3 bg-sky-600 hover:bg-sky-500 rounded-lg font-bold text-lg disabled:opacity-50 transition-colors"
          >
            {loading ? t('common.loading') : t('login.submit')}
          </button>
        </form>
        <p className="text-center text-xs text-slate-500 mt-6">Default: admin / admin123</p>
      </div>
    </div>
  )
}
