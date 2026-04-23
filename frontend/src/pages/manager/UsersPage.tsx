import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'
import { useEscKey } from '../../hooks/useEscKey'

const ROLES = ['WAITER', 'KITCHEN_STAFF', 'BAR_STAFF', 'MANAGER', 'ADMIN']
const ROLE_COLORS: Record<string, string> = {
  WAITER: 'text-sky-400', KITCHEN_STAFF: 'text-orange-400',
  BAR_STAFF: 'text-purple-400', MANAGER: 'text-green-400', ADMIN: 'text-red-400',
}
const ROLE_LABELS: Record<string, string> = {
  WAITER: '🏃 Mesero', KITCHEN_STAFF: '🍳 Cocina', BAR_STAFF: '🍹 Bar',
  MANAGER: '👔 Gerente', ADMIN: '🔑 Admin',
}

const emptyForm = { username: '', name: '', role: 'WAITER', password: '', pin: '' }

export default function UsersPage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editUser, setEditUser] = useState<any | null>(null)
  const [form, setForm] = useState({ ...emptyForm })
  const [editForm, setEditForm] = useState({ name: '', role: '', new_password: '', pin: '', clear_pin: false })
  const [saving, setSaving] = useState(false)

  useEscKey(() => { setShowCreate(false); setEditUser(null) }, showCreate || !!editUser)

  const { data: users = [], refetch } = useQuery({
    queryKey: ['users'],
    queryFn: () => client.get('/users').then(r => r.data),
  })

  const handleCreate = async () => {
    if (!form.username.trim() || !form.password.trim()) { toast.error('Se requieren usuario y contraseña'); return }
    setSaving(true)
    try {
      await client.post('/users', {
        username: form.username.trim(),
        name: form.name.trim() || form.username.trim(),
        role: form.role,
        password: form.password,
        ...(form.pin ? { pin: form.pin } : {}),
      })
      toast.success('Usuario creado')
      qc.invalidateQueries({ queryKey: ['users'] })
      setShowCreate(false)
      setForm({ ...emptyForm })
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo crear el usuario')
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (u: any) => {
    setEditUser(u)
    setEditForm({ name: u.name, role: u.role, new_password: '', pin: '', clear_pin: false })
  }

  const handleEdit = async () => {
    if (!editUser) return
    setSaving(true)
    const payload: any = { name: editForm.name.trim(), role: editForm.role }
    if (editForm.new_password.trim()) payload.password = editForm.new_password.trim()
    if (editForm.clear_pin) payload.pin = null
    else if (editForm.pin.trim()) payload.pin = editForm.pin.trim()
    try {
      await client.patch(`/users/${editUser.id}`, payload)
      toast.success('Usuario actualizado')
      qc.invalidateQueries({ queryKey: ['users'] })
      setEditUser(null)
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'No se pudo actualizar')
    } finally {
      setSaving(false)
    }
  }

  const handleDeactivate = async (id: string) => {
    if (!confirm('¿Desactivar este usuario? Ya no podrá iniciar sesión.')) return
    await client.delete(`/users/${id}`)
    toast.success('Usuario desactivado')
    refetch()
  }

  const needsPin = (role: string) => ['MANAGER', 'ADMIN'].includes(role)

  return (
    <div className="min-h-screen bg-slate-950 page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-3xl mx-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">👥 Cuentas del Personal</h1>
          <button onClick={() => setShowCreate(true)} className="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-lg font-semibold text-sm">+ Nuevo Usuario</button>
        </div>

        <div className="space-y-2">
          {(users as any[]).map((u) => (
            <div key={u.id} className={`bg-slate-800 rounded-xl p-4 border ${u.is_active ? 'border-slate-700' : 'border-red-900 opacity-60'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center text-lg">
                    {ROLE_LABELS[u.role]?.split(' ')[0] ?? '👤'}
                  </div>
                  <div>
                    <div className="font-semibold">{u.name}</div>
                    <div className="text-sm text-slate-400">
                      @{u.username} · <span className={ROLE_COLORS[u.role] ?? 'text-slate-300'}>{ROLE_LABELS[u.role] ?? u.role}</span>
                    </div>
                    {needsPin(u.role) && (
                      <div className={`text-xs mt-0.5 ${u.has_pin ? 'text-green-400' : 'text-red-400'}`}>
                        {u.has_pin ? '🔑 PIN set' : '⚠️ No PIN — cannot authorize actions'}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  {u.is_active && (
                    <button onClick={() => openEdit(u)}
                      className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-semibold">
                      ✏️ Editar
                    </button>
                  )}
                  {u.is_active && (
                    <button onClick={() => handleDeactivate(u.id)}
                      className="px-3 py-1.5 text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 rounded-lg text-sm">
                      Desactivar
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600 space-y-3">
            <h2 className="font-bold text-lg">Nueva Cuenta de Personal</h2>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Usuario</label>
              <input autoFocus value={form.username} onChange={e => setForm(p => ({ ...p, username: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                placeholder="john.doe" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Nombre Completo</label>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                placeholder="John Doe" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Role</label>
              <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Contraseña</label>
              <input type="password" value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
            </div>
            {needsPin(form.role) && (
              <div>
                <label className="text-xs text-slate-400 block mb-1">
                  Manager PIN (4 digits) — <span className="text-yellow-400">required to authorize voids & discounts</span>
                </label>
                <input type="password" maxLength={4} inputMode="numeric" value={form.pin}
                  onChange={e => setForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, '') }))}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm tracking-widest text-center text-xl font-mono"
                  placeholder="••••" />
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button onClick={() => { setShowCreate(false); setForm({ ...emptyForm }) }}
                className="flex-1 py-2 border border-slate-600 rounded-lg text-slate-300">Cancelar</button>
              <button onClick={handleCreate} disabled={saving || !form.username || !form.password}
                className="flex-1 py-2 bg-sky-600 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Creando…' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editUser && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-sm border border-slate-600 space-y-3">
            <h2 className="font-bold text-lg">Edit: {editUser.name}</h2>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Nombre Completo</label>
              <input autoFocus value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleEdit()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Role</label>
              <select value={editForm.role} onChange={e => setEditForm(p => ({ ...p, role: e.target.value }))}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm">
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Nueva Contraseña <span className="text-slate-500">(dejar en blanco para conservar)</span></label>
              <input type="password" value={editForm.new_password} onChange={e => setEditForm(p => ({ ...p, new_password: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleEdit()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm" placeholder="••••••••" />
            </div>

            {/* PIN section */}
            <div className="bg-slate-900 rounded-xl p-3 border border-slate-700">
              <div className="text-xs text-slate-400 font-semibold mb-2">
                🔑 Manager PIN
                {editUser.has_pin
                  ? <span className="ml-2 text-green-400">● Active</span>
                  : <span className="ml-2 text-red-400">● Not set</span>}
              </div>
              {!editForm.clear_pin ? (
                <div>
                  <label className="text-xs text-slate-500 block mb-1">
                    {editUser.has_pin ? 'Reset PIN (enter new 4-digit PIN)' : 'Set PIN (4 digits)'}
                  </label>
                  <input type="password" maxLength={4} inputMode="numeric" value={editForm.pin}
                    onChange={e => setEditForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, '') }))}
                    onKeyDown={e => e.key === 'Enter' && handleEdit()}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm tracking-widest text-center text-xl font-mono"
                    placeholder={editUser.has_pin ? '•••• (new)' : '••••'} />
                  {editUser.has_pin && (
                    <button onClick={() => setEditForm(p => ({ ...p, clear_pin: true, pin: '' }))}
                      className="mt-2 text-xs text-red-400 hover:text-red-300">
                      Remove PIN entirely
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-red-400 text-sm">⚠️ PIN will be removed</span>
                  <button onClick={() => setEditForm(p => ({ ...p, clear_pin: false }))}
                    className="text-xs text-slate-400 hover:text-slate-300">Undo</button>
                </div>
              )}
              {!needsPin(editForm.role) && (
                <div className="text-xs text-slate-500 mt-1">PIN only applies to Manager/Admin roles</div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button onClick={() => setEditUser(null)}
                className="flex-1 py-2 border border-slate-600 rounded-lg text-slate-300">Cancelar</button>
              <button onClick={handleEdit} disabled={saving || !editForm.name}
                className="flex-1 py-2 bg-sky-600 rounded-lg font-bold disabled:opacity-50">
                {saving ? 'Guardando…' : 'Guardar Cambios'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
