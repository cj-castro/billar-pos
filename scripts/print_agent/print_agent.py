"""
Bola 8 Print Agent — runs on the Windows host (outside Docker).
Listens on port 9191, accepts JSON receipt data, prints ESC/POS to USB thermal printer.

Requirements: pip install flask pywin32
Run: python print_agent.py
"""
import sys
import os
import logging
import struct
import tempfile
import time
from collections import Counter
from datetime import datetime
from typing import Optional
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Configuration
#   PRINTER_NAME         — default printer (receipts, bar chits, reprints)
#                          Leave blank to auto-detect.
#   KITCHEN_PRINTER_NAME — printer for kitchen chits only
#                          Leave blank to fall back to PRINTER_NAME.
#   PRINT_PORT           — HTTP port (default 9191)
# ---------------------------------------------------------------------------
PRINTER_NAME         = os.environ.get('PRINTER_NAME', '')          # e.g. "La Barra"
KITCHEN_PRINTER_NAME = os.environ.get('KITCHEN_PRINTER_NAME', '')  # e.g. "Cocina Comandas"
PORT = int(os.environ.get('PRINT_PORT', 9191))
CHARS = 32          # POS-58 characters per line (normal font)

# ---------------------------------------------------------------------------
# Idempotency: track recently-printed job_ids to avoid duplicate prints.
# TTL of 60 s covers accidental double-taps and mobile retry storms.
# ---------------------------------------------------------------------------
_DEDUP_TTL = 60.0   # seconds
_printed_jobs: dict[str, float] = {}   # job_id → unix timestamp

def _dedup_check(job_id: Optional[str]) -> bool:
    """Return True if job_id was already printed within the TTL window."""
    if not job_id:
        return False
    now = time.time()
    # Evict stale entries to keep the dict small
    stale = [k for k, ts in _printed_jobs.items() if now - ts > _DEDUP_TTL]
    for k in stale:
        del _printed_jobs[k]
    return job_id in _printed_jobs

def _dedup_record(job_id: Optional[str]):
    if job_id:
        _printed_jobs[job_id] = time.time()

# ---------------------------------------------------------------------------
# ESC/POS helpers
# ---------------------------------------------------------------------------
ESC = b'\x1b'
GS  = b'\x1d'
LF  = b'\n'

def cmd_init():         return ESC + b'@'
def cmd_align(a):       return ESC + b'a' + bytes([a])   # 0=L 1=C 2=R
def cmd_bold(on):       return ESC + b'E' + bytes([1 if on else 0])
def cmd_double(on):     return ESC + b'!' + bytes([0x30 if on else 0x00])  # 2x height+width
def cmd_codepage():     return ESC + b't\x02'            # CP850 — covers Spanish chars
def cmd_feed(n=1):      return ESC + b'd' + bytes([n])
def cmd_cut():          return GS + b'V\x41\x03'         # partial cut + 3-line feed

def enc(text):
    """Encode text to CP850, replacing unknown chars with '?'."""
    return text.encode('cp850', errors='replace')

def divider(char='-'):
    return enc(char * CHARS) + LF

def two_col(left, right, width=CHARS):
    right = str(right)
    left  = str(left)
    left  = left[: width - len(right) - 1]
    spaces = width - len(left) - len(right)
    return enc(left + ' ' * max(1, spaces) + right) + LF

def center_line(text, width=CHARS):
    return enc(text.center(width)[:width]) + LF

def left_line(text, width=CHARS):
    return enc(text[:width].ljust(width)) + LF

def wrap_lines(text, width=CHARS, indent=''):
    """Split text at ', ' boundaries to fit width; continuation lines use indent."""
    words = text.split(', ')
    current = ''
    lines = []
    for word in words:
        candidate = current + (', ' if current else '') + word
        if len(candidate) > width and current:
            lines.append(enc(current[:width]) + LF)
            current = indent + word
        else:
            current = candidate
    if current:
        lines.append(enc(current[:width]) + LF)
    return b''.join(lines) if lines else enc(text[:width]) + LF

def _get_logo_b64() -> str:
    """Load logo base64 from the frontend source file."""
    try:
        import re, os
        logo_path = os.path.join(os.path.dirname(__file__),
                                 '..', '..', 'frontend', 'src', 'utils', 'logoBase64.ts')
        content = open(os.path.normpath(logo_path)).read()
        m = re.search(r"LOGO_BASE64 = '(data:[^']+)'", content)
        if m:
            return m.group(1)
    except Exception:
        pass
    return ''


def _group_modifiers(mods: list) -> list:
    seen: dict = {}
    for m in mods:
        n = m.get('name', '')
        if n:
            seen[n] = seen.get(n, 0) + 1
    return [{'name': n, 'count': c} for n, c in seen.items()]


def _group_line_items(items: list) -> list:
    grouped: dict = {}
    for item in items:
        base_key = f"{item.get('menu_item_name')}::{item.get('unit_price_cents', 0)}"
        mod_key  = '|'.join(sorted(m.get('name', '') for m in (item.get('modifiers') or [])))
        var_key  = f"{mod_key}::{item.get('notes') or ''}"
        if base_key not in grouped:
            grouped[base_key] = {
                'name': item.get('menu_item_name') or 'Item',
                'quantity': 0,
                'unit_price_cents': item.get('unit_price_cents', 0),
                'variants': {},
                'status': item.get('status', ''),
            }
        g = grouped[base_key]
        g['quantity'] += item.get('quantity', 1)
        if var_key not in g['variants']:
            g['variants'][var_key] = {
                'modifiers': item.get('modifiers') or [],
                'notes': item.get('notes') or '',
                'quantity': 0,
            }
        g['variants'][var_key]['quantity'] += item.get('quantity', 1)
    # flatten variants dict → list
    for g in grouped.values():
        g['variants'] = list(g['variants'].values())
    return list(grouped.values())


def format_receipt_html(data: dict, unpaid: bool = False, reprint: bool = False) -> str:
    """Generate the same styled HTML receipt as the frontend printReceipt.ts."""
    import html as _html

    logo = _get_logo_b64()
    ticket_id = (data.get('id') or '')[-6:].upper()
    resource  = data.get('resource_code') or ''
    date_str  = fmt_date(data.get('closed_at') or data.get('opened_at') or '')

    items = [i for i in (data.get('line_items') or []) if i.get('status') != 'VOIDED']
    grouped = _group_line_items(items)

    item_rows_html = ''
    for g in grouped:
        variants = g['variants']
        multi = len(variants) > 1
        base_price = g['unit_price_cents']
        line_total = sum(
            v['quantity'] * (base_price + sum(m.get('price_cents', 0) for m in v['modifiers']))
            for v in variants
        )
        name_esc = _html.escape(g['name'])
        item_rows_html += f'''
      <div class="item-row">
        <span class="item-name">{g["quantity"]}x {name_esc}</span>
        <span class="item-price">{fmt_cents(line_total)}</span>
      </div>'''
        if multi:
            for v in variants:
                mod_names = [m.get('name', '') for m in v['modifiers'] if m.get('name', '')]
                label = ', '.join(mod_names) or 'sin modificadores'
                if v['notes']:
                    label += f' ({v["notes"]})'
                item_rows_html += f'<div class="mod">&nbsp;&nbsp;{v["quantity"]}x {_html.escape(label)}</div>'
        else:
            v = variants[0]
            for mc in _group_modifiers(v['modifiers']):
                label = f'{mc["name"]} ×{mc["count"]}' if mc['count'] > 1 else mc['name']
                item_rows_html += f'<div class="mod">&nbsp;&nbsp;+ {_html.escape(label)}</div>'
            if v['notes']:
                item_rows_html += f'<div class="mod">&nbsp;&nbsp;<em>{_html.escape(v["notes"])}</em></div>'

    # Timer sessions
    timer_rows_html = ''
    timer_sessions = [s for s in (data.get('timer_sessions') or [])
                      if (s.get('charge_cents') or 0) > 0 or (not s.get('end_time') and s.get('start_time'))]
    for s in timer_sessions:
        charge = s.get('charge_cents', 0)
        dur    = s.get('duration_seconds', 0)
        mode   = (s.get('billing_mode') or '').replace('_', ' ')
        rc     = s.get('resource_code') or ''
        live   = '' if s.get('end_time') else ' · RUNNING'
        timer_rows_html += f'''
      <div class="item-row">
        <span class="item-name">🎱 Pool Time ({_html.escape(rc)})<br>
          <small>{fmt_dur(dur)} · {_html.escape(mode)}{live}</small>
        </span>
        <span class="item-price">{fmt_cents(charge)}</span>
      </div>'''

    sub       = data.get('subtotal_cents', 0)
    disc      = data.get('discount_cents', 0) or 0
    disc_pct  = data.get('manual_discount_pct', 0) or 0
    pool_c    = data.get('pool_time_cents', 0) or 0
    tip       = data.get('tip_cents', 0) or 0
    live_total = sub + pool_c - disc
    grand_total = live_total + tip

    disc_line = ''
    if disc > 0:
        pct_str = f' ({disc_pct}%)' if disc_pct else ''
        disc_line = f'<div class="total-row" style="color:#16a34a"><span>Discount{pct_str}</span><span>-{fmt_cents(disc)}</span></div>'
    pool_line = f'<div class="total-row"><span>Pool Time</span><span>{fmt_cents(pool_c)}</span></div>' if pool_c > 0 else ''
    tip_line  = ''
    if tip > 0:
        tip_line = f'''<div class="total-row"><span>Tip</span><span>{fmt_cents(tip)}</span></div>
      <div class="total-row grand"><span>TOTAL + TIP</span><span>{fmt_cents(grand_total)}</span></div>'''

    # Payment section or unpaid notice
    if unpaid:
        tip_rows = ''.join(
            f'<tr><td>{p}%</td><td class="amt">{fmt_cents(round(live_total*p/100))}</td>'
            f'<td class="amt">{fmt_cents(live_total + round(live_total*p/100))}</td></tr>'
            for p in [10, 15, 18, 20]
        )
        payment_section = f'''
      <div class="divider"></div>
      <div class="section-title" style="text-align:center">Sugerencia de Propina</div>
      <table class="tip-table">
        <thead><tr><th>%</th><th>Propina</th><th>Total</th></tr></thead>
        <tbody>{tip_rows}</tbody>
      </table>
      <div class="divider"></div>
      <div class="unpaid-notice">⚠ CUENTA NO PAGADA ⚠</div>'''
    else:
        pt  = data.get('payment_type') or ''
        pt2 = data.get('payment_type_2') or None
        tc  = data.get('tendered_cents') or 0
        tc2 = data.get('tendered_cents_2') or 0
        chg = data.get('change_due') or max(0, tc - live_total)
        if pt2:
            cash = tc  if pt  == 'CASH' else tc2
            card = tc2 if pt  == 'CASH' else tc
            pay_lines = (f'<div class="total-row"><span>💵 Efectivo</span><span>{fmt_cents(cash)}</span></div>'
                         f'<div class="total-row"><span>💳 Tarjeta</span><span>{fmt_cents(card)}</span></div>')
        elif pt == 'CASH' and tc > 0:
            chg_line = f'<div class="total-row"><span>Cambio</span><span>{fmt_cents(chg)}</span></div>' if chg > 0 else ''
            pay_lines = f'<div class="total-row"><span>Recibido</span><span>{fmt_cents(tc)}</span></div>{chg_line}'
        elif pt == 'EXTERNAL':
            pay_lines = '<div class="total-row"><span>Pagado externamente</span><span>✓</span></div>'
        else:
            pay_lines = ''
        badge = _html.escape(pt) if pt else '—'
        payment_section = f'''
      {pay_lines}
      <div class="center"><div class="payment-badge">{badge}</div></div>'''

    logo_img = f'<img src="{logo}" class="logo" alt="Bola 8" />' if logo else ''

    return f'''<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt #{ticket_id}</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    @page {{ size: 48mm auto; margin: 1mm; }}
    body {{
      font-family: 'Courier New', Courier, monospace;
      font-size: 11px;
      font-weight: bold;
      width: 46mm;
      color: #000;
      padding: 1mm;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }}
    .center {{ text-align: center; }}
    .logo {{ width: 16mm; height: 16mm; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 2mm; }}
    .venue-name {{ font-size: 14px; font-weight: 900; letter-spacing: 1px; }}
    .venue-sub {{ font-size: 10px; font-weight: bold; color: #000; margin-top: 1mm; }}
    .divider {{ border-top: 1.5px dashed #000; margin: 2mm 0; }}
    .divider-solid {{ border-top: 2px solid #000; margin: 2mm 0; }}
    .meta {{ font-size: 10px; font-weight: bold; margin-bottom: 1mm; }}
    .meta span {{ font-weight: 900; }}
    .section-title {{ font-size: 10px; text-transform: uppercase; font-weight: 900; margin-bottom: 1mm; }}
    .item-row {{ display: flex; justify-content: space-between; margin-bottom: 1.5mm; font-weight: bold; }}
    .item-name {{ flex: 1; padding-right: 2mm; }}
    .item-price {{ white-space: nowrap; font-weight: 900; }}
    .mod {{ font-size: 10px; font-weight: bold; color: #000; margin-bottom: 0.5mm; }}
    .total-row {{ display: flex; justify-content: space-between; margin-bottom: 1mm; font-size: 11px; font-weight: bold; }}
    .total-row.grand {{ font-size: 14px; font-weight: 900; margin-top: 1mm; }}
    .footer {{ text-align: center; font-size: 10px; font-weight: bold; color: #000; margin-top: 3mm; }}
    .ticket-num {{ font-size: 13px; font-weight: 900; letter-spacing: 2px; }}
    .payment-badge {{ display: inline-block; border: 2px solid #000; padding: 0.5mm 2mm; font-weight: 900; font-size: 11px; margin-top: 1mm; }}
    .unpaid-notice {{ text-align: center; font-size: 13px; font-weight: 900; border: 3px solid #000; padding: 2mm; margin-top: 3mm; letter-spacing: 0.5px; }}
    .tip-table {{ width: 100%; border-collapse: collapse; margin-top: 2mm; font-size: 11px; }}
    .tip-table th {{ font-size: 10px; font-weight: 900; text-align: center; padding: 0.5mm 1mm; border-bottom: 2px solid #000; }}
    .tip-table td {{ text-align: center; padding: 1mm; border-bottom: 1px solid #888; font-weight: bold; }}
    .tip-table td.amt {{ font-weight: 900; font-size: 12px; }}
    .reprint-banner {{ text-align: center; font-size: 11px; font-weight: 900; border: 2px dashed #000; padding: 1mm 2mm; margin-bottom: 2mm; letter-spacing: 0.5px; }}
  </style>
</head>
<body>
  {f'<div class="reprint-banner">★ REIMPRESIÓN ★<br><span style="font-size:9px;font-weight:bold">{datetime.now().strftime("%d/%m/%Y %H:%M")}</span></div>' if reprint else ''}
  <div class="center">
    {logo_img}
    <div class="venue-name">BOLA 8 POOL CLUB</div>
    <div class="venue-sub">Pool · Food · Drinks</div>
    <div class="divider"></div>
    <div class="ticket-num">#{ticket_id}</div>
  </div>
  <div class="divider"></div>
  <div class="meta">Table: <span>{_html.escape(resource)}</span></div>
  <div class="meta">Date: <span>{_html.escape(date_str)}</span></div>
  <div class="divider"></div>
  <div class="section-title">Items</div>
  {item_rows_html}
  {'<div class="divider"></div>' + timer_rows_html if timer_rows_html else ''}
  <div class="divider-solid"></div>
  <div class="total-row"><span>Subtotal</span><span>{fmt_cents(sub)}</span></div>
  {disc_line}
  {pool_line}
  <div class="total-row grand"><span>TOTAL</span><span>{fmt_cents(live_total)}</span></div>
  {tip_line}
  <div class="divider"></div>
  {payment_section}
  <div class="divider"></div>
  <div class="footer">Thank you for visiting!<br>Come back soon 🎱</div>
</body>
</html>'''


def print_html_dev(data: dict, unpaid: bool = False) -> bool:
    """Mac/Linux dev fallback: render receipt as HTML and open in browser."""
    try:
        html = format_receipt_html(data, unpaid=unpaid)
        path = tempfile.mktemp(suffix='_receipt.html')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(html)
        log.info(f'Dev mode: receipt HTML saved to {path}')
        import subprocess, sys
        if sys.platform == 'darwin':
            subprocess.Popen(['open', path])
        elif sys.platform.startswith('linux'):
            subprocess.Popen(['xdg-open', path])
        return True
    except Exception as e:
        log.error(f'HTML render error: {e}')
        return False


def format_receipt_escpos(data: dict, unpaid: bool = False, reprint: bool = False) -> bytes:
    """Format a full receipt as ESC/POS bytes for direct thermal printing."""
    ticket_id   = (data.get('id') or '')[-6:].upper()
    resource    = data.get('resource_code') or ''
    date_str    = fmt_date(data.get('closed_at') or data.get('opened_at') or '')

    items   = [i for i in (data.get('line_items') or []) if i.get('status') != 'VOIDED']
    grouped = _group_line_items(items)

    sub        = data.get('subtotal_cents', 0) or 0
    disc       = data.get('discount_cents', 0) or 0
    disc_pct   = data.get('manual_discount_pct', 0) or 0
    pool_c     = data.get('pool_time_cents', 0) or 0
    tip        = data.get('tip_cents', 0) or 0
    live_total = sub + pool_c - disc
    grand_total = live_total + tip

    raw = bytearray()
    raw += cmd_init()
    raw += cmd_codepage()

    # ── Header ──────────────────────────────────────────────────────────────
    raw += cmd_align(1)
    raw += cmd_bold(True)
    raw += cmd_double(True)
    raw += enc('BOLA 8') + LF
    raw += cmd_double(False)
    raw += cmd_bold(False)
    if reprint:
        raw += enc('--- REIMPRESION ---') + LF
    if unpaid:
        raw += cmd_bold(True)
        raw += enc('** CUENTA **') + LF
        raw += cmd_bold(False)
    raw += divider('=')
    raw += cmd_align(0)

    # ── Ticket info ──────────────────────────────────────────────────────────
    if resource:
        raw += two_col(f'Ticket: #{ticket_id}', f'Mesa: {resource}')
    else:
        raw += left_line(f'Ticket: #{ticket_id}')
    raw += left_line(f'Fecha:  {date_str}')
    raw += divider()

    # ── Line items ───────────────────────────────────────────────────────────
    for g in grouped:
        variants   = g['variants']
        base_price = g['unit_price_cents']
        line_total = sum(
            v['quantity'] * (base_price + sum(m.get('price_cents', 0) for m in v['modifiers']))
            for v in variants
        )
        raw += two_col(f'{g["quantity"]}x {g["name"]}', fmt_cents(line_total))
        multi = len(variants) > 1
        for v in variants:
            mod_names = [m.get('name', '') for m in v['modifiers'] if m.get('name', '')]
            label = ', '.join(mod_names)
            if v.get('notes'):
                label = (label + ' ' if label else '') + f'({v["notes"]})'
            if label:
                prefix = f'  {v["quantity"]}x ' if multi else '  + '
                raw += wrap_lines(prefix + label, CHARS, '    ')

    # ── Timer sessions ───────────────────────────────────────────────────────
    timer_sessions = [s for s in (data.get('timer_sessions') or [])
                      if (s.get('charge_cents') or 0) > 0 or (not s.get('end_time') and s.get('start_time'))]
    for s in timer_sessions:
        charge = s.get('charge_cents', 0) or 0
        dur    = s.get('duration_seconds', 0) or 0
        mode   = (s.get('billing_mode') or '').replace('_', ' ')
        rc     = s.get('resource_code') or ''
        live   = ' ACTIVO' if not s.get('end_time') else ''
        rc_lbl = f'({rc}) ' if rc else ''
        raw += two_col(f'Pool {rc_lbl}{fmt_dur(dur)}', fmt_cents(charge))
        if mode or live:
            raw += left_line(f'  {mode}{live}')

    # ── Totals ───────────────────────────────────────────────────────────────
    raw += divider()
    if sub > 0:
        raw += two_col('Subtotal:', fmt_cents(sub))
    if disc > 0:
        pct_str = f' ({disc_pct}%)' if disc_pct else ''
        raw += two_col(f'Descuento{pct_str}:', f'-{fmt_cents(disc)}')
    if pool_c > 0:
        raw += two_col('Pool Time:', fmt_cents(pool_c))
    if tip > 0:
        raw += two_col('Propina:', fmt_cents(tip))
    raw += divider('=')
    raw += cmd_bold(True)
    raw += two_col('TOTAL:', fmt_cents(grand_total))
    raw += cmd_bold(False)
    raw += divider('=')

    # ── Payment / unpaid ─────────────────────────────────────────────────────
    if unpaid:
        raw += cmd_align(1)
        raw += enc('- Sugerencia de Propina -') + LF
        raw += cmd_align(0)
        for p in [10, 15, 18, 20]:
            tip_amt = round(live_total * p / 100)
            raw += two_col(f'  {p}%  {fmt_cents(tip_amt)}', fmt_cents(live_total + tip_amt))
        raw += divider()
        raw += cmd_align(1)
        raw += cmd_bold(True)
        raw += enc('** CUENTA NO PAGADA **') + LF
        raw += cmd_bold(False)
        raw += cmd_align(0)
    else:
        pt  = data.get('payment_type') or ''
        pt2 = data.get('payment_type_2') or None
        tc  = data.get('tendered_cents') or 0
        tc2 = data.get('tendered_cents_2') or 0
        chg = data.get('change_due') or max(0, tc - live_total)
        if pt2:
            cash = tc  if pt == 'CASH' else tc2
            card = tc2 if pt == 'CASH' else tc
            raw += two_col('Efectivo:', fmt_cents(cash))
            raw += two_col('Tarjeta:', fmt_cents(card))
        elif pt == 'CASH' and tc > 0:
            raw += two_col('Recibido:', fmt_cents(tc))
            if chg > 0:
                raw += two_col('Cambio:', fmt_cents(chg))
        elif pt == 'EXTERNAL':
            raw += left_line('Pagado externamente')
        if pt:
            raw += cmd_align(1)
            raw += cmd_bold(True)
            raw += enc(f'[ {pt} ]') + LF
            raw += cmd_bold(False)
            raw += cmd_align(0)

    # ── Footer ───────────────────────────────────────────────────────────────
    raw += divider()
    raw += cmd_align(1)
    raw += enc('Gracias por su visita!') + LF
    raw += cmd_align(0)
    raw += cmd_feed(3)
    raw += cmd_cut()
    return bytes(raw)


def print_receipt_html(data: dict, unpaid: bool = False, reprint: bool = False, kind: str = 'receipt') -> bool:
    """Print receipt. On Windows uses ESC/POS via win32print (same as KDS chits).
    On Mac/Linux falls back to HTML browser preview (dev mode)."""
    if sys.platform != 'win32':
        return print_html_dev(data, unpaid=unpaid)
    raw = format_receipt_escpos(data, unpaid=unpaid, reprint=reprint)
    return print_raw(raw, data=data, unpaid=unpaid, kind=kind)


def fmt_cents(cents):
    return f'${cents/100:.2f}'

def fmt_dur(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    return f'{h}h {m}m' if h else f'{m}m'

def fmt_date(iso):
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        return dt.strftime('%d %b %Y  %I:%M %p')
    except Exception:
        return iso[:16] if iso else ''

# ---------------------------------------------------------------------------
# Receipt formatter
# ---------------------------------------------------------------------------
def format_receipt(data: dict, unpaid: bool = False, reprint: bool = False) -> bytes:
    buf = bytearray()

    buf += cmd_init()
    buf += cmd_codepage()

    # ---- Reprint banner (shown before main header) ----
    if reprint:
        buf += cmd_align(1)
        buf += cmd_bold(True)
        buf += enc('*** REIMPRESION ***') + LF
        buf += cmd_bold(False)
        buf += enc(datetime.now().strftime('%d/%m/%Y %H:%M')) + LF
        buf += divider('=')

    # ---- Header ----
    buf += cmd_align(1)
    buf += cmd_double(True)
    buf += enc('BOLA 8') + LF
    buf += cmd_double(False)
    buf += enc('POOL CLUB') + LF
    buf += enc('Pool * Food * Drinks') + LF
    buf += cmd_align(0)
    buf += divider()

    ticket_id  = (data.get('id') or '')[-6:].upper()
    resource   = data.get('resource_code') or ''
    opened_at  = data.get('opened_at') or ''
    closed_at  = data.get('closed_at') or ''

    buf += cmd_bold(True)
    buf += left_line(f'Ticket: #{ticket_id}')
    buf += cmd_bold(False)
    buf += left_line(f'Mesa:   {resource}')
    buf += left_line(f'Fecha:  {fmt_date(closed_at or opened_at)}')
    buf += divider()

    # ---- Items: two-level grouping ----
    # Level 1: same base product (name + price) → merged row with total qty
    # Level 2: within that row, each modifier/flavor combo is a sub-line
    # Example: 3 Micheladas → "3x Michelada  $XX" then "  2x Clamato / 1x Tamarindo"
    line_items = [i for i in (data.get('line_items') or []) if i.get('status') != 'VOIDED']
    if line_items:
        base_groups = {}  # key=(name,price) → {qty, variants:[{mods,notes,qty}]}
        for item in line_items:
            name  = item.get('menu_item_name') or item.get('item_name') or 'Item'
            price = item.get('unit_price_cents', 0)
            mods  = item.get('modifiers') or []
            notes = item.get('notes') or ''
            mod_key = '|'.join(sorted(m.get('name', '') for m in mods))
            var_key = f'{mod_key}::{notes}'
            base_key = (name, price)
            if base_key not in base_groups:
                base_groups[base_key] = {'name': name, 'price': price, 'qty': 0, 'variants': {}}
            bg = base_groups[base_key]
            bg['qty'] += item.get('quantity', 1)
            if var_key not in bg['variants']:
                bg['variants'][var_key] = {'mods': mods, 'notes': notes, 'qty': 0}
            bg['variants'][var_key]['qty'] += item.get('quantity', 1)

        buf += cmd_bold(True)
        buf += left_line('CONSUMO')
        buf += cmd_bold(False)
        for bg in base_groups.values():
            base_price = bg['price']
            variants = list(bg['variants'].values())
            multi = len(variants) > 1
            # total = sum of each variant's qty × (base + modifier prices)
            total = sum(
                v['qty'] * (base_price + sum(m.get('price_cents', 0) for m in v['mods']))
                for v in variants
            )
            buf += two_col(f'{bg["qty"]}x {bg["name"]}', fmt_cents(total))
            if multi:
                # Show each flavor/variant as a sub-line; compact repeated modifier names
                for v in variants:
                    mod_counts = Counter(m.get('name', '') for m in v['mods'] if m.get('name', ''))
                    parts = [f'{cnt}x {name}' if cnt > 1 else name
                             for name, cnt in mod_counts.items()]
                    if v['notes']:
                        parts.append(f'({v["notes"]})')
                    prefix = f'  {v["qty"]}x ' if bg['qty'] > 1 else '  '
                    label = ', '.join(parts) or 'sin modificadores'
                    buf += wrap_lines(f'{prefix}{label}', indent=' ' * len(prefix))
            else:
                # Single variant: show modifier names only, NO price (rolled into total above)
                v = variants[0]
                mod_counts = {}
                for mod in v['mods']:
                    mname = mod.get('name', '')
                    if mname:
                        mod_counts[mname] = mod_counts.get(mname, 0) + 1
                for mname, cnt in mod_counts.items():
                    label_m = f'  + {mname}' + (f' x{cnt}' if cnt > 1 else '')
                    buf += left_line(label_m)  # no price column — price is in the total
                if v['notes']:
                    buf += left_line(f'  * {v["notes"]}')

    # ---- Pool time ----
    timer_sessions = [s for s in (data.get('timer_sessions') or [])
                      if (s.get('charge_cents') or 0) > 0 or (not s.get('end_time') and s.get('start_time'))]
    if timer_sessions:
        buf += divider()
        buf += cmd_bold(True)
        buf += left_line('TIEMPO DE POOL')
        buf += cmd_bold(False)
        for s in timer_sessions:
            charge    = s.get('charge_cents', 0)
            dur_secs  = s.get('duration_seconds', 0)
            mode      = (s.get('billing_mode') or '').replace('_', ' ')
            resource  = s.get('resource_code') or ''
            # Live session
            if not s.get('end_time') and s.get('start_time'):
                import time as _t
                start = datetime.fromisoformat(s['start_time'].replace('Z', '+00:00'))
                dur_secs = max(0, int((_t.time() - start.timestamp())))
                rate = s.get('rate_cents', 0)
                charge = int(dur_secs / 3600 * rate)
            label = f'{resource} {fmt_dur(dur_secs)}'
            buf += two_col(label, fmt_cents(charge))
            buf += left_line(f'  ({mode})')

    # ---- Totals ----
    buf += divider('=')
    sub       = data.get('subtotal_cents', 0)
    disc      = data.get('discount_cents', 0)
    pool_c    = data.get('pool_time_cents', 0)
    total     = data.get('total_cents', 0)
    tip       = data.get('tip_cents', 0) or 0
    disc_pct  = data.get('manual_discount_pct', 0) or 0

    buf += two_col('Subtotal', fmt_cents(sub))
    if disc > 0:
        pct_str = f' ({disc_pct}%)' if disc_pct else ''
        buf += two_col(f'Descuento{pct_str}', f'-{fmt_cents(disc)}')
    if pool_c > 0:
        buf += two_col('Pool Time', fmt_cents(pool_c))

    buf += cmd_bold(True)
    buf += two_col('TOTAL', fmt_cents(total))
    buf += cmd_bold(False)

    if tip > 0:
        buf += two_col('Propina', fmt_cents(tip))
        buf += cmd_bold(True)
        buf += two_col('TOTAL + PROPINA', fmt_cents(total + tip))
        buf += cmd_bold(False)

    buf += divider()

    if unpaid:
        # Tip suggestion table
        buf += cmd_align(1)
        buf += enc('-- Sugerencia de Propina --') + LF
        buf += cmd_align(0)
        buf += enc(f'{"% ":>4}{"Propina":>10}{"Total":>10}') + LF
        buf += divider('-')
        for pct in [10, 15, 18, 20]:
            tip_amt = round(total * pct / 100)
            buf += enc(f'{pct:>3}% {fmt_cents(tip_amt):>10}{fmt_cents(total + tip_amt):>10}') + LF
        buf += divider()
        buf += cmd_align(1)
        buf += cmd_bold(True)
        buf += enc('** CUENTA NO PAGADA **') + LF
        buf += cmd_bold(False)
        buf += cmd_align(0)
    else:
        # Payment info
        pt  = data.get('payment_type', '')
        pt2 = data.get('payment_type_2')
        tc  = data.get('tendered_cents') or 0
        tc2 = data.get('tendered_cents_2') or 0
        chg = data.get('change_due', 0) or max(0, tc - total)

        if pt2:
            cash_amt = tc  if pt  == 'CASH' else tc2
            card_amt = tc  if pt  == 'CARD' else tc2
            buf += two_col('Efectivo', fmt_cents(cash_amt))
            buf += two_col('Tarjeta',  fmt_cents(card_amt))
        elif pt == 'CASH' and tc > 0:
            buf += two_col('Recibido', fmt_cents(tc))
            if chg > 0:
                buf += two_col('Cambio',   fmt_cents(chg))
        else:
            buf += left_line(f'Pago: {pt}')

    buf += divider()
    buf += cmd_align(1)
    buf += enc('Gracias por su visita!') + LF
    buf += enc('Vuelva pronto :)') + LF
    buf += cmd_align(0)
    buf += cmd_feed(3)
    buf += cmd_cut()

    return bytes(buf)

# ---------------------------------------------------------------------------
# Windows printing
# ---------------------------------------------------------------------------
def get_printer_name(kind: str = 'receipt') -> str:
    """
    Return the Windows printer name to use.
    kind='kitchen'  → KITCHEN_PRINTER_NAME (falls back to default if not set)
    kind='receipt'  → PRINTER_NAME (auto-detects if not set)
    """
    if kind == 'kitchen' and KITCHEN_PRINTER_NAME:
        return KITCHEN_PRINTER_NAME
    if PRINTER_NAME:
        return PRINTER_NAME
    try:
        import win32print
        # Look for POS/thermal printer first
        printers = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        for flags, desc, name, comment in printers:
            nl = name.upper()
            if any(k in nl for k in ('POS', '58', 'THERMAL', 'RECEIPT', 'RONGTA', 'XPRINTER')):
                log.info(f'Auto-selected printer: {name}')
                return name
        default = win32print.GetDefaultPrinter()
        log.info(f'Using default printer: {default}')
        return default
    except Exception as e:
        log.warning(f'Could not enumerate printers: {e}')
        return ''

def print_raw(raw_bytes: bytes, data: dict = None, unpaid: bool = False, kind: str = 'receipt') -> bool:
    """Send raw ESC/POS bytes to the correct Windows printer, or HTML preview on Mac/Linux."""
    import sys
    if sys.platform != 'win32':
        return print_html_dev(data or {}, unpaid=unpaid)
    printer_name = get_printer_name(kind=kind)
    if not printer_name:
        log.error('No printer found')
        return False
    try:
        import win32print
        handle = win32print.OpenPrinter(printer_name)
        try:
            job = win32print.StartDocPrinter(handle, 1, ('Receipt', None, 'RAW'))
            try:
                win32print.StartPagePrinter(handle)
                win32print.WritePrinter(handle, raw_bytes)
                win32print.EndPagePrinter(handle)
            finally:
                win32print.EndDocPrinter(handle)
        finally:
            win32print.ClosePrinter(handle)
        log.info(f'Printed {len(raw_bytes)} bytes to "{printer_name}" (kind={kind})')
        return True
    except Exception as e:
        log.error(f'Print error on "{printer_name}": {e}')
        return False

# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------
@app.route('/health')
def health():
    return jsonify({
        'status':           'ok',
        'printer':          get_printer_name('receipt'),
        'kitchen_printer':  get_printer_name('kitchen'),
    })

@app.route('/print', methods=['POST'])
def print_receipt():
    data    = request.get_json(force=True)
    job_id  = data.get('job_id')
    unpaid  = data.pop('unpaid', False)
    reprint = data.pop('reprint', False)

    if _dedup_check(job_id):
        log.info(f'Dedup hit for job_id={job_id} — skipping duplicate print')
        return jsonify({'ok': True, 'duplicate': True})

    ok = print_receipt_html(data, unpaid=unpaid, reprint=reprint)
    if ok:
        _dedup_record(job_id)
    return jsonify({'ok': ok}), (200 if ok else 500)


def format_chit(data: dict) -> bytes:
    """Format a kitchen or bar command chit (no prices, large & legible)."""
    from datetime import datetime as _dt
    queue_type   = data.get('type', 'KITCHEN')
    heading      = 'COCINA' if queue_type == 'KITCHEN' else 'BARRA'
    resource     = str(data.get('resource_code', '?')).upper()
    items        = data.get('items', [])
    sent_at_raw  = data.get('sent_at', '')

    # Parse timestamp → HH:MM
    try:
        from datetime import timezone
        sent_dt = _dt.fromisoformat(sent_at_raw.replace('Z', '+00:00'))
        time_str = sent_dt.astimezone().strftime('%H:%M')
    except Exception:
        time_str = _dt.now().strftime('%H:%M')

    raw = bytearray()
    raw += cmd_init()
    raw += cmd_codepage()

    # Header: centred, double-size type
    raw += cmd_align(1)
    raw += cmd_double(True)
    raw += enc(f'[ {heading} ]') + LF
    raw += cmd_double(False)
    raw += divider('=')

    # Table code: bold + centred
    raw += cmd_bold(True)
    raw += cmd_double(True)
    raw += enc(f'MESA: {resource}') + LF
    raw += cmd_double(False)
    raw += cmd_bold(False)
    raw += divider()

    # Items
    raw += cmd_align(0)
    for it in items:
        qty   = it.get('quantity', 1)
        name  = it.get('name', '')
        mods  = it.get('modifiers', [])
        notes = it.get('notes', '')

        raw += cmd_bold(True)
        raw += enc(f'{qty}x  {name}') + LF
        raw += cmd_bold(False)

        for m in mods:
            mn = m.get('name', '')
            mc = m.get('count', 1)
            label = f'{mn} x{mc}' if mc > 1 else mn
            raw += enc(f'   -> {label}') + LF

        if notes:
            raw += cmd_bold(True)
            raw += enc(f'   * {notes}') + LF
            raw += cmd_bold(False)

    raw += divider()
    raw += cmd_align(1)
    raw += enc(f'{heading} - {time_str}') + LF
    raw += cmd_feed(3)
    raw += cmd_cut()

    return bytes(raw)


@app.route('/chit', methods=['POST'])
def print_chit():
    """Print a kitchen/bar command chit (no prices).
    KITCHEN → KITCHEN_PRINTER_NAME  (cocina)
    BAR     → PRINTER_NAME          (la barra)
    """
    data      = request.get_json(force=True)
    job_id    = data.get('job_id')
    chit_kind = 'kitchen' if data.get('type', '').upper() == 'KITCHEN' else 'receipt'

    if _dedup_check(job_id):
        log.info(f'Dedup hit for chit job_id={job_id} — skipping duplicate print')
        return jsonify({'ok': True, 'duplicate': True})

    raw = format_chit(data)
    ok  = print_raw(raw, kind=chit_kind)
    if ok:
        _dedup_record(job_id)
    return jsonify({'ok': ok}), (200 if ok else 500)

@app.route('/printers')
def list_printers():
    try:
        import win32print
        printers = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        names = [name for _, _, name, _ in printers]
        return jsonify({'printers': names, 'default': win32print.GetDefaultPrinter()})
    except ImportError:
        return jsonify({'error': 'pywin32 not installed'}), 500

if __name__ == '__main__':
    log.info(f'Bola 8 Print Agent starting on port {PORT}')
    log.info(f'Configured printer: "{PRINTER_NAME or "(auto-detect)"}"')
    app.run(host='0.0.0.0', port=PORT, debug=False)
