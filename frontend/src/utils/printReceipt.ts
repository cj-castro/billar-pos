import { LOGO_BASE64 } from './logoBase64'

export interface ReceiptTicket {
  id: string
  resource_code: string
  opened_at: string
  closed_at?: string
  payment_type: string
  line_items: Array<{
    menu_item_name: string
    quantity: number
    unit_price_cents: number
    status: string
    modifiers?: Array<{ name: string; price_cents: number }>
    notes?: string
  }>
  timer_sessions?: Array<{
    resource_code: string
    billing_mode: string
    duration_seconds: number
    charge_cents: number
    start_time?: string
    end_time?: string
    rate_cents?: number
  }>
  subtotal_cents: number
  discount_cents: number
  pool_time_cents: number
  total_cents: number
  tendered_cents?: number
  tip_cents?: number
  change_due?: number
  manual_discount_pct?: number
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function groupModifiers(modifiers: Array<{ name: string; price_cents: number }>) {
  const map = new Map<string, { name: string; count: number; price_cents: number }>()
  for (const m of modifiers) {
    const existing = map.get(m.name)
    if (existing) {
      existing.count++
    } else {
      map.set(m.name, { name: m.name, count: 1, price_cents: m.price_cents })
    }
  }
  return Array.from(map.values())
}

// Two-level grouping:
//   Level 1: same base product (name + price) → merged into one row with total qty
//   Level 2: within that row, each unique modifier combo is listed as a sub-line with its own count
//
// Example — 3 Micheladas ordered with different flavors:
//   Michelada   3x  $XX.XX
//     - 2x Clamato
//     - 1x Tamarindo
function groupLineItems(items: ReceiptTicket['line_items']) {
  type Variant = { modifiers: Array<{ name: string; price_cents: number }>; notes?: string; quantity: number }
  const map = new Map<string, {
    name: string
    quantity: number
    unit_price_cents: number
    variants: Variant[]
    status: string
  }>()

  for (const item of items) {
    const baseKey = `${item.menu_item_name}::${item.unit_price_cents}`
    const modKey   = (item.modifiers ?? []).map(m => m.name).sort().join('|')
    const variantKey = `${modKey}::${item.notes ?? ''}`

    const existing = map.get(baseKey)
    if (existing) {
      existing.quantity += item.quantity
      const v = existing.variants.find(v => {
        const vk = (v.modifiers ?? []).map(m => m.name).sort().join('|') + '::' + (v.notes ?? '')
        return vk === variantKey
      })
      if (v) { v.quantity += item.quantity } else { existing.variants.push({ modifiers: item.modifiers ?? [], notes: item.notes, quantity: item.quantity }) }
    } else {
      map.set(baseKey, {
        name: item.menu_item_name,
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        variants: [{ modifiers: item.modifiers ?? [], notes: item.notes, quantity: item.quantity }],
        status: item.status,
      })
    }
  }
  return Array.from(map.values())
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
}

export function printReceipt(ticket: ReceiptTicket, livePoolCents?: number, unpaid = false) {
  const items = ticket.line_items.filter((i) => i.status !== 'VOIDED')
  const groupedItems = groupLineItems(items)

  // Compute pool time — use live estimate for active (running) sessions
  const computedPoolCents = livePoolCents ?? (ticket.timer_sessions ?? []).reduce((sum, s) => {
    if (!s.end_time && s.start_time) {
      const secs = Math.max(0, (Date.now() - new Date(s.start_time).getTime()) / 1000)
      return sum + Math.floor(secs / 3600 * (s.rate_cents ?? 0))
    }
    return sum + (s.charge_cents ?? 0)
  }, 0)

  const itemRows = groupedItems.map((item) => {
    const multiVariant = item.variants.length > 1

    // lineTotal = sum across all variants of qty × (base + modifier prices)
    const lineTotal = multiVariant
      ? item.variants.reduce((sum, v) => {
          const modExtra = (v.modifiers ?? []).reduce((s, m) => s + (m.price_cents ?? 0), 0)
          return sum + v.quantity * (item.unit_price_cents + modExtra)
        }, 0)
      : (() => {
          const [v] = item.variants
          const modExtra = (v.modifiers ?? []).reduce((s, m) => s + (m.price_cents ?? 0), 0)
          return item.quantity * (item.unit_price_cents + modExtra)
        })()

    // Build sub-lines — modifier names only, NO price (price is rolled into lineTotal)
    const subLines = multiVariant
      ? item.variants.map((v) => {
          const modNames = (v.modifiers ?? []).map(m => m.name).filter(Boolean)
          const label = [...modNames, v.notes ? `(${v.notes})` : ''].filter(Boolean).join(', ') || 'sin modificadores'
          return `<div class="mod">&nbsp;&nbsp;${v.quantity}x <span style="text-transform:capitalize">${label}</span></div>`
        }).join('')
      : (() => {
          const [v] = item.variants
          const modLines = groupModifiers(v.modifiers ?? [])
            .map((m) => {
              const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name
              return `<div class="mod">&nbsp;&nbsp;+ ${label}</div>`  // price hidden — rolled into total
            }).join('')
          const noteLine = v.notes ? `<div class="mod">&nbsp;&nbsp;<em>${v.notes}</em></div>` : ''
          return modLines + noteLine
        })()

    return `
      <div class="item-row">
        <span class="item-name">${item.quantity}x ${item.name}</span>
        <span class="item-price">${fmt(lineTotal)}</span>
      </div>
      ${subLines}`
  }).join('')

  // Per-session rows — show live duration + charge for running sessions
  const timerRows = (ticket.timer_sessions ?? [])
    .filter((s) => s.charge_cents > 0 || (!s.end_time && s.start_time))
    .map((s) => {
      let charge = s.charge_cents
      let durSecs = s.duration_seconds
      if (!s.end_time && s.start_time) {
        durSecs = Math.max(0, Math.floor((Date.now() - new Date(s.start_time).getTime()) / 1000))
        charge = Math.floor(durSecs / 3600 * (s.rate_cents ?? 0))
      }
      return `
      <div class="item-row">
        <span class="item-name">🎱 Pool Time (${s.resource_code})<br>
          <small>${fmtDuration(durSecs)} · ${s.billing_mode}${!s.end_time ? ' · RUNNING' : ''}</small>
        </span>
        <span class="item-price">${fmt(charge)}</span>
      </div>`
    }).join('')

  const changeLine = (ticket.change_due ?? 0) > 0
    ? `<div class="total-row"><span>Change Due</span><span>${fmt(ticket.change_due!)}</span></div>`
    : ''

  const paymentLines = (() => {
    const t = ticket as any
    if (t.payment_type_2) {
      // Split payment
      const cashAmt = t.payment_type === 'CASH' ? (t.tendered_cents ?? 0) : (t.tendered_cents_2 ?? 0)
      const cardAmt = t.payment_type === 'CARD' ? (t.tendered_cents ?? 0) : (t.tendered_cents_2 ?? 0)
      return `
        <div class="total-row"><span>💵 Efectivo</span><span>${fmt(cashAmt)}</span></div>
        <div class="total-row"><span>💳 Tarjeta</span><span>${fmt(cardAmt)}</span></div>`
    }
    if (ticket.payment_type === 'CASH' && (ticket.tendered_cents ?? 0) > 0) {
      return `<div class="total-row"><span>Tendered</span><span>${fmt(ticket.tendered_cents!)}</span></div>`
    }
    return ''
  })()

  const liveTotal = ticket.subtotal_cents + computedPoolCents - (ticket.discount_cents ?? 0)
  const tipCents = ticket.tip_cents ?? 0
  const grandTotal = liveTotal + tipCents
  const tipLine = tipCents > 0
    ? `<div class="total-row"><span>Tip</span><span>${fmt(tipCents)}</span></div>
       <div class="total-row grand"><span>TOTAL + TIP</span><span>${fmt(grandTotal)}</span></div>`
    : ''

  // Tip suggestion table for unpaid receipts
  const tipSuggestions = unpaid
    ? [10, 15, 18, 20].map(pct => {
        const tipAmt = Math.round(liveTotal * pct / 100)
        return `<tr>
          <td>${pct}%</td>
          <td class="amt">${fmt(tipAmt)}</td>
          <td class="amt tip-total">${fmt(liveTotal + tipAmt)}</td>
        </tr>`
      }).join('')
    : ''

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt #${ticket.id.slice(-6).toUpperCase()}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: 48mm auto; margin: 1mm; }
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 11px;
      font-weight: bold;
      width: 46mm;
      color: #000;
      padding: 1mm;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .center { text-align: center; }
    .logo { width: 16mm; height: 16mm; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 2mm; }
    .venue-name { font-size: 14px; font-weight: 900; letter-spacing: 1px; }
    .venue-sub { font-size: 10px; font-weight: bold; color: #000; margin-top: 1mm; }
    .divider { border-top: 1.5px dashed #000; margin: 2mm 0; }
    .divider-solid { border-top: 2px solid #000; margin: 2mm 0; }
    .meta { font-size: 10px; font-weight: bold; margin-bottom: 1mm; }
    .meta span { font-weight: 900; }
    .section-title { font-size: 10px; text-transform: uppercase; font-weight: 900; margin-bottom: 1mm; }
    .item-row { display: flex; justify-content: space-between; margin-bottom: 1.5mm; font-weight: bold; }
    .item-name { flex: 1; padding-right: 2mm; }
    .item-price { white-space: nowrap; font-weight: 900; }
    .mod { font-size: 10px; font-weight: bold; color: #000; margin-bottom: 0.5mm; }
    .total-row { display: flex; justify-content: space-between; margin-bottom: 1mm; font-size: 11px; font-weight: bold; }
    .total-row.grand { font-size: 14px; font-weight: 900; margin-top: 1mm; }
    .footer { text-align: center; font-size: 10px; font-weight: bold; color: #000; margin-top: 3mm; }
    .ticket-num { font-size: 13px; font-weight: 900; letter-spacing: 2px; }
    .payment-badge { display: inline-block; border: 2px solid #000; padding: 0.5mm 2mm; font-weight: 900; font-size: 11px; margin-top: 1mm; }
    .unpaid-notice { text-align: center; font-size: 13px; font-weight: 900; border: 3px solid #000; padding: 2mm; margin-top: 3mm; letter-spacing: 0.5px; }
    .tip-table { width: 100%; border-collapse: collapse; margin-top: 2mm; font-size: 11px; }
    .tip-table th { font-size: 10px; font-weight: 900; text-align: center; padding: 0.5mm 1mm; border-bottom: 2px solid #000; }
    .tip-table td { text-align: center; padding: 1mm; border-bottom: 1px solid #888; font-weight: bold; }
    .tip-table td.amt { font-weight: 900; font-size: 12px; }
    .tip-total { font-size: 11px; font-weight: 900; }
  </style>
</head>
<body>
  <div class="center">
    <img src="${LOGO_BASE64}" class="logo" alt="Bola 8" />
    <div class="venue-name">BOLA 8 POOL CLUB</div>
    <div class="venue-sub">Pool · Food · Drinks</div>
    <div class="divider"></div>
    <div class="ticket-num">#${ticket.id.slice(-6).toUpperCase()}</div>
  </div>

  <div class="divider"></div>

  <div class="meta">Table: <span>${ticket.resource_code}</span></div>
  <div class="meta">Date: <span>${fmtDate(ticket.closed_at || ticket.opened_at)}</span></div>

  <div class="divider"></div>
  <div class="section-title">Items</div>

  ${itemRows}
  ${timerRows ? `<div class="divider"></div>${timerRows}` : ''}

  <div class="divider-solid"></div>

  <div class="total-row"><span>Subtotal</span><span>${fmt(ticket.subtotal_cents)}</span></div>
  ${ticket.discount_cents > 0 ? `<div class="total-row" style="color:#4ade80"><span>Discount${ticket.manual_discount_pct ? ` (${ticket.manual_discount_pct}%)` : ''}</span><span>-${fmt(ticket.discount_cents)}</span></div>` : ''}
  ${computedPoolCents > 0 ? `<div class="total-row"><span>Pool Time</span><span>${fmt(computedPoolCents)}</span></div>` : ''}
  <div class="total-row grand"><span>TOTAL</span><span>${fmt(liveTotal)}</span></div>
  ${tipLine}

  <div class="divider"></div>

  ${unpaid ? `
  <div class="divider"></div>
  <div class="section-title" style="text-align:center">Sugerencia de Propina</div>
  <table class="tip-table">
    <thead><tr><th>%</th><th>Propina</th><th>Total</th></tr></thead>
    <tbody>${tipSuggestions}</tbody>
  </table>
  <div class="divider"></div>
  <div class="unpaid-notice">⚠ CUENTA NO PAGADA ⚠</div>
  ` : `
  ${paymentLines}
  ${changeLine}
  <div class="center">
    <div class="payment-badge">${ticket.payment_type}</div>
  </div>
  `}

  <div class="divider"></div>

  <div class="footer">
    Thank you for visiting!<br>
    Come back soon 🎱
  </div>
</body>
</html>`

  const win = window.open('', '_blank', 'width=360,height=720')
  if (!win) { alert('Please allow pop-ups to print receipts.'); return }
  win.document.write(html)
  win.document.close()
  win.focus()
  win.onload = () => { win.print(); win.close() }
}
