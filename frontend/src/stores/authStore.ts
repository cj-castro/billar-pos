import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface User {
  id: string
  username: string
  name: string
  role: string
}

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  login: (user: User, accessToken: string, refreshToken: string) => void
  setAccessToken: (token: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      login: (user, accessToken, refreshToken) => set({ user, accessToken, refreshToken }),
      setAccessToken: (accessToken) => set({ accessToken }),
      logout: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    { name: 'auth-storage' }
  )
)
