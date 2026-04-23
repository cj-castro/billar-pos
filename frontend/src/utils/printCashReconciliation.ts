import { LOGO_BASE64 } from './logoBase64'

export interface ReconSummary {
  opening_fund_cents: number
  total_sales_cents: number
  cash_sales_cents: number
  card_sales_cents: number
  total_tips_cents: number
  cash_tips_cents: number
  card_tips_cents: number
  total_expenses_cents: number
  cash_expenses_cents: number
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

function c(n: number) { return `$${((n ?? 0) / 100).toFixed(2)}` }
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

function openPrint(html: string) {
  const win = window.open('', '_blank', 'width=360,height=720')
  if (!win) return
  win.document.write(html)
  win.document.close()
  win.focus()
  win.onload = () => { win.print(); win.close() }
}

export function printCashReconciliation(summary: ReconSummary, sessionDate: string, closingTime?: string) {
  const s = summary
  const overShortAmt = s.cash_over_short_cents ?? 0
  const overShortLabel = overShortAmt >= 0 ? '▲ OVER' : '▼ SHORT'

  const expenseRows = s.expenses.map(e =>
    `<div class="row indent"><span>${e.payee} – ${e.description}</span><span>-${c(e.amount_cents)}</span></div>`
  ).join('')

  const tipBlock = s.tip_distribution ? `
    <div class="divider"></div>
    <div class="section-title">Tip Distribution</div>
    <div class="row indent"><span>🏃 Floor / Waiters (${s.tip_distribution.floor_pct}%)</span><span>${c(s.tip_distribution.floor_cents)}</span></div>
    <div class="row indent"><span>🍹 Bar + Manager (${s.tip_distribution.bar_pct}%)</span><span>${c(s.tip_distribution.bar_cents)}</span></div>
    <div class="row indent"><span>🍳 Kitchen (${s.tip_distribution.kitchen_pct}%)</span><span>${c(s.tip_distribution.kitchen_cents)}</span></div>
    <div class="total-row"><span>Total Tips</span><span>${c(s.total_tips_cents)}</span></div>
  ` : ''

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Cash Reconciliation</title>
<style>${SHARED_STYLE}
  .logo { width: 16mm; height: 16mm; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 1mm; }
</style></head><body>

  <div style="text-align:center">
    <img src="${LOGO_BASE64}" class="logo" alt="Bola 8" />
    <h1>CASH RECONCILIATION</h1>
    <div class="sub">${sessionDate}${closingTime ? ' · ' + closingTime : ''}</div>
    <div class="sub">${s.ticket_count} tickets closed</div>
  </div>

  <div class="divider-solid"></div>

  <div class="section-title">Starting Fund</div>
  <div class="row bold"><span>Opening Fund</span><span>${c(s.opening_fund_cents)}</span></div>

  <div class="divider"></div>
  <div class="section-title">Sales by Type</div>
  <div class="row indent"><span>💵 Cash</span><span>${c(s.cash_sales_cents)}</span></div>
  <div class="row indent"><span>💳 Card</span><span>${c(s.card_sales_cents)}</span></div>
  <div class="total-row"><span>Total Sales</span><span>${c(s.total_sales_cents)}</span></div>

  <div class="divider"></div>
  <div class="section-title">Tips</div>
  <div class="row indent"><span>💵 Cash Tips</span><span>${c(s.cash_tips_cents)}</span></div>
  <div class="row indent"><span>💳 Card Tips</span><span>${c(s.card_tips_cents)}</span></div>
  <div class="total-row"><span>Total Tips</span><span>${c(s.total_tips_cents)}</span></div>

  ${s.expenses.length > 0 ? `
  <div class="divider"></div>
  <div class="section-title">Expenses</div>
  ${expenseRows}
  <div class="total-row"><span>Total Expenses</span><span>-${c(s.total_expenses_cents)}</span></div>
  ` : ''}

  <div class="divider"></div>
  <div class="section-title">Cash on Register</div>
  <div class="row indent"><span>Opening Fund</span><span>${c(s.opening_fund_cents)}</span></div>
  <div class="row indent"><span>+ Cash Sales</span><span>${c(s.cash_sales_cents)}</span></div>
  <div class="row indent"><span>+ Cash Tips</span><span>${c(s.cash_tips_cents)}</span></div>
  <div class="row indent"><span>- Cash Expenses</span><span>-${c(s.cash_expenses_cents)}</span></div>
  <div class="total-row"><span>Expected Cash</span><span>${c(s.expected_cash_cents)}</span></div>
  ${s.closing_cash_counted_cents != null ? `<div class="total-row"><span>Actual Counted</span><span>${c(s.closing_cash_counted_cents)}</span></div>` : ''}

  ${s.cash_over_short_cents != null ? `<div class="over-short">${overShortLabel}: ${sign(overShortAmt)}</div>` : ''}

  ${tipBlock}

  <div class="divider-solid"></div>
  <div class="footer">Printed ${new Date().toLocaleString()}</div>
</body></html>`

  openPrint(html)
}

export function printTipDistribution(summary: ReconSummary, sessionDate: string) {
  const td = summary.tip_distribution
  if (!td) return

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Tip Distribution</title>
<style>${SHARED_STYLE}
  .logo { width: 16mm; height: 16mm; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 1mm; }
</style></head><body>

  <div style="text-align:center">
    <img src="${LOGO_BASE64}" class="logo" alt="Bola 8" />
    <h1>BOLA 8 POOL CLUB</h1>
    <div class="sub">TIP DISTRIBUTION</div>
    <div class="sub">${sessionDate}</div>
    <div class="sub">Printed ${new Date().toLocaleString()}</div>
  </div>

  <div class="divider-solid"></div>

  <div class="section-title">Total Tips Collected</div>
  <div class="total-row"><span>TOTAL</span><span>${c(summary.total_tips_cents)}</span></div>

  <div class="divider"></div>
  <div class="section-title">Distribution</div>

  <div class="tip-role">
    <span>🏃 Floor / Waiters<br/><small style="font-weight:normal;font-size:8px">${td.floor_pct}% of tips</small></span>
    <span class="amount">${c(td.floor_cents)}</span>
  </div>
  <div class="tip-role">
    <span>🍹 Bar + Manager<br/><small style="font-weight:normal;font-size:8px">${td.bar_pct}% of tips</small></span>
    <span class="amount">${c(td.bar_cents)}</span>
  </div>
  <div class="tip-role">
    <span>🍳 Kitchen<br/><small style="font-weight:normal;font-size:8px">${td.kitchen_pct}% of tips</small></span>
    <span class="amount">${c(td.kitchen_cents)}</span>
  </div>

  <div class="divider-solid"></div>
  <div class="footer">Please sign & confirm with manager</div>
</body></html>`

  openPrint(html)
}
