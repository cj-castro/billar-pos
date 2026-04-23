import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import toast from 'react-hot-toast'

function cents(n: number | null) { return n != null ? `$${(n / 100).toFixed(2)}` : '$0.00' }

export default function SafeCollectionsPage() {
  const qc  = useQueryClient()
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(today)
  const [to,   setTo]   = useState(today)
  const [amount, setAmount] = useState('')
  const [notes,  setNotes]  = useState('')
  const [saving, setSaving] = useState(false)

  const params = { from: `${from}T00:00:00`, to: `${to}T23:59:59` }

  const { data: collections = [] } = useQuery({
    queryKey: ['safe-collections', from, to],
    queryFn: () => client.get('/safe', { params }).then(r => r.data),
  })

  const { data: summary } = useQuery({
    queryKey: ['safe-summary', from, to],
    queryFn: () => client.get('/safe/summary', { params }).then(r => r.data),
  })

  const totalCents = useMemo(() =>
    (collections as any[]).reduce((s: number, r: any) => s + Number(r.amount_cents), 0),
    [collections]
  )

  const handleAdd = async () => {
    const amountCents = Math.round(parseFloat(amount) * 100)
    if (!amount || isNaN(amountCents) || amountCents <= 0)
      return toast.error('Ingresa un monto válido')
    setSaving(true)
    try {
      await client.post('/safe', { amount_cents: amountCents, notes: notes || undefined })
      toast.success('Colecta registrada')
      setAmount('')
      setNotes('')
      qc.invalidateQueries({ queryKey: ['safe-collections'] })
      qc.invalidateQueries({ queryKey: ['safe-summary'] })
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Error al registrar')
    } finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este registro?')) return
    try {
      await client.delete(`/safe/${id}`)
      toast.success('Registro eliminado')
      qc.invalidateQueries({ queryKey: ['safe-collections'] })
      qc.invalidateQueries({ queryKey: ['safe-summary'] })
    } catch {
      toast.error('Error al eliminar')
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white page-root">
      <NavBar />
      <ManagerBackButton />
      <div className="max-w-2xl mx-auto p-4">

        <h1 className="text-xl font-bold mb-6">🔐 Colectas de Caja Fuerte</h1>

        {/* Date filter */}
        <div className="flex gap-3 mb-6">
          <div className="flex-1">
            <label className="text-xs text-slate-400 block mb-1">Desde</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex-1">
            <label className="text-xs text-slate-400 block mb-1">Hasta</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>

        {/* Summary card */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-slate-800 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-emerald-300">{cents(totalCents)}</div>
            <div className="text-xs text-slate-400 mt-1">Total Colectado</div>
          </div>
          <div className="bg-slate-800 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-sky-300">{(collections as any[]).length}</div>
            <div className="text-xs text-slate-400 mt-1">Registros</div>
          </div>
        </div>

        {/* Add new */}
        <div className="bg-slate-800 rounded-2xl p-5 border border-emerald-800 mb-6">
          <h2 className="font-bold text-emerald-300 mb-3">➕ Registrar Nueva Colecta</h2>
          <label className="text-xs text-slate-400 block mb-1">Monto colectado ($)</label>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 text-lg font-mono mb-3"
          />
          <label className="text-xs text-slate-400 block mb-1">Notas (opcional)</label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Ej. Colecta nocturna, turno tarde…"
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm mb-3"
          />
          <button
            onClick={handleAdd}
            disabled={saving}
            className="w-full py-3 bg-emerald-700 hover:bg-emerald-600 rounded-xl font-bold disabled:opacity-50"
          >
            {saving ? 'Registrando…' : '🔐 Registrar Colecta'}
          </button>
        </div>

        {/* History */}
        <div className="bg-slate-800 rounded-2xl overflow-hidden">
          <div className="p-3 bg-slate-700/50 font-semibold text-sm">📋 Historial</div>
          {(collections as any[]).length === 0 ? (
            <p className="p-8 text-center text-slate-500">Sin colectas en este período</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 uppercase bg-slate-700/30">
                <tr>
                  <th className="p-3 text-left">Fecha / Hora</th>
                  <th className="p-3 text-left">Admin</th>
                  <th className="p-3 text-right">Monto</th>
                  <th className="p-3 text-left">Notas</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {(collections as any[]).map((r: any) => (
                  <tr key={r.id} className="border-t border-slate-700 hover:bg-slate-700/30">
                    <td className="p-3 text-slate-400 text-xs">
                      {new Date(r.created_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{r.collector_name}</div>
                      <div className="text-xs text-slate-500">@{r.collector_username}</div>
                    </td>
                    <td className="p-3 text-right font-mono font-bold text-emerald-300">{cents(r.amount_cents)}</td>
                    <td className="p-3 text-slate-400 text-xs italic">{r.notes || '—'}</td>
                    <td className="p-3 text-right">
                      <button onClick={() => handleDelete(r.id)} className="text-red-500 hover:text-red-400 text-xs">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-700/30">
                <tr>
                  <td colSpan={2} className="p-3 text-xs text-slate-400 font-semibold">Total</td>
                  <td className="p-3 text-right font-mono font-bold text-emerald-300">{cents(totalCents)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

      </div>
    </div>
  )
}
