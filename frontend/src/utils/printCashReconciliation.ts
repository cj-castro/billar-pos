import { getVenue, venueLogo, formatLocal } from './venue'
import { formatMXN } from './money'

export interface ReconSummary {
  opening_fund_cents: number
  // Absent when a MANAGER closes: sales figures are owner-only (the server omits them).
  total_sales_cents?: number
  cash_sales_cents?: number
  card_sales_cents?: number
  total_tips_cents: number
  cash_tips_cents: number
  card_tips_cents: number
  total_expenses_cents: number
  cash_expenses_cents: number
  tip_payout_cents: number
  expected_cash_cents: number
  closing_cash_counted_cents: number | null
  cash_over_short_cents: number | null
  ticket_count: number
  expenses: { payee: string; description: string; amount_cents: number; payment_method: string }[]
  tip_distribution: {
    floor_pct: number; bar_pct: number; kitchen_pct: number
    floor_cents: number; bar_cents: number; kitchen_cents: number
  } | null
}

const c = formatMXN
function sign(n: number) { return n >= 0 ? `+${c(n)}` : `-${c(Math.abs(n))}` }

const SHARED_STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: 48mm auto; margin: 1mm; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  body {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    font-weight: bold;
    width: 46mm;
    padding: 1mm;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { font-size: 13px; text-align: center; font-weight: 900; margin-bottom: 1mm; }
  .sub { text-align: center; font-size: 10px; font-weight: bold; color: #000; margin-bottom: 2mm; }
  .divider { border-top: 1.5px dashed #000; margin: 2mm 0; }
  .divider-solid { border-top: 2px solid #000; margin: 2mm 0; }
  .section-title { font-size: 10px; text-transform: uppercase; font-weight: 900; margin-bottom: 1mm; }
  .row { display: flex; justify-content: space-between; margin-bottom: 0.5mm; font-size: 11px; font-weight: bold; }
  .row.bold { font-weight: 900; }
  .row.indent { padding-left: 2mm; font-size: 10px; font-weight: bold; color: #000; }
  .total-row { display: flex; justify-content: space-between; font-size: 12px; font-weight: 900; border-top: 2px solid #000; padding-top: 1mm; margin-top: 1mm; margin-bottom: 1mm; }
  .over-short { text-align: center; font-size: 14px; font-weight: 900; border: 3px solid #000; padding: 1mm 2mm; margin: 2mm 0; }
  .tip-role { display: flex; justify-content: space-between; font-size: 11px; font-weight: 900; padding: 1.5mm 0; border-bottom: 1.5px dashed #000; }
  .tip-role .amount { font-size: 14px; }
  .footer { text-align: center; font-size: 10px; font-weight: bold; color: #000; margin-top: 3mm; }
`

function openPrint(html: string): boolean {
  const win = window.open('', '_blank', 'width=360,height=720')
  if (!win) return false
  win.document.write(html)
  win.document.close()
  win.focus()
  win.onload = () => { win.print(); win.close() }
  return true
}

export function printCashReconciliation(summary: ReconSummary, sessionDate: string, closingTime?: string) {
  const s = summary
  const overShortAmt = s.cash_over_short_cents ?? 0
  const overShortLabel = overShortAmt >= 0 ? '▲ SOBRANTE' : '▼ FALTANTE'

  const expenseRows = s.expenses.map(e =>
    `<div class="row indent"><span>${e.payee} – ${e.description}</span><span>-${c(e.amount_cents)}</span></div>`
  ).join('')

  const tipBlock = s.tip_distribution ? `
    <div class="divider"></div>
    <div class="section-title">Reparto de Propinas</div>
    <div class="row indent"><span>🏃 Piso / Meseros (${s.tip_distribution.floor_pct}%)</span><span>${c(s.tip_distribution.floor_cents)}</span></div>
    <div class="row indent"><span>🍹 Barra + Gerente (${s.tip_distribution.bar_pct}%)</span><span>${c(s.tip_distribution.bar_cents)}</span></div>
    <div class="row indent"><span>🍳 Cocina (${s.tip_distribution.kitchen_pct}%)</span><span>${c(s.tip_distribution.kitchen_cents)}</span></div>
    <div class="total-row"><span>Total Propinas</span><span>${c(s.total_tips_cents)}</span></div>
  ` : ''

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Corte de Caja</title>
<style>${SHARED_STYLE}
  .logo { width: 16mm; height: 16mm; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 1mm; }
</style></head><body>

  <div style="text-align:center">
    <img src="${venueLogo()}" class="logo" alt="${getVenue().name}" />
    <h1>CORTE DE CAJA</h1>
    <div class="sub">${sessionDate}${closingTime ? ' · ' + closingTime : ''}</div>
    <div class="sub">${s.ticket_count} ticket${s.ticket_count === 1 ? '' : 's'} cerrado${s.ticket_count === 1 ? '' : 's'}</div>
  </div>

  <div class="divider-solid"></div>

  <div class="section-title">Fondo Inicial</div>
  <div class="row bold"><span>Fondo de Apertura</span><span>${c(s.opening_fund_cents)}</span></div>

  ${s.total_sales_cents != null ? `
  <div class="divider"></div>
  <div class="section-title">Ventas por Tipo</div>
  <div class="row indent"><span>💵 Efectivo</span><span>${c(s.cash_sales_cents ?? 0)}</span></div>
  <div class="row indent"><span>💳 Tarjeta</span><span>${c(s.card_sales_cents ?? 0)}</span></div>
  <div class="total-row"><span>Total Ventas</span><span>${c(s.total_sales_cents)}</span></div>
  ` : ''}

  <div class="divider"></div>
  <div class="section-title">Propinas</div>
  <div class="row indent"><span>💵 Propinas Efectivo</span><span>${c(s.cash_tips_cents)}</span></div>
  <div class="row indent"><span>💳 Propinas Tarjeta</span><span>${c(s.card_tips_cents)}</span></div>
  <div class="total-row"><span>Total Propinas</span><span>${c(s.total_tips_cents)}</span></div>

  ${s.expenses.length > 0 ? `
  <div class="divider"></div>
  <div class="section-title">Gastos</div>
  ${expenseRows}
  <div class="total-row"><span>Total Gastos</span><span>-${c(s.total_expenses_cents)}</span></div>
  ` : ''}

  <div class="divider"></div>
  <div class="section-title">Efectivo en Caja</div>
  <div class="row indent"><span>Fondo de Apertura</span><span>${c(s.opening_fund_cents)}</span></div>
  ${s.cash_sales_cents != null ? `<div class="row indent"><span>+ Ventas Efectivo</span><span>${c(s.cash_sales_cents)}</span></div>` : ''}
  <div class="row indent"><span>+ Propinas Efectivo</span><span>${c(s.cash_tips_cents)}</span></div>
  <div class="row indent"><span>- Gastos Efectivo</span><span>-${c(s.cash_expenses_cents)}</span></div>
  <div class="row indent"><span>- Pago de Propinas</span><span>-${c(s.tip_payout_cents)}</span></div>
  <div class="total-row"><span>Efectivo Esperado</span><span>${c(s.expected_cash_cents)}</span></div>
  ${s.closing_cash_counted_cents != null ? `<div class="total-row"><span>Efectivo Contado</span><span>${c(s.closing_cash_counted_cents)}</span></div>` : ''}

  ${s.cash_over_short_cents != null ? `<div class="over-short">${overShortLabel}: ${sign(overShortAmt)}</div>` : ''}

  ${tipBlock}

  <div class="divider-solid"></div>
  <div class="footer">Impreso ${formatLocal(new Date())}</div>
</body></html>`

  openPrint(html)
}

export function printTipDistribution(summary: ReconSummary, sessionDate: string) {
  const td = summary.tip_distribution
  if (!td) return

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Reparto de Propinas</title>
<style>${SHARED_STYLE}
  .logo { width: 16mm; height: 16mm; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 1mm; }
</style></head><body>

  <div style="text-align:center">
    <img src="${venueLogo()}" class="logo" alt="${getVenue().name}" />
    <h1>${getVenue().name.toUpperCase()}</h1>
    <div class="sub">REPARTO DE PROPINAS</div>
    <div class="sub">${sessionDate}</div>
    <div class="sub">Impreso ${formatLocal(new Date())}</div>
  </div>

  <div class="divider-solid"></div>

  <div class="section-title">Total Propinas Recibidas</div>
  <div class="total-row"><span>TOTAL</span><span>${c(summary.total_tips_cents)}</span></div>

  <div class="divider"></div>
  <div class="section-title">Reparto</div>

  <div class="tip-role">
    <span>🏃 Piso / Meseros<br/><small style="font-weight:normal;font-size:8px">${td.floor_pct}% de propinas</small></span>
    <span class="amount">${c(td.floor_cents)}</span>
  </div>
  <div class="tip-role">
    <span>🍹 Barra + Gerente<br/><small style="font-weight:normal;font-size:8px">${td.bar_pct}% de propinas</small></span>
    <span class="amount">${c(td.bar_cents)}</span>
  </div>
  <div class="tip-role">
    <span>🍳 Cocina<br/><small style="font-weight:normal;font-size:8px">${td.kitchen_pct}% de propinas</small></span>
    <span class="amount">${c(td.kitchen_cents)}</span>
  </div>

  <div class="divider-solid"></div>
  <div class="footer">Firmar y confirmar con el gerente</div>
</body></html>`

  openPrint(html)
}

// ── Envelope slips (cash handoff count) ────────────────────────────────────
// Both slips go INSIDE the envelope that is dropped in the safe, so the next
// manager's opening count stays blind.

export interface SlipLine { key: string; qty: number }
export interface SlipMeta {
  /** Business date of the session, as shown on the other slips. */
  date: string
  /** Closing time, if known. */
  closedAt?: string
  /** Manager who closed. */
  manager?: string
}

const esc = (v: string) => v.replace(/[&<>"]/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))

/** Face value in cents from a denomination key: 'B500' -> 50000, 'C0.50' -> 50. */
function keyCents(key: string): number {
  const v = parseFloat(key.slice(1))
  return Number.isFinite(v) ? Math.round(v * 100) : 0
}

function slipLabel(cents: number): string {
  return cents % 100 === 0 ? c(cents).replace(/[.,]00(?=\D*$)/, '') : c(cents)
}

function slipBody(lines: SlipLine[], totalCents: number): string {
  const rows = [...lines]
    .filter(l => l.qty > 0)
    .sort((a, b) => keyCents(b.key) - keyCents(a.key))
    .map(l => {
      const cents = keyCents(l.key)
      const kind = l.key.startsWith('B') ? 'Billete' : 'Moneda'
      return `<div class="row"><span>${l.qty} × ${slipLabel(cents)} <small>${kind}</small></span><span>${c(l.qty * cents)}</span></div>`
    }).join('')
  return `${rows || '<div class="row indent"><span>Sin efectivo</span><span></span></div>'}
  <div class="total-row"><span>TOTAL</span><span>${c(totalCents)}</span></div>`
}

function slipMetaBlock(meta: SlipMeta): string {
  return `<div class="sub">${esc(meta.date)}${meta.closedAt ? ' · ' + esc(meta.closedAt) : ''}</div>
    ${meta.manager ? `<div class="sub">Gerente: ${esc(meta.manager)}</div>` : ''}`
}

/**
 * One print window with two slips separated by a cut line:
 * "SOBRE #N" (what goes to the safe) and "QUEDA EN CAJA" (what stays in the
 * drawer; also goes inside the envelope). Throws if the browser blocks the
 * window: the caller shows a toast and the close stays done.
 */
export function printEnvelopeSlips(
  envelope: { number: number; declared_cents: number; lines: SlipLine[] },
  drawerLeft: { total_cents: number; lines: SlipLine[] } | null | undefined,
  meta: SlipMeta,
) {
  const left = drawerLeft ? `
  <div class="cut">✂ - - - - - - - - - - - - - -</div>
  <div style="text-align:center">
    <h1>QUEDA EN CAJA</h1>
    <div class="sub">va dentro del sobre #${envelope.number}</div>
    ${slipMetaBlock(meta)}
  </div>
  <div class="divider-solid"></div>
  ${slipBody(drawerLeft.lines, drawerLeft.total_cents)}
  <div class="divider-solid"></div>` : ''

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Sobre #${envelope.number}</title>
<style>${SHARED_STYLE}
  .big { font-size: 26px; font-weight: 900; text-align: center; margin: 1mm 0; }
  .cut { text-align: center; font-size: 10px; margin: 5mm 0; letter-spacing: 1px; }
  small { font-size: 8px; font-weight: normal; }
</style></head><body>
  <div style="text-align:center">
    <h1>SOBRE</h1>
    <div class="big">#${envelope.number}</div>
    ${slipMetaBlock(meta)}
  </div>
  <div class="divider-solid"></div>
  ${slipBody(envelope.lines, envelope.declared_cents)}
  <div class="divider-solid"></div>
  ${left}
  <div class="footer">Impreso ${formatLocal(new Date())}</div>
</body></html>`

  if (!openPrint(html)) throw new Error('POPUP_BLOCKED')
}
