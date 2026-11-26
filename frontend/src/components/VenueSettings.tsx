import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import client from '../api/client'
import { useVenue } from './VenueGate'
import { venueLogo } from '../utils/venue'

const TIMEZONES = [
  'America/Mexico_City', 'America/Monterrey', 'America/Cancun', 'America/Tijuana', 'America/Hermosillo',
  'America/Bogota', 'America/Lima', 'America/Guatemala', 'America/Santiago', 'America/Argentina/Buenos_Aires',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/Madrid',
]
const CURRENCIES = ['MXN', 'USD', 'COP', 'PEN', 'GTQ', 'CLP', 'ARS', 'EUR']
const LOCALES = [['es-MX', 'Español (México)'], ['es-CO', 'Español (Colombia)'], ['es-ES', 'Español (España)'],
                 ['es-US', 'Español (EE. UU.)'], ['en-US', 'English (US)']]

/** Shrink an uploaded image to a small square-ish JPEG data URL (fits the 300 KB limit). */
async function toDataUrl(file: File, max = 256): Promise<string> {
  const img = new Image()
  img.src = URL.createObjectURL(file)
  await img.decode()
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  URL.revokeObjectURL(img.src)
  return c.toDataURL('image/jpeg', 0.85)
}

/**
 * Ajustes → Negocio (owner only): what used to be hard-coded to one bar.
 * Each field saves to settings key venue.*; every connected screen reloads it.
 */
export function VenueSettings() {
  const venue = useVenue()
  const qc = useQueryClient()
  const [draft, setDraft] = useState({ name: venue.name, timezone: venue.timezone,
                                       currency: venue.currency, locale: venue.locale,
                                       day_cutoff: venue.day_cutoff })
  const [saving, setSaving] = useState(false)

  const put = (key: string, value: string) => client.put(`/settings/${key}`, { value })

  const save = async () => {
    setSaving(true)
    try {
      for (const [k, v] of Object.entries(draft)) {
        if ((venue as any)[k] !== v) await put(`venue.${k}`, v)
      }
      await qc.invalidateQueries({ queryKey: ['venue'] })
      toast.success('Datos del negocio guardados')
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'No se pudo guardar')
    } finally { setSaving(false) }
  }

  const uploadLogo = async (file?: File) => {
    if (!file) return
    try {
      await put('venue.logo', await toDataUrl(file))
      await qc.invalidateQueries({ queryKey: ['venue'] })
      toast.success('Logo actualizado')
    } catch (e: any) { toast.error(e.response?.data?.message || 'No se pudo subir el logo') }
  }
  const removeLogo = async () => {
    await put('venue.logo', '')
    await qc.invalidateQueries({ queryKey: ['venue'] })
  }

  const field = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm'
  return (
    <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 mb-6">
      <h2 className="font-bold mb-1">🏷️ Negocio</h2>
      <p className="text-xs text-slate-400 mb-4">
        Nombre, logo, zona horaria y moneda de este billar. Aparecen en pantallas, recibos y
        reportes. La zona horaria decide a qué día pertenece cada venta.
      </p>
      <div className="flex items-center gap-4 mb-4">
        <img src={venueLogo()} alt={venue.name} className="w-16 h-16 rounded-full object-cover border border-slate-600" />
        <div className="space-x-2">
          <label className="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-xs cursor-pointer">
            Cambiar logo
            <input type="file" accept="image/*" className="hidden" onChange={e => uploadLogo(e.target.files?.[0])} />
          </label>
          {venue.logo && <button onClick={removeLogo} className="text-xs text-slate-400 underline">Quitar</button>}
        </div>
      </div>
      <div className="space-y-3">
        <label className="block text-xs text-slate-400">Nombre
          <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={80} className={field} />
        </label>
        <label className="block text-xs text-slate-400">Zona horaria
          <select value={draft.timezone} onChange={e => setDraft({ ...draft, timezone: e.target.value })} className={field}>
            {[...new Set([draft.timezone, ...TIMEZONES])].map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400">Moneda
            <select value={draft.currency} onChange={e => setDraft({ ...draft, currency: e.target.value })} className={field}>
              {[...new Set([draft.currency, ...CURRENCIES])].map(c => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="block text-xs text-slate-400">Idioma y formato
            <select value={draft.locale} onChange={e => setDraft({ ...draft, locale: e.target.value })} className={field}>
              {LOCALES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-xs text-slate-400">Hora de cierre del día
          <input type="time" value={draft.day_cutoff} step={900}
            onChange={e => setDraft({ ...draft, day_cutoff: e.target.value || '00:00' })} className={field} />
          <span className="block mt-1 text-slate-500">
            Las ventas antes de esta hora cuentan para el día anterior (p. ej. 06:00: lo vendido a la
            1:30 a. m. del domingo es parte del sábado). 00:00 = día calendario.
          </span>
        </label>
        <button onClick={save} disabled={saving || !draft.name.trim()}
          className="w-full py-2 bg-sky-600 hover:bg-sky-500 rounded-lg font-semibold disabled:opacity-50">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  )
}
