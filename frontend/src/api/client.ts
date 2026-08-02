import axios from 'axios'
import { useAuthStore } from '../stores/authStore'

const client = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Track whether a refresh is in-flight to avoid multiple concurrent refresh calls
let isRefreshing = false
let pendingQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = []

function drainQueue(token: string) {
  pendingQueue.forEach(({ resolve }) => resolve(token))
  pendingQueue = []
}
function rejectQueue(err: unknown) {
  pendingQueue.forEach(({ reject }) => reject(err))
  pendingQueue = []
}

client.interceptors.response.use(
  (r) => r,
  async (err) => {
    const originalRequest = err.config

    if (err.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      const refreshToken = useAuthStore.getState().refreshToken
      if (!refreshToken) {
        useAuthStore.getState().logout()
        window.location.href = '/login'
        return Promise.reject(err)
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          pendingQueue.push({
            resolve: (token) => {
              originalRequest.headers.Authorization = `Bearer ${token}`
              resolve(client(originalRequest))
            },
            reject,
          })
        })
      }

      isRefreshing = true
      try {
        const res = await axios.post('/api/v1/auth/refresh', null, {
          headers: { Authorization: `Bearer ${refreshToken}` },
        })
        const newToken: string = res.data.access_token
        useAuthStore.getState().setAccessToken(newToken)
        drainQueue(newToken)
        originalRequest.headers.Authorization = `Bearer ${newToken}`
        return client(originalRequest)
      } catch (refreshErr) {
        rejectQueue(refreshErr)
        useAuthStore.getState().logout()
        window.location.href = '/login'
        return Promise.reject(refreshErr)
      } finally {
        isRefreshing = false
      }
    }

    return Promise.reject(err)
  }
)

export default client
