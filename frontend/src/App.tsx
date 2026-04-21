import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import LoginPage from './pages/LoginPage'
import FloorMapPage from './pages/FloorMapPage'
import TicketPage from './pages/TicketPage'
import KitchenQueuePage from './pages/KitchenQueuePage'
import BarQueuePage from './pages/BarQueuePage'
import ManagerDashboard from './pages/manager/ManagerDashboard'
import ReportsPage from './pages/manager/ReportsPage'
import InventoryPage from './pages/manager/InventoryPage'
import MenuManagementPage from './pages/manager/MenuManagementPage'
import UsersPage from './pages/manager/UsersPage'
import PoolTableConfigPage from './pages/manager/PoolTableConfigPage'
import CashSessionPage from './pages/manager/CashSessionPage'
import TableManagementPage from './pages/manager/TableManagementPage'
import SettingsPage from './pages/manager/SettingsPage'
import { SocketProvider } from './hooks/useSocket'

function RequireAuth({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (roles && !roles.includes(user.role)) return <Navigate to="/floor" replace />
  return <>{children}</>
}

export default function App() {
  const user = useAuthStore((s) => s.user)

  return (
    <SocketProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/floor" element={<RequireAuth><FloorMapPage /></RequireAuth>} />
        <Route path="/ticket/:id" element={<RequireAuth><TicketPage /></RequireAuth>} />
        <Route path="/queue/kitchen" element={<RequireAuth roles={['KITCHEN_STAFF','MANAGER','ADMIN']}><KitchenQueuePage /></RequireAuth>} />
        <Route path="/queue/bar" element={<RequireAuth roles={['BAR_STAFF','MANAGER','ADMIN']}><BarQueuePage /></RequireAuth>} />
        <Route path="/manager" element={<RequireAuth roles={['MANAGER','ADMIN']}><ManagerDashboard /></RequireAuth>} />
        <Route path="/manager/reports" element={<RequireAuth roles={['MANAGER','ADMIN']}><ReportsPage /></RequireAuth>} />
        <Route path="/manager/inventory" element={<RequireAuth roles={['MANAGER','ADMIN']}><InventoryPage /></RequireAuth>} />
        <Route path="/manager/menu" element={<RequireAuth roles={['MANAGER','ADMIN']}><MenuManagementPage /></RequireAuth>} />
        <Route path="/manager/users" element={<RequireAuth roles={['ADMIN']}><UsersPage /></RequireAuth>} />
        <Route path="/manager/pool-config" element={<RequireAuth roles={['MANAGER','ADMIN']}><PoolTableConfigPage /></RequireAuth>} />
        <Route path="/manager/tables" element={<RequireAuth roles={['MANAGER','ADMIN']}><TableManagementPage /></RequireAuth>} />
        <Route path="/manager/cash" element={<RequireAuth roles={['MANAGER','ADMIN']}><CashSessionPage /></RequireAuth>} />
        <Route path="/manager/settings" element={<RequireAuth roles={['MANAGER','ADMIN']}><SettingsPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to={user ? '/floor' : '/login'} replace />} />
      </Routes>
    </SocketProvider>
  )
}
