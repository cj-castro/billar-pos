import { create } from 'zustand'

export interface ResourceState {
  id: string
  code: string
  name: string
  type: string
  status: string
  is_active: boolean
  active_ticket_id: string | null
  customer_name?: string | null
  timer_start?: string
  timer_session_id?: string
  pool_config?: { billing_mode: string; rate_cents: number; promo_free_minutes: number }
  sort_order: number
}

interface FloorStore {
  resources: ResourceState[]
  setResources: (r: ResourceState[]) => void
  updateResource: (id: string, update: Partial<ResourceState>) => void
}

export const useFloorStore = create<FloorStore>((set) => ({
  resources: [],
  setResources: (resources) => set({ resources }),
  updateResource: (id, update) =>
    set((s) => ({
      resources: s.resources.map((r) => (r.id === id ? { ...r, ...update } : r)),
    })),
}))
