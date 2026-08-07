/**
 * Analytics — ADMIN ONLY.
 *
 * Every tab reads /api/v1/analytics/*, which in turn reads only v_bola8_* views.
 * Money arrives as INTEGER CENTS and is rendered with formatMXN(); charts divide
 * by 100 at render time so no float ever carries a peso amount around.
 *
 * The cost-coverage banner is deliberately not dismissible. Reported margin is
 * ~97% because 64 of 76 inventory items have no unit cost, and a margin shown
 * without its coverage is a number the owner will act on and shouldn't.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, ComposedChart,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts'
import NavBar from '../../components/NavBar'
import ManagerBackButton from '../../components/ManagerBackButton'
import client from '../../api/client'
import { formatMXN } from '../../utils/money'

type Tab = 'resumen' | 'rentabilidad' | 'billar' | 'menu' | 'caja'
         | 'inventario' | 'costos' | 'personal' | 'riesgos'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'resumen',      label: 'Resumen',      icon: '📈' },
  { id: 'rentabilidad', label: 'Rentabilidad', icon: '🧾' },
  { id: 'billar',       label: 'Billar',       icon: '🎱' },
  { id: 'menu',         label: 'Menú',         icon: '🍽️' },
  { id: 'caja',         label: 'Flujo Caja',   icon: '💵' },
  { id: 'inventario',   label: 'Inventario',   icon: '📦' },
  { id: 'costos',       label: 'Costos',       icon: '🎯' },
  { id: 'personal',     label: 'Personal',     icon: '👥' },
  { id: 'riesgos',      label: 'Riesgos',      icon: '⚠️' },
]

const DIAS_ISO = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

// Brand-neutral categorical palette, distinguishable in dark UI.
const C = {
  sales: '#38bdf8', profit: '#34d399', cost: '#fb7185',
  warn: '#fbbf24', muted: '#94a3b8', accent: '#a78bfa',
}
const QUADRANT_COLOR: Record<string, string> = {
  ESTRELLA: '#34d399', CABALLO: '#38bdf8', ROMPECABEZAS: '#fbbf24', PERRO: '#fb7185',
}
const QUADRANT_LABEL: Record<string, string> = {
  ESTRELLA: 'Estrella — popular y rentable',
  CABALLO: 'Caballo — popular, margen bajo',
  ROMPECABEZAS: 'Rompecabezas — rentable, poco vendido',
  PERRO: 'Perro — ni popular ni rentable',
}

const pesos = (cents: number) => (cents ?? 0) / 100
const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function Card({ title, value, sub, tone = 'default' }: {
  title: string; value: string; sub?: string
  tone?: 'default' | 'good' | 'bad' | 'warn'
}) {
  const toneClass = tone === 'good' ? 'text-emerald-400'
    : tone === 'bad' ? 'text-red-400'
    : tone === 'warn' ? 'text-yellow-400' : 'text-slate-100'
  return (
    <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
      <div className="text-xs text-slate-400 uppercase tracking-wide">{title}</div>
      <div className={`text-2xl font-bold mt-1 font-mono ${toneClass}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  )
}

function Delta({ v }: { v: number | null }) {
  if (v == null) return <span className="text-slate-500">—</span>
  const good = v >= 0
  return (
    <span className={good ? 'text-emerald-400' : 'text-red-400'}>
      {good ? '▲' : '▼'} {Math.abs(v).toFixed(1)}%
    </span>
  )
}

/** Permanent, non-dismissible honesty banner on every margin surface. */
function CoverageBanner({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return null
  const bad = pct < 50
  return (
    <div className={`rounded-xl p-3 mb-4 border text-sm ${
      bad ? 'bg-amber-950/40 border-amber-700 text-amber-200'
          : 'bg-slate-800 border-slate-700 text-slate-300'}`}>
      <b>Cobertura de costo: {pct.toFixed(1)}%</b>
      {bad && (
        <> — el margen mostrado está inflado. Solo {pct.toFixed(1)}% de la venta de
        artículos tiene costo real capturado. Ve a la pestaña <b>Costos</b> para ver
        qué insumos faltan.</>
      )}
    </div>
  )
}

function ChartFrame({ title, note, children, height = 280 }: {
  title: string; note?: string; children: React.ReactElement; height?: number
}) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
      <div className="font-bold mb-1">{title}</div>
      {note && <div className="text-xs text-slate-500 mb-2">{note}</div>}
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  )
}

const tooltipStyle = {
  contentStyle: { background: '#1e293b', border: '1px solid #475569', borderRadius: 8 },
  labelStyle: { color: '#e2e8f0' },
}

/** Recharts hands the formatter a loosely-typed ValueType; charts carry pesos,
 *  so convert back to cents before formatting to keep one money renderer. */
const moneyFmt = (v: any) => formatMXN(Math.round(Number(v) * 100))

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-slate-500 text-sm p-6 text-center">{children}</div>
}

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('resumen')
  const [from, setFrom] = useState(daysAgo(29))
  const [to, setTo] = useState(today())
  const params = { from, to }

  const q = <T,>(key: string, url: string, enabled: boolean, withDates = true) =>
    useQuery<T>({
      queryKey: [key, withDates ? from : '', withDates ? to : ''],
      queryFn: () => client.get(url, withDates ? { params } : undefined).then(r => r.data),
      enabled,
    })

  const health     = q<any>('an-health', '/analytics/health', true, false)
  const overview   = q<any>('an-overview', '/analytics/overview', tab === 'resumen')
  const rent       = q<any>('an-rent', '/analytics/profitability', tab === 'rentabilidad')
  const billar     = q<any>('an-billar', '/analytics/pool-tables', tab === 'billar')
  const menu       = q<any>('an-menu', '/analytics/menu-engineering', tab === 'menu')
  const caja       = q<any>('an-caja', '/analytics/cash-flow', tab === 'caja')
  const inv        = q<any>('an-inv', '/analytics/inventory', tab === 'inventario', false)
  const costos     = q<any>('an-costos', '/analytics/cost-coverage', tab === 'costos', false)
  const personal   = q<any>('an-personal', '/analytics/staff', tab === 'personal')
  const riesgos    = q<any>('an-riesgos', '/analytics/anomalies', tab === 'riesgos')

  const notReady = health.data && !health.data.ready

  return (
    <div className="min-h-screen bg-slate-950 page-root text-slate-100">
      <NavBar />
      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <div className="flex items-center gap-3 mb-4">
          <ManagerBackButton />
          <h1 className="text-2xl font-extrabold tracking-tight">Analítica</h1>
          <span className="text-xs bg-red-900/60 border border-red-700 text-red-200
                           px-2 py-0.5 rounded-full">solo ADMIN</span>
        </div>

        {notReady && (
          <div className="bg-red-950/50 border border-red-700 text-red-200 rounded-xl p-4 mb-4">
            <b>Capa analítica no instalada</b> — faltan {health.data.missing_views.length} vistas.
            <div className="text-sm mt-2">
              Ejecuta <code className="bg-slate-800 px-1 rounded">db_update_analytics.sql</code>{' '}
              en esta base de datos:
            </div>
            <pre className="text-xs bg-slate-900 border border-slate-700 rounded p-2 mt-2
                            overflow-x-auto whitespace-pre-wrap">
{`docker cp db_update_analytics.sql billar-pos-postgres-1:/tmp/
docker exec billar-pos-postgres-1 psql -U billiard -d billiardbar \\
       -v ON_ERROR_STOP=1 -f /tmp/db_update_analytics.sql`}
            </pre>
            <details className="text-xs mt-2 text-red-300/80">
              <summary className="cursor-pointer">Ver vistas faltantes</summary>
              <div className="mt-1">{health.data.missing_views.join(', ')}</div>
            </details>
          </div>
        )}

        {/* date range */}
        <div className="flex flex-wrap items-end gap-3 mb-4 bg-slate-900 p-3 rounded-xl
                        border border-slate-800">
          <label className="text-sm">
            <span className="block text-xs text-slate-400 mb-1">Desde</span>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                   className="bg-slate-800 border border-slate-700 rounded px-2 py-1" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-slate-400 mb-1">Hasta</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
                   className="bg-slate-800 border border-slate-700 rounded px-2 py-1" />
          </label>
          <div className="flex gap-2">
            {[[7, '7d'], [30, '30d'], [90, '90d']].map(([n, l]) => (
              <button key={l as string}
                      onClick={() => { setFrom(daysAgo((n as number) - 1)); setTo(today()) }}
                      className="text-xs bg-slate-800 hover:bg-slate-700 border
                                 border-slate-700 rounded px-3 py-1.5">{l}</button>
            ))}
          </div>
          {(tab === 'inventario' || tab === 'costos') && (
            <span className="text-xs text-slate-500">
              Esta pestaña usa una ventana fija de 28 días definida por las vistas base.
            </span>
          )}
        </div>

        {/* tabs */}
        <div className="flex gap-1 mb-5 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${
                tab === t.id ? 'bg-sky-600 text-white font-semibold'
                             : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
              <span className="mr-1">{t.icon}</span>{t.label}
            </button>
          ))}
        </div>

        {tab === 'resumen'      && <Resumen d={overview.data} loading={overview.isLoading} />}
        {tab === 'rentabilidad' && <Rentabilidad d={rent.data} loading={rent.isLoading} />}
        {tab === 'billar'       && <Billar d={billar.data} loading={billar.isLoading} />}
        {tab === 'menu'       && <Menu d={menu.data} loading={menu.isLoading} />}
        {tab === 'caja'       && <Caja d={caja.data} loading={caja.isLoading} />}
        {tab === 'inventario' && <Inventario d={inv.data} loading={inv.isLoading} />}
        {tab === 'costos'     && <Costos d={costos.data} loading={costos.isLoading} />}
        {tab === 'personal'   && <Personal d={personal.data} loading={personal.isLoading} />}
        {tab === 'riesgos'    && <Riesgos d={riesgos.data} loading={riesgos.isLoading} />}
      </div>
    </div>
  )
}

/* ── Resumen (Executive) ─────────────────────────────────────────────────── */
function Resumen({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>
  const t = d.totales, v = d.variacion_pct

  const serie = d.serie_diaria.map((r: any) => ({
    fecha: r.fecha.slice(5),
    ventas: pesos(r.ventas_cents),
    utilidad: pesos(r.utilidad_cents),
    billar: pesos(r.billar_cents),
  }))

  return (
    <div className="space-y-4">
      <CoverageBanner pct={t.cobertura_costo_pct} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Ventas" value={formatMXN(t.ventas_cents)}
              sub={`${t.tickets} tickets · ${t.dias_operados} días`} />
        <Card title="Utilidad bruta" value={formatMXN(t.utilidad_total_cents)}
              sub={`Artículos ${formatMXN(t.utilidad_cents)} + billar ${formatMXN(t.billar_cents)}`}
              tone="good" />
        <Card title="Ticket promedio" value={formatMXN(t.ticket_promedio_cents)}
              sub={`Venta diaria ${formatMXN(t.venta_diaria_promedio_cents)}`} />
        <Card title="Propinas" value={formatMXN(t.propinas_cents)}
              sub={`Descuentos ${formatMXN(t.descuentos_cents)}`} />
      </div>

      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 text-sm
                      flex flex-wrap gap-6">
        <span>vs. periodo anterior ({d.comparativo.from} → {d.comparativo.to}):</span>
        <span>Ventas <Delta v={v.ventas} /></span>
        <span>Tickets <Delta v={v.tickets} /></span>
        <span>Utilidad <Delta v={v.utilidad} /></span>
      </div>

      <ChartFrame title="Ventas y utilidad por día"
        note="El billar se muestra aparte: no tiene costo de insumo, así que es margen casi puro.">
        <ComposedChart data={serie}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="fecha" stroke={C.muted} fontSize={11} />
          <YAxis stroke={C.muted} fontSize={11} />
          <Tooltip {...tooltipStyle} formatter={moneyFmt} />
          <Legend />
          <Bar dataKey="ventas" name="Ventas" fill={C.sales} />
          <Bar dataKey="billar" name="Billar" fill={C.accent} />
          <Line type="monotone" dataKey="utilidad" name="Utilidad" stroke={C.profit}
                strokeWidth={2} dot={false} />
        </ComposedChart>
      </ChartFrame>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartFrame title="Mezcla de pago (corregida)"
          note="Los pagos divididos se reparten por monto real. La vista kpis_diarios los cuenta dos veces.">
          <BarChart data={d.mezcla_pago.map((m: any) => ({
            metodo: m.metodo, monto: pesos(m.monto_cents), propina: pesos(m.propina_cents),
          }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="metodo" stroke={C.muted} fontSize={11} />
            <YAxis stroke={C.muted} fontSize={11} />
            <Tooltip {...tooltipStyle} formatter={moneyFmt} />
            <Legend />
            <Bar dataKey="monto" name="Ventas" fill={C.sales} />
            <Bar dataKey="propina" name="Propinas" fill={C.warn} />
          </BarChart>
        </ChartFrame>

        <ChartFrame title="Venta y utilidad por hora">
          <ComposedChart data={d.por_hora.map((h: any) => ({
            hora: `${h.hora}h`, venta: pesos(h.venta_cents), utilidad: pesos(h.utilidad_cents),
          }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="hora" stroke={C.muted} fontSize={11} />
            <YAxis stroke={C.muted} fontSize={11} />
            <Tooltip {...tooltipStyle} formatter={moneyFmt} />
            <Legend />
            <Area type="monotone" dataKey="venta" name="Venta" fill={C.sales}
                  stroke={C.sales} fillOpacity={0.25} />
            <Line type="monotone" dataKey="utilidad" name="Utilidad" stroke={C.profit}
                  strokeWidth={2} dot={false} />
          </ComposedChart>
        </ChartFrame>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartFrame title="Por categoría">
          <BarChart layout="vertical"
                    data={d.por_categoria.slice(0, 10).map((c: any) => ({
                      categoria: c.categoria, venta: pesos(c.venta_cents),
                      utilidad: pesos(c.utilidad_cents),
                    }))} margin={{ left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis type="number" stroke={C.muted} fontSize={11} />
            <YAxis type="category" dataKey="categoria" stroke={C.muted} fontSize={10}
                   width={110} />
            <Tooltip {...tooltipStyle} formatter={moneyFmt} />
            <Legend />
            <Bar dataKey="venta" name="Venta" fill={C.sales} />
            <Bar dataKey="utilidad" name="Utilidad" fill={C.profit} />
          </BarChart>
        </ChartFrame>

        <ChartFrame title="Pronóstico 7 días"
          note="Promedio del mismo día de la semana en las últimas 8 semanas (vista forecast_semanal).">
          <BarChart data={d.pronostico_7d.map((f: any) => ({
            dia: `${f.dia.slice(0, 3)} ${f.fecha.slice(8)}`,
            ventas: pesos(f.ventas_cents),
          }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="dia" stroke={C.muted} fontSize={11} />
            <YAxis stroke={C.muted} fontSize={11} />
            <Tooltip {...tooltipStyle} formatter={moneyFmt} />
            <Bar dataKey="ventas" name="Pronóstico" fill={C.accent} />
          </BarChart>
        </ChartFrame>
      </div>
    </div>
  )
}

/* ── Rentabilidad (net profit vs fixed costs) ────────────────────────────── */
function Rentabilidad({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>
  const r = d.resultado, cf = d.costos_fijos, eq = d.equilibrio, rg = d.rango

  const serie = d.serie_diaria.map((s: any) => ({
    fecha: s.fecha.slice(5),
    bruta: pesos(s.utilidad_bruta_cents),
    fijo: pesos(s.costo_fijo_cents),
    neta: pesos(s.utilidad_neta_cents),
  }))

  const esc = d.escenarios.map((e: any) => ({
    cogs: `${e.cogs_pct}%`,
    neta: pesos(e.utilidad_neta_mensual_cents),
    positivo: e.utilidad_neta_cents >= 0,
  }))

  const unreliable = (r.cobertura_costo_pct ?? 0) < 50

  return (
    <div className="space-y-4">
      {unreliable && (
        <div className="bg-red-950/50 border border-red-700 text-red-100 rounded-xl p-4">
          <div className="font-bold mb-1">⚠ La utilidad neta de abajo no es confiable</div>
          <div className="text-sm">
            Solo el <b>{r.cobertura_costo_pct?.toFixed(1)}%</b> de la venta de artículos tiene
            costo real capturado, así que el COGS está enormemente subestimado y la utilidad
            sobreestimada. Con <b>{formatMXN(cf.mensual_cents)}/mes</b> de costos fijos, esta
            diferencia decide entre <b>ganar o perder dinero</b> — no solo el tamaño del margen.
            Usa los escenarios de abajo mientras tanto.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Ventas" value={formatMXN(r.ventas_cents)}
              sub={`${rg.dias_calendario} días · ${rg.dias_operados} operados`} />
        <Card title="Utilidad bruta" value={formatMXN(r.utilidad_bruta_cents)}
              sub={`Artículos ${formatMXN(r.utilidad_articulos_cents)} + billar ${formatMXN(r.billar_cents)}`}
              tone="good" />
        <Card title="Costos fijos del periodo" value={formatMXN(r.costos_fijos_cents)}
              sub={`${formatMXN(cf.mensual_cents)}/mes · ${formatMXN(cf.diario_cents)}/día`}
              tone="warn" />
        <Card title="Utilidad neta" value={formatMXN(r.utilidad_neta_cents)}
              sub={`${formatMXN(r.utilidad_neta_mensual_cents)}/mes${unreliable ? ' — no confiable' : ''}`}
              tone={r.utilidad_neta_cents >= 0 ? 'good' : 'bad'} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
          <div className="font-bold mb-2">Punto de equilibrio</div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between border-b border-slate-700 pb-2">
              <span className="text-slate-400">Venta diaria necesaria</span>
              <span className="font-mono">{formatMXN(eq.venta_diaria_necesaria_cents)}</span>
            </div>
            <div className="flex justify-between border-b border-slate-700 pb-2">
              <span className="text-slate-400">Venta diaria actual</span>
              <span className={`font-mono ${
                eq.venta_diaria_actual_cents >= eq.venta_diaria_necesaria_cents
                  ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatMXN(eq.venta_diaria_actual_cents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">COGS máximo tolerable</span>
              <span className="font-mono text-amber-400 font-bold">
                {eq.cogs_equilibrio_pct}%</span>
            </div>
            <div className="text-xs text-slate-500 pt-1">{eq.nota}</div>
          </div>
        </div>

        <ChartFrame title="Utilidad neta mensual según el COGS real" height={220}
          note="El COGS real es desconocido hoy. Cada barra es un escenario.">
          <BarChart data={esc}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="cogs" stroke={C.muted} fontSize={11} />
            <YAxis stroke={C.muted} fontSize={11} />
            <Tooltip {...tooltipStyle} formatter={moneyFmt} />
            <Bar dataKey="neta" name="Utilidad neta / mes">
              {esc.map((e: any, i: number) => (
                <Cell key={i} fill={e.positivo ? C.profit : C.cost} />
              ))}
            </Bar>
          </BarChart>
        </ChartFrame>
      </div>

      <ChartFrame title="Utilidad bruta vs. costo fijo diario"
        note="La línea es el costo fijo de cada día. Todo lo que quede por debajo es un día en pérdida.">
        <ComposedChart data={serie}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="fecha" stroke={C.muted} fontSize={11} />
          <YAxis stroke={C.muted} fontSize={11} />
          <Tooltip {...tooltipStyle} formatter={moneyFmt} />
          <Legend />
          <Bar dataKey="bruta" name="Utilidad bruta" fill={C.profit} />
          <Line type="monotone" dataKey="fijo" name="Costo fijo diario" stroke={C.cost}
                strokeWidth={2} dot={false} strokeDasharray="5 4" />
        </ComposedChart>
      </ChartFrame>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700 flex justify-between">
          <span>Costos fijos mensuales</span>
          <span className="font-mono">{formatMXN(cf.mensual_cents)}/mes</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-900">
            <tr className="text-left text-xs text-slate-400">
              <th className="p-2">Concepto</th><th className="p-2">Categoría</th>
              <th className="p-2 text-right">Mensual</th><th className="p-2 text-right">Diario</th>
              <th className="p-2 text-right">Anual</th><th className="p-2 text-right">% del total</th>
            </tr>
          </thead>
          <tbody>
            {cf.conceptos.map((c: any) => (
              <tr key={c.concepto} className="border-t border-slate-700/60">
                <td className="p-2">{c.concepto}</td>
                <td className="p-2 text-xs text-slate-400">{c.categoria}</td>
                <td className="p-2 text-right font-mono">{formatMXN(c.mensual_cents)}</td>
                <td className="p-2 text-right font-mono text-slate-400">
                  {formatMXN(c.diario_cents)}</td>
                <td className="p-2 text-right font-mono text-slate-400">
                  {formatMXN(c.anual_cents)}</td>
                <td className="p-2 text-right font-mono">
                  {cf.mensual_cents ? (c.mensual_cents / cf.mensual_cents * 100).toFixed(1) : '0'}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Billar (pool table earnings) ────────────────────────────────────────── */
function Billar({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>
  const r = d.resumen

  return (
    <div className="space-y-4">
      <div className="bg-violet-950/40 border border-violet-700 text-violet-100 rounded-xl p-4">
        <div className="font-bold mb-1">🎱 El billar es la venta más limpia del negocio</div>
        <div className="text-sm">
          {d.nota} En este periodo generó <b>{formatMXN(r.ingreso_total_cents)}</b>, que cubre por
          sí solo el <b>{r.cubre_costos_fijos_pct}%</b> de los{' '}
          {formatMXN(r.costos_fijos_periodo_cents)} de costos fijos.
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Ingreso por billar" value={formatMXN(r.ingreso_total_cents)}
              sub={`${r.pct_de_ventas_totales}% de las ventas totales`} tone="good" />
        <Card title="Horas jugadas" value={`${r.horas_totales.toLocaleString('es-MX')} h`}
              sub={`${r.sesiones} sesiones · ${r.mesas_activas} mesas`} />
        <Card title="Ingreso por hora" value={formatMXN(r.ingreso_por_hora_cents)} />
        <Card title="Ingreso por día" value={formatMXN(r.ingreso_diario_cents)}
              sub="promedio sobre días calendario" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartFrame title="Ingreso por mesa">
          <BarChart data={d.mesas.map((m: any) => ({
            mesa: m.mesa, ingreso: pesos(m.ingreso_cents), horas: m.horas,
          }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="mesa" stroke={C.muted} fontSize={11} />
            <YAxis stroke={C.muted} fontSize={11} />
            <Tooltip {...tooltipStyle} formatter={moneyFmt} />
            <Bar dataKey="ingreso" name="Ingreso" fill={C.accent} />
          </BarChart>
        </ChartFrame>

        <ChartFrame title="Ingreso por día de la semana">
          <BarChart data={d.por_dia_semana.map((x: any) => ({
            dia: DIAS_ISO[x.dia_semana_iso] ?? x.dia_semana_iso,
            ingreso: pesos(x.ingreso_cents),
          }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="dia" stroke={C.muted} fontSize={11} />
            <YAxis stroke={C.muted} fontSize={11} />
            <Tooltip {...tooltipStyle} formatter={moneyFmt} />
            <Bar dataKey="ingreso" name="Ingreso" fill={C.accent} />
          </BarChart>
        </ChartFrame>
      </div>

      <ChartFrame title="Ingreso diario de billar">
        <AreaChart data={d.serie_diaria.map((s: any) => ({
          fecha: s.fecha.slice(5), ingreso: pesos(s.ingreso_cents),
        }))}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="fecha" stroke={C.muted} fontSize={11} />
          <YAxis stroke={C.muted} fontSize={11} />
          <Tooltip {...tooltipStyle} formatter={moneyFmt} />
          <Area type="monotone" dataKey="ingreso" name="Ingreso" stroke={C.accent}
                fill={C.accent} fillOpacity={0.25} />
        </AreaChart>
      </ChartFrame>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700">
          Detalle por mesa
          <div className="text-xs text-slate-500 font-normal mt-1">
            La tarifa por hora es prácticamente igual en todas las mesas, así que las
            diferencias de ingreso son diferencias de <b>uso</b>, no de precio.
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-900">
            <tr className="text-left text-xs text-slate-400">
              <th className="p-2">Mesa</th><th className="p-2">Nombre</th>
              <th className="p-2 text-right">Ingreso</th><th className="p-2 text-right">% billar</th>
              <th className="p-2 text-right">Horas</th><th className="p-2 text-right">Sesiones</th>
              <th className="p-2 text-right">$/hora</th>
              <th className="p-2 text-right">Min. gratis</th>
              <th className="p-2 text-right">Días activa</th>
              <th className="p-2 text-right">Editadas</th>
            </tr>
          </thead>
          <tbody>
            {d.mesas.map((m: any) => (
              <tr key={m.mesa} className="border-t border-slate-700/60 hover:bg-slate-700/40">
                <td className="p-2 font-medium">{m.mesa}</td>
                <td className="p-2 text-xs text-slate-400">{m.nombre}</td>
                <td className="p-2 text-right font-mono text-emerald-400">
                  {formatMXN(m.ingreso_cents)}</td>
                <td className="p-2 text-right font-mono">{m.pct_del_billar}%</td>
                <td className="p-2 text-right font-mono">{m.horas}</td>
                <td className="p-2 text-right font-mono">{m.sesiones}</td>
                <td className="p-2 text-right font-mono">
                  {formatMXN(m.ingreso_por_hora_cents)}</td>
                <td className="p-2 text-right font-mono text-slate-400">
                  {m.minutos_gratis_promo}</td>
                <td className="p-2 text-right font-mono text-slate-400">{m.dias_activa}</td>
                <td className={`p-2 text-right font-mono ${
                  m.sesiones_editadas > 0 ? 'text-amber-400' : 'text-slate-500'}`}>
                  {m.sesiones_editadas}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-600 bg-slate-900 font-bold">
              <td className="p-2" colSpan={2}>TOTAL</td>
              <td className="p-2 text-right font-mono text-emerald-400">
                {formatMXN(r.ingreso_total_cents)}</td>
              <td className="p-2 text-right font-mono">100%</td>
              <td className="p-2 text-right font-mono">{r.horas_totales}</td>
              <td className="p-2 text-right font-mono">{r.sesiones}</td>
              <td className="p-2 text-right font-mono">
                {formatMXN(r.ingreso_por_hora_cents)}</td>
              <td colSpan={3}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

/* ── Menú (Menu Engineering) ─────────────────────────────────────────────── */
function Menu({ d, loading }: { d: any; loading: boolean }) {
  const [filtro, setFiltro] = useState<string>('TODOS')
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>

  const prods = d.productos.filter((p: any) => filtro === 'TODOS' || p.cuadrante === filtro)
  const scatter = d.productos
    .filter((p: any) => p.margen_pct != null)
    .map((p: any) => ({
      x: p.unidades, y: p.margen_pct, z: pesos(p.utilidad_cents),
      producto: p.producto, cuadrante: p.cuadrante,
    }))

  const cobertura = d.productos.length
    ? d.productos.reduce((a: number, p: any) => a + (p.cobertura_costo_pct ?? 0), 0) / d.productos.length
    : null

  return (
    <div className="space-y-4">
      <CoverageBanner pct={cobertura} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {(['ESTRELLA', 'CABALLO', 'ROMPECABEZAS', 'PERRO'] as const).map(qd => (
          <button key={qd} onClick={() => setFiltro(filtro === qd ? 'TODOS' : qd)}
            className={`text-left rounded-xl p-4 border transition-colors ${
              filtro === qd ? 'border-sky-500 bg-slate-700' : 'border-slate-700 bg-slate-800'
            } hover:bg-slate-700`}>
            <div className="text-xs uppercase tracking-wide"
                 style={{ color: QUADRANT_COLOR[qd] }}>{qd}</div>
            <div className="text-2xl font-bold font-mono">{d.resumen_cuadrantes[qd]}</div>
            <div className="text-xs text-slate-500 mt-1">{QUADRANT_LABEL[qd]}</div>
          </button>
        ))}
      </div>

      <ChartFrame title="Matriz de ingeniería de menú" height={340}
        note={`Comparado contra la MEDIANA del periodo (${d.medianas.unidades} unidades, ${d.medianas.margen_pct.toFixed(1)}% margen). Se usa mediana y no promedio porque un solo producto enorme deformaría el promedio.`}>
        <ScatterChart margin={{ left: 10, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis type="number" dataKey="x" name="Unidades" stroke={C.muted} fontSize={11}
                 label={{ value: 'Unidades vendidas', position: 'insideBottom', offset: -5,
                          fill: C.muted, fontSize: 11 }} />
          <YAxis type="number" dataKey="y" name="Margen %" stroke={C.muted} fontSize={11}
                 label={{ value: 'Margen %', angle: -90, position: 'insideLeft',
                          fill: C.muted, fontSize: 11 }} />
          <ZAxis type="number" dataKey="z" range={[40, 400]} />
          <Tooltip {...tooltipStyle} cursor={{ strokeDasharray: '3 3' }}
            content={({ payload }: any) => {
              if (!payload?.length) return null
              const p = payload[0].payload
              return (
                <div className="bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs">
                  <div className="font-bold">{p.producto}</div>
                  <div>{p.x} unidades · {p.y.toFixed(1)}% margen</div>
                  <div style={{ color: QUADRANT_COLOR[p.cuadrante] }}>{p.cuadrante}</div>
                </div>
              )
            }} />
          <Scatter data={scatter}>
            {scatter.map((s: any, i: number) => (
              <Cell key={i} fill={QUADRANT_COLOR[s.cuadrante]} fillOpacity={0.75} />
            ))}
          </Scatter>
        </ScatterChart>
      </ChartFrame>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700 flex justify-between">
          <span>Productos {filtro !== 'TODOS' && `— ${filtro}`}</span>
          {filtro !== 'TODOS' && (
            <button onClick={() => setFiltro('TODOS')}
                    className="text-xs text-sky-400">ver todos</button>
          )}
        </div>
        <div className="overflow-x-auto max-h-[560px]">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 sticky top-0">
              <tr className="text-left text-xs text-slate-400">
                <th className="p-2">Producto</th><th className="p-2">Categoría</th>
                <th className="p-2 text-right">Uds</th><th className="p-2 text-right">Venta</th>
                <th className="p-2 text-right">Costo</th><th className="p-2 text-right">Utilidad</th>
                <th className="p-2 text-right">Margen</th><th className="p-2">Cuadrante</th>
              </tr>
            </thead>
            <tbody>
              {prods.map((p: any) => (
                <tr key={p.producto} className="border-t border-slate-700/60 hover:bg-slate-700/40">
                  <td className="p-2">
                    {p.producto}
                    {!p.margen_confiable && (
                      <span title="Margen no confiable: falta costo capturado"
                            className="ml-1 text-amber-400">⚠</span>
                    )}
                  </td>
                  <td className="p-2 text-slate-400 text-xs">{p.categoria}</td>
                  <td className="p-2 text-right font-mono">{p.unidades}</td>
                  <td className="p-2 text-right font-mono">{formatMXN(p.venta_cents)}</td>
                  <td className="p-2 text-right font-mono text-slate-400">
                    {formatMXN(p.costo_cents)}</td>
                  <td className="p-2 text-right font-mono text-emerald-400">
                    {formatMXN(p.utilidad_cents)}</td>
                  <td className="p-2 text-right font-mono">
                    {p.margen_pct == null ? '—' : `${p.margen_pct.toFixed(1)}%`}</td>
                  <td className="p-2 text-xs" style={{ color: QUADRANT_COLOR[p.cuadrante] }}>
                    {p.cuadrante}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {d.productos_lentos?.length > 0 && (
        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
          <div className="p-3 font-bold border-b border-slate-700">
            Productos lentos <span className="text-xs text-slate-500 font-normal">
              (ventana fija de 30 días — vista productos_lentos)</span>
          </div>
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 sticky top-0">
                <tr className="text-left text-xs text-slate-400">
                  <th className="p-2">Producto</th><th className="p-2">Categoría</th>
                  <th className="p-2 text-right">Precio</th><th className="p-2 text-right">Uds 30d</th>
                  <th className="p-2">Última venta</th><th className="p-2">Diagnóstico</th>
                </tr>
              </thead>
              <tbody>
                {d.productos_lentos.map((p: any, i: number) => (
                  <tr key={i} className="border-t border-slate-700/60">
                    <td className="p-2">{p.producto}</td>
                    <td className="p-2 text-slate-400 text-xs">{p.categoria}</td>
                    <td className="p-2 text-right font-mono">{formatMXN(p.precio_cents)}</td>
                    <td className="p-2 text-right font-mono">{p.unidades_30d}</td>
                    <td className="p-2 text-xs text-slate-400">{p.ultima_venta ?? 'nunca'}</td>
                    <td className="p-2 text-xs text-yellow-400">{p.diagnostico}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Caja (Cash Flow) ────────────────────────────────────────────────────── */
function Caja({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>
  const r = d.resumen, rec = d.reconciliacion

  const porDia: Record<string, any> = {}
  d.mezcla_diaria.forEach((m: any) => {
    porDia[m.fecha] ??= { fecha: m.fecha.slice(5), CASH: 0, CARD: 0, EXTERNAL: 0 }
    porDia[m.fecha][m.metodo] = pesos(m.monto_cents)
  })

  return (
    <div className="space-y-4">
      <div className={`rounded-xl p-3 border text-sm ${
        rec.diferencia_cents === 0
          ? 'bg-emerald-950/40 border-emerald-800 text-emerald-200'
          : 'bg-red-950/40 border-red-800 text-red-200'}`}>
        <b>Reconciliación:</b> suma de pagos {formatMXN(rec.suma_pagos_cents)} vs. ventas{' '}
        {formatMXN(rec.ventas_tickets_cents)} → diferencia{' '}
        {formatMXN(rec.diferencia_cents)}.{' '}
        {rec.diferencia_cents === 0
          ? 'Cuadra exactamente.'
          : 'No cuadra — hay tickets con montos de pago inconsistentes.'}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Ventas efectivo" value={formatMXN(r.efectivo_ventas_cents)} />
        <Card title="Ventas tarjeta" value={formatMXN(r.tarjeta_ventas_cents)} />
        <Card title="Gastos" value={formatMXN(r.gastos_cents)} tone="warn" />
        <Card title="Retiros a caja fuerte" value={formatMXN(r.retiros_cents)} />
        <Card title="Propinas pagadas al personal"
              value={formatMXN(r.propinas_pagadas_cents)} tone="warn"
              sub={`Efectivo ${formatMXN(r.propinas_efectivo_cents)} · Tarjeta ${formatMXN(r.propinas_tarjeta_cents)}`} />
        <Card title="Sesiones OK" value={`${r.sesiones_ok}/${r.sesiones}`} tone="good"
              sub={`${r.sesiones_sobrante} con sobrante`} />
        <Card title="Sesiones con faltante" value={String(r.sesiones_con_faltante)}
              tone={r.sesiones_con_faltante > 0 ? 'bad' : 'good'}
              sub={`Faltante ${formatMXN(r.faltante_total_cents)}`} />
        <Card title="Diferencia acumulada" value={formatMXN(r.diferencia_total_cents)}
              tone={r.diferencia_total_cents < 0 ? 'bad' : 'good'}
              sub={`${r.sesiones} sesiones`} />
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-slate-300">
        <b>Cómo se calcula el efectivo esperado.</b> Las propinas se pagan al personal{' '}
        <b>en efectivo el mismo día</b>, incluidas las que se dejaron con tarjeta, así que
        salen del cajón:
        <div className="font-mono text-xs mt-2 text-slate-400">
          esperado = fondo + ventas en efectivo + propinas en efectivo − propinas pagadas
          − gastos − retiros
        </div>
        <div className="text-xs mt-1 text-slate-500">
          Las propinas en efectivo entran y vuelven a salir, así que se cancelan: el drenaje
          neto del cajón son las propinas de tarjeta ({formatMXN(r.propinas_tarjeta_cents)}).
          Un <b>sobrante</b> del tamaño de las propinas del día normalmente significa que ese
          día no se pagaron.
        </div>
      </div>

      <ChartFrame title="Ventas por método y día">
        <BarChart data={Object.values(porDia)}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="fecha" stroke={C.muted} fontSize={11} />
          <YAxis stroke={C.muted} fontSize={11} />
          <Tooltip {...tooltipStyle} formatter={moneyFmt} />
          <Legend />
          <Bar dataKey="CASH" name="Efectivo" stackId="a" fill={C.profit} />
          <Bar dataKey="CARD" name="Tarjeta" stackId="a" fill={C.sales} />
          <Bar dataKey="EXTERNAL" name="Externo" stackId="a" fill={C.muted} />
        </BarChart>
      </ChartFrame>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700">
          Sesiones de caja
          <div className="text-xs text-slate-500 font-normal mt-1">
            La columna <b>Propinas</b> es lo que se pagó al personal desde el cajón (incluye
            las de tarjeta). Ya está descontada del esperado.
          </div>
        </div>
        <div className="overflow-x-auto max-h-[520px]">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 sticky top-0">
              <tr className="text-left text-xs text-slate-400">
                <th className="p-2">Fecha</th><th className="p-2">Abrió / Cerró</th>
                <th className="p-2 text-right">Fondo</th><th className="p-2 text-right">Efectivo</th>
                <th className="p-2 text-right">Propinas</th>
                <th className="p-2 text-right">Gastos</th><th className="p-2 text-right">Retiros</th>
                <th className="p-2 text-right">Esperado</th><th className="p-2 text-right">Contado</th>
                <th className="p-2 text-right">Dif.</th><th className="p-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {d.sesiones.map((s: any) => (
                <tr key={s.session_id} className="border-t border-slate-700/60 hover:bg-slate-700/40">
                  <td className="p-2 whitespace-nowrap">{s.fecha}</td>
                  <td className="p-2 text-xs text-slate-400">
                    {s.abierta_por ?? '—'} / {s.cerrada_por ?? '—'}</td>
                  <td className="p-2 text-right font-mono">{formatMXN(s.fondo_inicial_cents)}</td>
                  <td className="p-2 text-right font-mono">{formatMXN(s.efectivo_ventas_cents)}</td>
                  <td className="p-2 text-right font-mono text-yellow-400"
                      title={`Efectivo ${formatMXN(s.propinas_efectivo_cents)} + tarjeta ${formatMXN(s.propinas_tarjeta_cents)}`}>
                    −{formatMXN(s.propinas_pagadas_cents)}</td>
                  <td className="p-2 text-right font-mono text-yellow-400">
                    {formatMXN(s.gastos_cents)}</td>
                  <td className="p-2 text-right font-mono">{formatMXN(s.retiros_cents)}</td>
                  <td className="p-2 text-right font-mono">{formatMXN(s.esperado_cents)}</td>
                  <td className="p-2 text-right font-mono">
                    {s.contado_cents == null ? '—' : formatMXN(s.contado_cents)}</td>
                  <td className={`p-2 text-right font-mono ${
                    s.diferencia_cents == null ? '' :
                    s.diferencia_cents < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {s.diferencia_cents == null ? '—' : formatMXN(s.diferencia_cents)}</td>
                  <td className={`p-2 text-xs ${
                    s.diagnostico === 'Faltante grave' ? 'text-red-400'
                    : s.diagnostico === 'Faltante' ? 'text-amber-400'
                    : s.diagnostico === 'OK' ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {s.diagnostico}
                    {s.diagnostico === 'Sobrante'
                     && s.propinas_pagadas_cents > 0
                     && Math.abs(s.diferencia_cents - s.propinas_pagadas_cents) <= 5000 && (
                      <span className="block text-slate-500"
                            title="El sobrante coincide con las propinas del día">
                        ≈ propinas no pagadas
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ── Inventario ──────────────────────────────────────────────────────────── */
function Inventario({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>
  const r = d.resumen
  const urgentes = d.compras.filter((c: any) => c.recomendacion !== 'OK'
                                             && c.recomendacion !== 'Sin consumo últimos 28 días')

  const tone = (rec: string) =>
    rec === 'Comprar urgente' ? 'text-red-400'
    : rec === 'Comprar esta semana' ? 'text-amber-400'
    : rec === 'Debajo de mínimo' ? 'text-yellow-400' : 'text-slate-400'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Insumos activos" value={String(r.insumos)} />
        <Card title="Por comprar" value={String(r.por_comprar)}
              tone={r.por_comprar > 0 ? 'warn' : 'good'} />
        <Card title="Compra estimada" value={formatMXN(r.costo_compra_estimado_cents)} />
        <Card title="Merma valorizada 28d" value={formatMXN(r.merma_valorizada_cents)}
              tone={r.merma_valorizada_cents > 0 ? 'bad' : 'good'}
              sub={`${r.insumos_con_merma} insumos`} />
      </div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700">
          Compras sugeridas <span className="text-xs text-slate-500 font-normal">
            ({d.ventana})</span>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 sticky top-0">
              <tr className="text-left text-xs text-slate-400">
                <th className="p-2">Insumo</th><th className="p-2">Proveedor</th>
                <th className="p-2 text-right">Stock</th><th className="p-2 text-right">Cobertura</th>
                <th className="p-2 text-right">Comprar</th><th className="p-2 text-right">Costo est.</th>
                <th className="p-2">Recomendación</th>
              </tr>
            </thead>
            <tbody>
              {urgentes.map((c: any, i: number) => (
                <tr key={i} className="border-t border-slate-700/60">
                  <td className="p-2">{c.insumo} <span className="text-xs text-slate-500">
                    {c.unidad}</span></td>
                  <td className="p-2 text-xs text-slate-400">{c.proveedor ?? '—'}</td>
                  <td className="p-2 text-right font-mono">{c.stock}</td>
                  <td className="p-2 text-right font-mono">
                    {c.dias_cobertura == null ? '—' : `${c.dias_cobertura.toFixed(1)}d`}</td>
                  <td className="p-2 text-right font-mono">{c.sugerido_comprar}</td>
                  <td className="p-2 text-right font-mono">{formatMXN(c.costo_estimado_cents)}</td>
                  <td className={`p-2 text-xs ${tone(c.recomendacion)}`}>{c.recomendacion}</td>
                </tr>
              ))}
              {!urgentes.length && (
                <tr><td colSpan={7} className="p-6 text-center text-slate-500">
                  Nada por comprar.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700">
          Merma y ajustes
          <div className="text-xs text-slate-500 font-normal mt-1">
            Merma = desperdicio declarado + ajustes netos negativos. Un ajuste positivo es
            inventario encontrado, no perdido, y no cuenta como merma.
          </div>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 sticky top-0">
              <tr className="text-left text-xs text-slate-400">
                <th className="p-2">Insumo</th><th className="p-2 text-right">Consumo 28d</th>
                <th className="p-2 text-right">Merma</th><th className="p-2 text-right">Ajuste man.</th>
                <th className="p-2 text-right">Ajuste conteo</th>
                <th className="p-2 text-right">Valorizada</th><th className="p-2">Diagnóstico</th>
              </tr>
            </thead>
            <tbody>
              {d.merma.map((m: any, i: number) => (
                <tr key={i} className="border-t border-slate-700/60">
                  <td className="p-2">{m.insumo}</td>
                  <td className="p-2 text-right font-mono">{m.consumo_28d}</td>
                  <td className="p-2 text-right font-mono text-red-400">{m.merma_unidades}</td>
                  <td className="p-2 text-right font-mono">{m.ajuste_manual}</td>
                  <td className="p-2 text-right font-mono">{m.ajuste_conteo}</td>
                  <td className="p-2 text-right font-mono">
                    {formatMXN(m.merma_valorizada_cents)}</td>
                  <td className="p-2 text-xs text-slate-400">{m.diagnostico}</td>
                </tr>
              ))}
              {!d.merma.length && (
                <tr><td colSpan={7} className="p-6 text-center text-slate-500">
                  Sin merma registrada.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ── Costos (COGS remediation worklist) ──────────────────────────────────── */
function Costos({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>
  const r = d.resumen
  const faltantes = d.insumos.filter((i: any) => !i.tiene_costo)

  return (
    <div className="space-y-4">
      <div className="bg-amber-950/40 border border-amber-700 text-amber-100 rounded-xl p-4">
        <div className="font-bold mb-1">Por qué esta pantalla es la más importante</div>
        <div className="text-sm">
          El motor de descuento de inventario <b>sí funciona</b>: resuelve la receta,
          encuentra el insumo y lo multiplica por un costo unitario de <b>cero</b>.
          Por eso el margen reportado es imposible. No faltan recetas —{' '}
          <b>faltan costos</b>. {r.insumos_sin_costo} de {r.insumos_activos} insumos
          activos no tienen costo, y {formatMXN(r.venta_expuesta_cents)} de venta pasa
          por ellos.
          <div className="mt-2">{d.accion}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Cobertura de costo" value={`${(r.cobertura_pct ?? 0).toFixed(1)}%`}
              tone={(r.cobertura_pct ?? 0) < 50 ? 'bad' : 'good'}
              sub={`${r.lineas_con_costo} de ${r.lineas} líneas`} />
        <Card title="Insumos sin costo" value={`${r.insumos_sin_costo}/${r.insumos_activos}`}
              tone="bad" />
        <Card title="Venta expuesta" value={formatMXN(r.venta_expuesta_cents)} tone="bad"
              sub="pasa por insumos sin costo" />
        <Card title="Venta evaluable" value={formatMXN(r.venta_evaluable_cents)}
              sub={`Excluye ${r.excluidas.join(', ')}`} />
      </div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700">
          Insumos sin costo — ordenados por venta expuesta
          <div className="text-xs text-slate-500 font-normal mt-1">
            Captura de arriba hacia abajo: los primeros 10 recuperan la mayor parte de la
            exactitud del margen.
          </div>
        </div>
        <div className="overflow-x-auto max-h-[560px]">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 sticky top-0">
              <tr className="text-left text-xs text-slate-400">
                <th className="p-2">#</th><th className="p-2">Insumo</th>
                <th className="p-2">Categoría</th><th className="p-2">Proveedor</th>
                <th className="p-2 text-right">Líneas</th>
                <th className="p-2 text-right">Venta expuesta</th><th className="p-2">Prioridad</th>
              </tr>
            </thead>
            <tbody>
              {faltantes.map((i: any, idx: number) => (
                <tr key={i.inventory_item_id}
                    className={`border-t border-slate-700/60 ${idx < 10 ? 'bg-amber-950/20' : ''}`}>
                  <td className="p-2 text-slate-500 font-mono">{idx + 1}</td>
                  <td className="p-2 font-medium">{i.insumo}
                    <span className="text-xs text-slate-500 ml-1">{i.unidad}</span></td>
                  <td className="p-2 text-xs text-slate-400">{i.categoria}</td>
                  <td className="p-2 text-xs text-slate-400">{i.proveedor ?? '—'}</td>
                  <td className="p-2 text-right font-mono">{i.lineas_expuestas}</td>
                  <td className="p-2 text-right font-mono text-amber-400">
                    {formatMXN(i.venta_expuesta_cents)}</td>
                  <td className="p-2 text-xs">{i.prioridad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ── Personal ────────────────────────────────────────────────────────────── */
function Personal({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>

  return (
    <div className="space-y-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-slate-300">
        {d.nota}
      </div>

      <ChartFrame title="Ventas y utilidad por empleado">
        <BarChart data={d.empleados.map((e: any) => ({
          empleado: e.empleado, ventas: pesos(e.ventas_cents),
          utilidad: pesos(e.utilidad_cents),
        }))}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="empleado" stroke={C.muted} fontSize={11} />
          <YAxis stroke={C.muted} fontSize={11} />
          <Tooltip {...tooltipStyle} formatter={moneyFmt} />
          <Legend />
          <Bar dataKey="ventas" name="Ventas" fill={C.sales} />
          <Bar dataKey="utilidad" name="Utilidad" fill={C.profit} />
        </BarChart>
      </ChartFrame>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-900">
            <tr className="text-left text-xs text-slate-400">
              <th className="p-2">Empleado</th><th className="p-2">Rol</th>
              <th className="p-2 text-right">Tickets</th><th className="p-2 text-right">Ventas</th>
              <th className="p-2 text-right">Ticket prom.</th>
              <th className="p-2 text-right">Utilidad</th><th className="p-2 text-right">Propinas</th>
              <th className="p-2 text-right">Descuentos</th>
              <th className="p-2 text-right">Dur. prom.</th>
              <th className="p-2 text-right">Reab.</th><th className="p-2 text-right">Edit.</th>
            </tr>
          </thead>
          <tbody>
            {d.empleados.map((e: any) => (
              <tr key={e.empleado} className="border-t border-slate-700/60 hover:bg-slate-700/40">
                <td className="p-2 font-medium">{e.empleado}</td>
                <td className="p-2 text-xs text-slate-400">{e.rol ?? '—'}</td>
                <td className="p-2 text-right font-mono">{e.tickets}</td>
                <td className="p-2 text-right font-mono">{formatMXN(e.ventas_cents)}</td>
                <td className="p-2 text-right font-mono">{formatMXN(e.ticket_promedio_cents)}</td>
                <td className="p-2 text-right font-mono text-emerald-400">
                  {formatMXN(e.utilidad_cents)}</td>
                <td className="p-2 text-right font-mono">{formatMXN(e.propinas_cents)}</td>
                <td className="p-2 text-right font-mono text-yellow-400">
                  {formatMXN(e.descuentos_cents)}</td>
                <td className="p-2 text-right font-mono text-slate-400">
                  {e.duracion_prom_min == null ? '—' : `${e.duracion_prom_min}m`}</td>
                <td className={`p-2 text-right font-mono ${
                  e.reaperturas > 0 ? 'text-amber-400' : 'text-slate-500'}`}>{e.reaperturas}</td>
                <td className={`p-2 text-right font-mono ${
                  e.editados > 0 ? 'text-amber-400' : 'text-slate-500'}`}>{e.editados}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Riesgos ─────────────────────────────────────────────────────────────── */
const RISK_LABEL: Record<string, string> = {
  VOID_LINEA: 'Líneas canceladas',
  TICKET_REABIERTO: 'Tickets reabiertos',
  DESCUENTO_MANUAL: 'Descuentos manuales',
  EDITADO_POST_CIERRE: 'Editados tras cierre',
}

function Riesgos({ d, loading }: { d: any; loading: boolean }) {
  if (loading) return <Empty>Cargando…</Empty>
  if (!d) return <Empty>Sin datos.</Empty>

  return (
    <div className="space-y-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-slate-300">
        Las vistas de venta <b>excluyen</b> las líneas canceladas — correcto para ingresos,
        ciego para riesgo. Esta pestaña es el inverso deliberado.
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {d.resumen.map((r: any) => (
          <Card key={r.tipo} title={RISK_LABEL[r.tipo] ?? r.tipo}
                value={formatMXN(r.monto_cents)} sub={`${r.eventos} eventos`}
                tone={r.tipo === 'VOID_LINEA' ? 'bad' : 'warn'} />
        ))}
      </div>

      <ChartFrame title="Eventos por usuario">
        <BarChart data={Object.values(
          d.por_usuario.reduce((acc: any, r: any) => {
            acc[r.usuario] ??= { usuario: r.usuario }
            acc[r.usuario][r.tipo] = pesos(r.monto_cents)
            return acc
          }, {}))}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="usuario" stroke={C.muted} fontSize={11} />
          <YAxis stroke={C.muted} fontSize={11} />
          <Tooltip {...tooltipStyle} formatter={moneyFmt} />
          <Legend />
          <Bar dataKey="VOID_LINEA" name="Cancelaciones" stackId="a" fill={C.cost} />
          <Bar dataKey="DESCUENTO_MANUAL" name="Descuentos" stackId="a" fill={C.warn} />
          <Bar dataKey="TICKET_REABIERTO" name="Reaperturas" stackId="a" fill={C.accent} />
          <Bar dataKey="EDITADO_POST_CIERRE" name="Ediciones" stackId="a" fill={C.muted} />
        </BarChart>
      </ChartFrame>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="p-3 font-bold border-b border-slate-700">
          Detalle <span className="text-xs text-slate-500 font-normal">
            (máx. 200, mayor monto primero)</span>
        </div>
        <div className="overflow-x-auto max-h-[560px]">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 sticky top-0">
              <tr className="text-left text-xs text-slate-400">
                <th className="p-2">Tipo</th><th className="p-2">Fecha</th>
                <th className="p-2">Detalle</th><th className="p-2">Motivo</th>
                <th className="p-2">Usuario</th><th className="p-2 text-right">Monto</th>
              </tr>
            </thead>
            <tbody>
              {d.detalle.map((r: any, i: number) => (
                <tr key={i} className="border-t border-slate-700/60 hover:bg-slate-700/40">
                  <td className="p-2 text-xs">{RISK_LABEL[r.tipo] ?? r.tipo}</td>
                  <td className="p-2 text-xs text-slate-400">{r.fecha}</td>
                  <td className="p-2">{r.detalle}</td>
                  <td className="p-2 text-xs text-slate-400">{r.motivo ?? '—'}</td>
                  <td className="p-2 text-xs">{r.usuario ?? '—'}
                    <span className="text-slate-500"> {r.rol ? `(${r.rol})` : ''}</span></td>
                  <td className="p-2 text-right font-mono">{formatMXN(r.monto_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
