/**
 * Reportes — the owner's single place for numbers (batch D3). ADMIN only.
 *
 * Replaces two overlapping screens (Analítica: 9 tabs, Reportes: 11 tabs) with
 * six pages, each with a few sub-tabs, one shared date bar and one URL scheme:
 *
 *     /manager/reportes/<page>/<sub>?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The panels themselves are unchanged (AnalyticsPanel, ReportPanel,
 * SafeCollectionsPage), so every number comes from the same tested endpoints.
 * Old links (/manager/analytics?tab=…, /manager/reports) redirect here — see
 * legacyReportsPath().
 */
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import NavBar from '../../components/NavBar'
import { DateRangeBar, useDateRange } from '../../components/DateRangeBar'
import AnalyticsPanel, { AnalyticsTab } from './AnalyticsPage'
import ReportPanel, { ReportTab } from './ReportsPage'
import SafeCollectionsPage from './SafeCollectionsPage'
import BarCountsPanel from './BarCountsPanel'
import CompsPanel from './CompsPanel'
import PortioningPanel from './PortioningPanel'

type Panel =
  | { kind: 'analytics'; tab: AnalyticsTab }
  | { kind: 'report'; tab: ReportTab }
  | { kind: 'safe' }
  | { kind: 'bar-counts' }
  | { kind: 'comps' }
  | { kind: 'portioning' }

interface Sub { id: string; label: string; panel: Panel; note?: string }
interface Page {
  id: string; label: string; icon: string; desc: string; subs: Sub[]
  /** shortcut to the operational screen behind this page */
  link?: { to: string; label: string }
}

const A = (tab: AnalyticsTab): Panel => ({ kind: 'analytics', tab })
const R = (tab: ReportTab): Panel => ({ kind: 'report', tab })

export const PAGES: Page[] = [
  { id: 'ventas', label: 'Ventas', icon: '🛒', desc: 'Cuánto, qué, cuándo y cómo pagan',
    subs: [
      { id: 'resumen',       label: 'Resumen',        panel: A('resumen') },
      { id: 'graficas',      label: 'Tendencia',      panel: R('charts') },
      { id: 'productos',     label: 'Productos',      panel: R('sales') },
      { id: 'pagos',         label: 'Pagos',          panel: R('payments') },
      { id: 'horas',         label: 'Horas pico',     panel: R('peak-hours') },
      { id: 'modificadores', label: 'Modificadores',  panel: R('modifiers') },
      { id: 'promociones',   label: 'Promociones',    panel: R('promotions') },
    ] },
  { id: 'billar', label: 'Billar', icon: '🎱', desc: 'Mesas, ocupación y sesiones',
    subs: [
      { id: 'mesas',    label: 'Mesas y ocupación', panel: A('billar') },
      { id: 'sesiones', label: 'Sesiones',          panel: R('pool') },
    ] },
  { id: 'rentabilidad', label: 'Rentabilidad', icon: '💹', desc: 'Utilidad, menú y costos',
    subs: [
      { id: 'resultado', label: 'Resultado', panel: A('rentabilidad') },
      { id: 'menu',      label: 'Menú',      panel: A('menu') },
      { id: 'costos',    label: 'Costos',    panel: A('costos') },
    ] },
  { id: 'caja', label: 'Caja', icon: '💵', desc: 'Flujo de efectivo y caja fuerte',
    link: { to: '/manager/cash', label: 'Turno de caja →' },
    subs: [
      { id: 'flujo',       label: 'Flujo de caja', panel: A('caja') },
      { id: 'caja-fuerte', label: 'Caja fuerte',   panel: { kind: 'safe' } },
    ] },
  { id: 'inventario', label: 'Inventario', icon: '📦', desc: 'Compras, rotación y bajas',
    link: { to: '/manager/inventory', label: 'Ir a inventario →' },
    subs: [
      { id: 'compras',    label: 'Compras y rotación', panel: A('inventario'),
        note: 'Esta vista usa una ventana fija de 28 días.' },
      { id: 'conteos',    label: 'Conteos de barra',  panel: { kind: 'bar-counts' } },
      { id: 'porcionado', label: 'Porcionado',        panel: { kind: 'portioning' } },
      { id: 'eliminados', label: 'Artículos eliminados', panel: R('inv-deletions') },
    ] },
  { id: 'personal', label: 'Personal y riesgos', icon: '👥', desc: 'Desempeño, propinas y alertas',
    subs: [
      { id: 'desempeno',       label: 'Desempeño',        panel: A('personal') },
      { id: 'ventas',          label: 'Ventas y propinas', panel: R('staff') },
      { id: 'riesgos',         label: 'Riesgos',          panel: A('riesgos') },
      { id: 'cortesias',       label: 'Cortesías y personal', panel: { kind: 'comps' } },
      { id: 'anulaciones',     label: 'Anulaciones',      panel: R('voids') },
      { id: 'menu-eliminados', label: 'Menú eliminado',   panel: R('menu-deletions') },
    ] },
]

/** Where a panel lives in the hub: "<page>/<sub>". */
function pathOf(match: (p: Panel) => boolean): string | null {
  for (const pg of PAGES) for (const sb of pg.subs) if (match(sb.panel)) return `${pg.id}/${sb.id}`
  return null
}

/** Map an old /manager/analytics?tab= or /manager/reports?tab= link to its new home. */
export function legacyReportsPath(kind: 'analytics' | 'report', tab: string | null): string {
  const hit = tab && pathOf(p => p.kind === kind && p.tab === tab)
  return hit || (kind === 'analytics' ? 'ventas/resumen' : 'ventas/productos')
}

/** Old routes: keep bookmarks and the old dashboard links working. */
export function LegacyReportsRedirect({ kind }: { kind: 'analytics' | 'report' }) {
  const { search } = useLocation()
  const qs = new URLSearchParams(search)
  const target = legacyReportsPath(kind, qs.get('tab'))
  qs.delete('tab')
  const rest = qs.toString()
  return <Navigate to={`/manager/reportes/${target}${rest ? `?${rest}` : ''}`} replace />
}

export default function ReportsHub() {
  const { page: pageId, sub: subId } = useParams()
  const { search } = useLocation()
  const navigate = useNavigate()
  const { from, to, setRange } = useDateRange('30d')

  const page = PAGES.find(p => p.id === pageId)
  const sub = page?.subs.find(s => s.id === subId)
  if (!page) return <Navigate to={`/manager/reportes/ventas/resumen${search}`} replace />
  if (!sub) return <Navigate to={`/manager/reportes/${page.id}/${page.subs[0].id}${search}`} replace />

  const go = (path: string) => navigate(`/manager/reportes/${path}${search}`)
  const goAnalytics = (tab: AnalyticsTab) => {
    const p = pathOf(x => x.kind === 'analytics' && x.tab === tab)
    if (p) go(p)
  }

  const tabBtn = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${active
      ? 'bg-sky-600 text-white font-semibold' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`

  return (
    <div className="min-h-screen bg-slate-950 page-root text-slate-100">
      <NavBar />
      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <Link to="/manager" className="text-sm text-slate-400 hover:text-sky-400">← Inicio</Link>
          <h1 className="text-2xl font-bold">Reportes</h1>
          <span className="text-xs bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded-full">
            solo dueño
          </span>
        </div>

        {/* pages */}
        <nav className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
          {PAGES.map(p => (
            <button key={p.id} onClick={() => go(`${p.id}/${p.subs[0].id}`)}
              className={`text-left rounded-xl border px-3 py-2 transition-colors ${p.id === page.id
                ? 'bg-sky-950/60 border-sky-600' : 'bg-slate-900 border-slate-800 hover:border-slate-600'}`}>
              <div className="text-sm font-semibold"><span className="mr-1">{p.icon}</span>{p.label}</div>
              <div className="text-[11px] text-slate-400 leading-tight mt-0.5">{p.desc}</div>
            </button>
          ))}
        </nav>

        <DateRangeBar from={from} to={to} onChange={setRange} note={sub.note} />

        {/* sub-tabs */}
        <div className="flex items-center gap-1 mb-5 overflow-x-auto">
          {page.subs.map(s => (
            <button key={s.id} onClick={() => go(`${page.id}/${s.id}`)} className={tabBtn(s.id === sub.id)}>
              {s.label}
            </button>
          ))}
          {page.link && (
            <Link to={page.link.to} className="ml-auto text-sm text-sky-400 hover:text-sky-300 whitespace-nowrap px-2">
              {page.link.label}
            </Link>
          )}
        </div>

        {sub.panel.kind === 'analytics' &&
          <AnalyticsPanel tab={sub.panel.tab} from={from} to={to} onNavigate={goAnalytics} />}
        {sub.panel.kind === 'report' &&
          <ReportPanel key={sub.panel.tab} tab={sub.panel.tab} from={from} to={to} />}
        {sub.panel.kind === 'safe' && <SafeCollectionsPage from={from} to={to} />}
        {sub.panel.kind === 'bar-counts' && <BarCountsPanel from={from} to={to} />}
        {sub.panel.kind === 'comps' && <CompsPanel from={from} to={to} />}
        {sub.panel.kind === 'portioning' && <PortioningPanel from={from} to={to} />}
      </div>
    </div>
  )
}
