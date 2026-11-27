import React from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import NavBar from '../../components/NavBar'
import { PAGES as REPORT_PAGES } from './ReportsHub'
import { QueryState } from '../../components/QueryState'
import client from '../../api/client'
import { formatMXN } from '../../utils/money'
import { useAuthStore } from '../../stores/authStore'
import { formatLocal, formatLocalTime } from '../../utils/venue'

/**
 * Inicio — what the manager / owner needs the moment they arrive (batch C).
 *
 * One page for both roles. The SERVER decides what each sees: a manager's
 * /home response simply has no `hoy` or `alertas` (policy: sales and money
 * analytics are owner-only). The shortcuts below are the old tile grid.
 */

const hhmm = (iso?: string | null) => formatLocalTime(iso ?? null)

function Stat({ label, value, sub, tone = 'default', to }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode
  tone?: 'default' | 'good' | 'warn' | 'bad'; to?: string
}) {
  const color = tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400'
    : tone === 'bad' ? 'text-red-400' : 'text-slate-100'
  const body = (
    <>
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </>
  )
  const cls = 'bg-slate-800 rounded-xl p-4 border border-slate-700 block'
  return to ? <Link to={to} className={`${cls} hover:border-sky-600`}>{body}</Link> : <div className={cls}>{body}</div>
}

function Delta({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-slate-500">sin dato de la semana pasada</span>
  const up = pct >= 0
  return <span className={up ? 'text-emerald-400' : 'text-red-400'}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}% vs. hace una semana</span>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-2">{title}</h2>
      {children}
    </section>
  )
}

export default function ManagerDashboard() {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'ADMIN'

  const home = useQuery({
    queryKey: ['home'],
    queryFn: () => client.get('/home').then(r => r.data),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
  const d = home.data

  const tiles = [
    { to: '/manager/cash', icon: '💰', label: t('manager.cashSession'), desc: 'Abrir / cerrar caja, propinas, gastos' },
    { to: '/manager/inventory', icon: '📦', label: t('manager.inventory'), desc: 'Existencias, reabasto y ajustes' },
    { to: '/manager/menu', icon: '🍽️', label: t('manager.menu'), desc: 'Artículos, precios, modificadores' },
    { to: '/manager/modifiers', icon: '🧩', label: 'Modificadores', desc: 'Grupos de sabores, salsas, extras' },
    { to: '/manager/promotions', icon: '🏷️', label: 'Promociones', desc: '2x1 y descuentos por cantidad' },
    { to: '/manager/users', icon: '👥', label: t('manager.users'), desc: 'Cuentas del personal' },
    { to: '/manager/pool-config', icon: '🕒', label: t('manager.poolBilling'), desc: 'Tarifas y minutos gratis' },
    { to: '/manager/tables', icon: '🗂', label: t('manager.tableSetup'), desc: 'Mesas de billar, piso y barra' },
    { to: '/floor', icon: '🎱', label: t('manager.floorView'), desc: 'Estado de mesas en vivo' },
    { to: '/manager/settings', icon: '⚙️', label: t('manager.settings'), desc: 'Idioma y preferencias' },
  ]
  // Owner: the six Reportes pages (batch D3).
  const adminTiles = REPORT_PAGES.map(p => ({
    to: `/manager/reportes/${p.id}`, icon: p.icon, label: p.label, desc: p.desc,
  }))

  const a = d?.ahora, p = d?.pendientes, h = d?.hoy, al = d?.alertas
  const ventana = d?.ventana?.tipo === 'turno' ? `Turno desde las ${hhmm(d?.ventana?.desde)}` : 'Hoy'

  return (
    <div className="min-h-screen bg-slate-950 page-root text-slate-100">
      <NavBar />
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="flex items-baseline justify-between mb-5">
          <h1 className="text-2xl font-bold">Inicio</h1>
          {d && <span className="text-xs text-slate-500">{ventana} · actualizado {hhmm(new Date().toISOString())}</span>}
        </div>

        <QueryState query={home}>
          {d && (<>
            <Section title="Ahora">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Caja" to="/manager/cash"
                  value={a.caja_abierta ? 'Abierta' : 'Cerrada'}
                  tone={a.caja_abierta ? 'good' : 'warn'}
                  sub={a.caja_abierta ? `${a.caja_abierta_por ?? ''} · desde ${hhmm(a.caja_abierta_desde)}` : 'Ábrela para empezar a vender'} />
                <Stat label="Mesas en uso" to="/floor" value={`${a.mesas_en_uso}/${a.mesas_total}`} />
                <Stat label="Cuentas abiertas" to="/floor" value={a.cuentas_abiertas}
                  sub={a.cuentas_por_cobrar ? `${a.cuentas_por_cobrar} pidieron la cuenta` : undefined}
                  tone={a.cuentas_por_cobrar ? 'warn' : 'default'} />
                {h && (
                  <Stat label="En mesas ahora" value={formatMXN(h.en_mesas_ahora_cents)}
                    sub="consumo aún sin cobrar" />
                )}
              </div>
            </Section>

            {h && (
              <Section title={`Dinero · ${ventana.toLowerCase()}`}>
                <div className="grid lg:grid-cols-3 gap-3">
                  <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 lg:col-span-2">
                    <div className="text-xs text-slate-400">Ventas cobradas</div>
                    <div className="text-4xl font-bold font-mono">{formatMXN(h.ventas_cents)}</div>
                    <div className="text-sm mt-1"><Delta pct={h.variacion_ventas_pct} /></div>
                    <div className="text-xs text-slate-500">
                      Hace una semana a esta hora: {formatMXN(h.semana_pasada.ventas_cents)}
                    </div>
                    {/* where the money came from */}
                    {h.ventas_cents > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {[['🎱 Billar', h.billar_cents, 'bg-violet-500'],
                          ['🍹 Barra', h.barra_cents, 'bg-sky-500'],
                          ['🍳 Cocina', h.cocina_cents, 'bg-amber-500']].map(([lbl, c, col]) => {
                          const pct = Math.round((Number(c) / Math.max(1, h.billar_cents + h.barra_cents + h.cocina_cents)) * 100)
                          return (
                            <div key={lbl as string} className="text-xs">
                              <div className="flex justify-between"><span>{lbl}</span>
                                <span className="font-mono">{formatMXN(c as number)} · {pct}%</span></div>
                              <div className="h-1.5 bg-slate-700 rounded"><div className={`h-1.5 rounded ${col}`} style={{ width: `${pct}%` }} /></div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-1 gap-3">
                    <Stat label="Ticket promedio" value={formatMXN(h.ticket_promedio_cents)} sub={`${h.tickets} cuentas cobradas`} />
                    <Stat label="Utilidad" to="/manager/reportes/rentabilidad/costos"
                      value={h.utilidad_cents == null ? '—' : formatMXN(h.utilidad_cents)}
                      tone={h.utilidad_cents == null ? 'warn' : 'good'}
                      sub={h.utilidad_cents == null
                        ? `Sin costo suficiente (${(h.cobertura_costo_pct ?? 0).toFixed(0)}% con costo)`
                        : `margen artículos ${h.margen_pct?.toFixed(1)}%`} />
                  </div>
                </div>
              </Section>
            )}

            {al && (
              <Section title="Alertas">
                <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                  <Stat label="Líneas canceladas" to="/manager/reportes/personal/riesgos"
                    value={al.cancelaciones.n} sub={formatMXN(al.cancelaciones.cents)}
                    tone={al.cancelaciones.n ? 'warn' : 'default'} />
                  <Stat label="Cancelados con consumo" to="/manager/reportes/personal/riesgos"
                    value={al.cancelados_con_consumo.n} sub={formatMXN(al.cancelados_con_consumo.cents)}
                    tone={al.cancelados_con_consumo.n ? 'bad' : 'default'} />
                  <Stat label="Cierres forzados" to="/manager/reportes/personal/riesgos"
                    value={al.cierres_forzados.n} sub={formatMXN(al.cierres_forzados.cents)}
                    tone={al.cierres_forzados.n ? 'bad' : 'default'} />
                  <Stat label="Reaperturas" to="/manager/reportes/personal/riesgos"
                    value={al.reaperturas.n} tone={al.reaperturas.n ? 'warn' : 'default'} />
                  {al.cortesias && (
                    <Stat label="Cortesías / personal" to="/manager/reportes/personal/cortesias"
                      value={formatMXN((al.cortesias.costo_cents ?? 0) + (al.consumo_personal?.costo_cents ?? 0))}
                      sub={`${al.cortesias.n} cortesías · ${al.consumo_personal?.n ?? 0} de personal (a costo)`} />
                  )}
                  <Stat label="Último cierre de caja" to="/manager/cash"
                    value={al.ultimo_cierre?.diferencia_cents == null ? '—'
                      : `${al.ultimo_cierre.diferencia_cents >= 0 ? '+' : ''}${formatMXN(al.ultimo_cierre.diferencia_cents)}`}
                    tone={al.ultimo_cierre?.diferencia_cents == null ? 'default'
                      : Math.abs(al.ultimo_cierre.diferencia_cents) <= 5000 ? 'good'
                      : al.ultimo_cierre.diferencia_cents < 0 ? 'bad' : 'warn'}
                    sub={al.ultimo_cierre ? `${al.ultimo_cierre.por ?? ''} · ${formatLocal(al.ultimo_cierre.cerrada, { dateStyle: 'short' })}` : undefined} />
                  {/* Overnight difference after that close (owner-only section):
                      next opening count minus what the close left in the drawer.
                      Null until the next opening, or with a legacy open/close. */}
                  {al.ultimo_cierre?.diferencia_apertura_cents != null && (
                    <Stat label={t('cash.count.ownerOpeningDiff')} to="/manager/cash"
                      value={`${al.ultimo_cierre.diferencia_apertura_cents >= 0 ? '+' : ''}${formatMXN(al.ultimo_cierre.diferencia_apertura_cents)}`}
                      tone={al.ultimo_cierre.diferencia_apertura_cents === 0 ? 'good'
                        : al.ultimo_cierre.diferencia_apertura_cents < 0 ? 'bad' : 'warn'}
                      sub={t('cash.count.openingDiffHelp')} />
                  )}
                </div>
              </Section>
            )}

            <Section title="Pendientes">
              <div className="grid lg:grid-cols-3 gap-3">
                <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                  <div className="text-xs text-slate-400 mb-2">🍾 Por abrir (sin shots/sueltos para vender)</div>
                  {p.por_abrir.length === 0 ? <div className="text-sm text-slate-500">Nada pendiente.</div> : (
                    <ul className="space-y-1 text-sm">
                      {p.por_abrir.map((x: any) => (
                        <li key={x.producto}>
                          <Link to="/manager/inventory" className="hover:text-sky-300">
                            Abrir <b>{x.abrir}</b>
                            <span className="text-xs text-slate-500"> · {x.selladas} {x.tipo === 'botella' ? 'selladas' : 'cajas'}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                  <div className="text-xs text-slate-400 mb-2">📦 Stock bajo ({p.stock_bajo_total})</div>
                  {p.stock_bajo.length === 0 ? <div className="text-sm text-slate-500">Todo por encima del mínimo.</div> : (
                    <ul className="space-y-1 text-sm">
                      {p.stock_bajo.map((x: any) => (
                        <li key={x.nombre} className="flex justify-between">
                          <span className="truncate">{x.nombre}</span>
                          <span className="font-mono text-amber-300 shrink-0 ml-2">{x.existencia} / {x.minimo}</span>
                        </li>
                      ))}
                      {p.stock_bajo_total > p.stock_bajo.length && (
                        <li><Link to="/manager/inventory" className="text-xs text-sky-400">ver los {p.stock_bajo_total} →</Link></li>
                      )}
                    </ul>
                  )}
                </div>
                {p.costos_faltantes != null && (
                  <Link to="/manager/reportes/rentabilidad/costos"
                    className="bg-slate-800 rounded-xl p-4 border border-slate-700 hover:border-sky-600 block">
                    <div className="text-xs text-slate-400 mb-2">💲 Costos</div>
                    <div className="text-sm">
                      <b className={p.costos_faltantes ? 'text-amber-300' : 'text-emerald-300'}>{p.costos_faltantes}</b> insumos sin costo
                    </div>
                    <div className="text-sm">
                      <b className={p.costos_a_revisar ? 'text-orange-300' : 'text-emerald-300'}>{p.costos_a_revisar}</b> costos a revisar
                    </div>
                    <div className="text-xs text-sky-400 mt-2">Capturar →</div>
                  </Link>
                )}
              </div>
            </Section>
          </>)}
        </QueryState>

        <Section title="Accesos">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {tiles.map((x) => (
              <Link key={x.to} to={x.to} className="bg-slate-800 hover:bg-slate-700 rounded-2xl p-4 border border-slate-700 hover:border-sky-600 transition-all">
                <div className="text-2xl mb-1">{x.icon}</div>
                <div className="font-bold text-sm">{x.label}</div>
                <div className="text-xs text-slate-400 mt-0.5">{x.desc}</div>
              </Link>
            ))}
            {isAdmin && adminTiles.map((x) => (
              <Link key={x.to} to={x.to} className="bg-slate-800 hover:bg-slate-700 rounded-2xl p-4 border border-violet-800 hover:border-violet-500 transition-all">
                <div className="text-2xl mb-1">{x.icon}</div>
                <div className="font-bold text-sm text-violet-300">{x.label}</div>
                <div className="text-xs text-slate-400 mt-0.5">{x.desc}</div>
              </Link>
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}
