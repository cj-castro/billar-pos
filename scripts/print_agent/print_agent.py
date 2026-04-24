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
from datetime import datetime
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Configuration — edit PRINTER_NAME to match your Windows printer name,
# or leave blank to use the default printer.
# ---------------------------------------------------------------------------
PRINTER_NAME = os.environ.get('PRINTER_NAME', '')   # e.g. "POS-58" or "RONGTA POS58"
PORT = int(os.environ.get('PRINT_PORT', 9191))
CHARS = 32          # POS-58 characters per line (normal font)

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
def format_receipt(data: dict, unpaid: bool = False) -> bytes:
    buf = bytearray()

    buf += cmd_init()
    buf += cmd_codepage()

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
                # Show each flavor/variant as a sub-line (name only, price rolled in)
                for v in variants:
                    mod_names = [m.get('name','') for m in v['mods'] if m.get('name')]
                    note_part = f'({v["notes"]})' if v['notes'] else ''
                    label_parts = [p for p in mod_names + [note_part] if p]
                    label = ', '.join(label_parts) or '—'
                    prefix = f'  {v["qty"]}x ' if v['qty'] > 1 else '  '
                    buf += left_line(f'{prefix}{label}')
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
            resource  = s.get('resource_code', '')
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
def get_printer_name():
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

def print_raw(raw_bytes: bytes) -> bool:
    """Send raw ESC/POS bytes to the Windows printer."""
    printer_name = get_printer_name()
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
        log.info(f'Printed {len(raw_bytes)} bytes to "{printer_name}"')
        return True
    except ImportError:
        # Fallback: dump to temp file (for testing on non-Windows)
        tmp = tempfile.mktemp(suffix='.bin')
        with open(tmp, 'wb') as f:
            f.write(raw_bytes)
        log.warning(f'pywin32 not available — saved receipt to {tmp}')
        return True
    except Exception as e:
        log.error(f'Print error: {e}')
        return False

# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------
@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'printer': get_printer_name()})

@app.route('/print', methods=['POST'])
def print_receipt():
    data   = request.get_json(force=True)
    unpaid = data.pop('unpaid', False)
    raw    = format_receipt(data, unpaid=unpaid)
    ok     = print_raw(raw)
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
