import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import client from '../api/client'
import toast from 'react-hot-toast'
import { IconBall8 } from '../components/Icon'

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
      login(res.data.user, res.data.access_token, res.data.refresh_token)
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
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="bg-zinc-800 rounded-2xl p-8 w-full max-w-sm border border-zinc-700 shadow-2xl">
        <div className="text-center mb-8">
          <div className="w-24 h-24 rounded-full border border-dashed border-zinc-500 flex items-center justify-center relative mx-auto mb-4">
            <div className="absolute inset-[6px] rounded-full border border-zinc-600" />
            <IconBall8 className="w-10 h-10 text-white relative" />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">Bola 8 Pool Club</h1>
          <p className="text-zinc-400 text-sm mt-1.5">{t('login.title')}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-zinc-400 block mb-1">{t('login.username')}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-4 py-3 focus:outline-none focus:border-zinc-400"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm text-zinc-400 block mb-1">{t('login.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-700 border border-zinc-600 rounded-lg px-4 py-3 focus:outline-none focus:border-zinc-400"
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full py-3.5 bg-white text-zinc-900 hover:bg-zinc-200 rounded-lg font-extrabold text-xl disabled:opacity-50 transition-colors"
          >
            {loading ? t('common.loading') : t('login.submit')}
          </button>
        </form>
        
      </div>
    </div>
  )
}
