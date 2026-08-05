"""Daily sales email report — generates an HTML email with tables and sends it via SMTP.

Entry points
------------
generate_and_send_report(target_date=None)
    Fetches data for `target_date` (yesterday by default) and sends the email.
    Must be called inside a Flask app context.

CLI
---
  flask daily-report              → yesterday's report
  flask daily-report --date 2026-07-31  → specific date (YYYY-MM-DD)
"""

import logging
import smtplib
from datetime import datetime, timezone, timedelta, date as date_type
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

from sqlalchemy import text
from app.extensions import db
from app.config import Config

log = logging.getLogger(__name__)
LOCAL_TZ = ZoneInfo(Config.TZ)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _int(v):
    return 0 if v is None else int(v)


def _pesos(cents) -> str:
    return f"${_int(cents) / 100:,.2f}"


def _day_range(d: date_type):
    """Return (from_utc, to_utc) covering the full local-timezone day."""
    tz = LOCAL_TZ
    start = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=tz)
    end   = datetime(d.year, d.month, d.day, 23, 59, 59, 999999, tzinfo=tz)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Data queries — adapted from reports.py (pure SQL, no HTTP layer)
# ---------------------------------------------------------------------------

def _summary(f, t) -> dict:
    row = db.session.execute(text("""
        SELECT
            COUNT(*)                              AS total_tickets,
            COALESCE(SUM(subtotal_cents),   0)    AS gross_cents,
            COALESCE(SUM(discount_cents),   0)    AS discount_cents,
            COALESCE(SUM(total_cents),      0)    AS net_cents,
            COALESCE(SUM(tip_cents),        0)    AS tips_cents,
            COALESCE(SUM(pool_time_cents),  0)    AS pool_cents
        FROM tickets
        WHERE status = 'CLOSED' AND closed_at BETWEEN :f AND :t
    """), {'f': f, 't': t}).mappings().one()
    out = dict(row)

    # Payment mix comes from v_bola8_pagos_desglosados, NOT from tendered_cents.
    # tendered is not the applied amount — tendered_1 + tendered_2 = total + tip on
    # split tickets, so the previous per-leg attribution overstated cash by
    # $6,554.42 and card by $5,722.73 over 90 days. The view allocates each leg
    # from tip_source and reconciles exactly to revenue.
    pay = db.session.execute(text("""
        SELECT
            COALESCE(SUM(CASE WHEN metodo_pago = 'CASH' THEN monto_cents ELSE 0 END), 0) AS cash_cents,
            COALESCE(SUM(CASE WHEN metodo_pago = 'CARD' THEN monto_cents ELSE 0 END), 0) AS card_cents,
            COALESCE(SUM(CASE WHEN metodo_pago NOT IN ('CASH','CARD')
                              THEN monto_cents ELSE 0 END), 0)                           AS other_cents,
            COALESCE(SUM(CASE WHEN metodo_pago = 'CASH'
                              THEN propina_cents ELSE 0 END), 0)                         AS tips_cash_cents,
            COALESCE(SUM(CASE WHEN metodo_pago <> 'CASH'
                              THEN propina_cents ELSE 0 END), 0)                         AS tips_card_cents
        FROM v_bola8_pagos_desglosados
        WHERE closed_at BETWEEN :f AND :t
    """), {'f': f, 't': t}).mappings().one()
    out.update(dict(pay))

    # Profit. kpis_diarios carries no COGS at all, so this must come from the line
    # grain. cost_coverage_pct rides along because reported margin is inflated
    # while inventory unit costs are missing — a margin without its coverage is a
    # number the owner will act on and shouldn't.
    prof = db.session.execute(text("""
        SELECT
            COALESCE(SUM(net_sales_cents),    0) AS items_net_cents,
            COALESCE(SUM(total_cost_cents),   0) AS cogs_cents,
            COALESCE(SUM(gross_profit_cents), 0) AS profit_cents,
            COALESCE(SUM(CASE WHEN total_cost_cents > 0
                              THEN net_sales_cents ELSE 0 END), 0) AS net_with_cost_cents
        FROM v_bola8_lineas_venta
        WHERE closed_at BETWEEN :f AND :t
    """), {'f': f, 't': t}).mappings().one()
    out.update(dict(prof))

    items_net = _int(prof['items_net_cents'])
    out['coverage_pct'] = (round(_int(prof['net_with_cost_cents']) / items_net * 100, 1)
                           if items_net else None)
    # Billiard time has no COGS row, so it is ~pure contribution.
    out['total_profit_cents'] = _int(prof['profit_cents']) + _int(row['pool_cents'])
    return out


def _products(f, t, limit=10) -> list:
    rows = db.session.execute(text("""
        SELECT
            COALESCE(mi.name, tli.item_name)       AS item_name,
            COALESCE(mc.name, '—')                 AS category,
            SUM(tli.quantity)::int                 AS units_sold,
            SUM(tli.quantity * tli.unit_price_cents)::int AS gross_cents,
            COALESCE(SUM(promo.discount_cents), 0)::int   AS discount_cents
        FROM ticket_line_items tli
        JOIN tickets t ON tli.ticket_id = t.id
        LEFT JOIN menu_items mi       ON tli.menu_item_id = mi.id
        LEFT JOIN menu_categories mc  ON mi.category_id = mc.id
        LEFT JOIN (
            SELECT line_item_id, SUM(discount_cents) AS discount_cents
            FROM line_item_promotions GROUP BY line_item_id
        ) promo ON promo.line_item_id = tli.id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :f AND :t
          AND tli.status != 'VOIDED'
        GROUP BY COALESCE(mi.name, tli.item_name), COALESCE(mc.name, '—')
        ORDER BY gross_cents DESC
        LIMIT :lim
    """), {'f': f, 't': t, 'lim': limit}).mappings().all()
    return [dict(r) for r in rows]


def _peak_hours(f, t) -> list:
    rows = db.session.execute(text("""
        SELECT
            EXTRACT(HOUR FROM closed_at AT TIME ZONE :tz)::int AS hour,
            COUNT(*)                                           AS ticket_count,
            COALESCE(SUM(total_cents), 0)::int                 AS revenue_cents,
            COALESCE(SUM(tip_cents),   0)::int                 AS tips_cents
        FROM tickets
        WHERE status = 'CLOSED' AND closed_at BETWEEN :f AND :t
        GROUP BY 1 ORDER BY 1
    """), {'f': f, 't': t, 'tz': Config.TZ}).mappings().all()
    return [dict(r) for r in rows]


def _staff(f, t) -> list:
    rows = db.session.execute(text("""
        SELECT
            u.name                                      AS staff_name,
            u.role                                      AS role,
            COALESCE(c.tickets_closed,  0)              AS tickets_closed,
            COALESCE(c.total_sales,     0)::int         AS total_sales_cents,
            COALESCE(c.total_tips,      0)::int         AS total_tips_cents,
            COALESCE(c.cash_sales,      0)::int         AS cash_cents,
            COALESCE(c.card_sales,      0)::int         AS card_cents
        FROM users u
        LEFT JOIN (
            SELECT
                opened_by,
                COUNT(DISTINCT id)  AS tickets_closed,
                SUM(total_cents)    AS total_sales,
                SUM(tip_cents)      AS total_tips,
                SUM(CASE WHEN payment_type='CASH' AND payment_type_2 IS NULL THEN total_cents
                         WHEN payment_type='CASH' THEN COALESCE(tendered_cents,0) ELSE 0 END
                  + CASE WHEN payment_type_2='CASH' THEN COALESCE(tendered_cents_2,0) ELSE 0 END)
                                    AS cash_sales,
                SUM(CASE WHEN payment_type='CARD' AND payment_type_2 IS NULL THEN total_cents
                         WHEN payment_type='CARD' THEN COALESCE(tendered_cents,0) ELSE 0 END
                  + CASE WHEN payment_type_2='CARD' THEN COALESCE(tendered_cents_2,0) ELSE 0 END)
                                    AS card_sales
            FROM tickets
            WHERE status = 'CLOSED' AND closed_at BETWEEN :f AND :t
            GROUP BY opened_by
        ) c ON c.opened_by = u.id
        WHERE u.is_active = TRUE AND COALESCE(c.tickets_closed, 0) > 0
        ORDER BY total_sales_cents DESC
    """), {'f': f, 't': t}).mappings().all()
    return [dict(r) for r in rows]


def _pool_tables(f, t) -> list:
    rows = db.session.execute(text("""
        SELECT
            r.code                                          AS table_code,
            COUNT(pts.id)                                   AS sessions,
            COALESCE(SUM(pts.duration_seconds), 0)::int    AS total_seconds,
            COALESCE(SUM(pts.charge_cents),     0)::int    AS revenue_cents
        FROM pool_timer_sessions pts
        JOIN resources r ON pts.resource_id = r.id
        JOIN tickets   t ON pts.ticket_id   = t.id
        WHERE t.status = 'CLOSED' AND t.closed_at BETWEEN :f AND :t
        GROUP BY r.code ORDER BY revenue_cents DESC
    """), {'f': f, 't': t}).mappings().all()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# HTML email builder
# ---------------------------------------------------------------------------

_STYLE = {
    'body':    'margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    'th':      'padding:9px 14px;background:#1E293B;color:#94A3B8;font-size:11px;text-transform:uppercase;text-align:{align};white-space:nowrap;',
    'td':      'padding:7px 14px;border-bottom:1px solid #E5E7EB;text-align:{align};',
    'td_bold': 'padding:7px 14px;border-bottom:1px solid #E5E7EB;text-align:{align};font-weight:600;',
}


def _th(label, align='right'):
    return f'<th style="{_STYLE["th"].format(align=align)}">{label}</th>'


def _td(val, align='right', bold=False, color=''):
    base = _STYLE['td_bold'] if bold else _STYLE['td']
    style = base.format(align=align) + (f'color:{color};' if color else '')
    return f'<td style="{style}">{val}</td>'


def _section(title, content):
    return f'''
    <div style="margin-bottom:28px;">
      <h2 style="font-size:15px;font-weight:700;color:#1E293B;margin:0 0 12px;
                 padding-bottom:8px;border-bottom:2px solid #E2E8F0;">{title}</h2>
      {content}
    </div>'''


def _no_data_row(cols):
    return (f'<tr><td colspan="{cols}" style="padding:14px;color:#94A3B8;'
            f'font-style:italic;text-align:center;">Sin datos para este período</td></tr>')


def _build_html(date_label, summary, products, hours, staff_data, pool) -> str:
    net      = _int(summary['net_cents'])
    gross    = _int(summary['gross_cents'])
    disc     = _int(summary['discount_cents'])
    tips     = _int(summary['tips_cents'])
    pool_inc = _int(summary['pool_cents'])
    tickets  = _int(summary['total_tickets'])
    cash     = _int(summary['cash_cents'])
    card     = _int(summary['card_cents'])
    other    = _int(summary.get('other_cents'))
    cogs     = _int(summary.get('cogs_cents'))
    profit   = _int(summary.get('total_profit_cents'))
    coverage = summary.get('coverage_pct')

    # ── Summary table ────────────────────────────────────────────────────────
    def stat_row(label, value, sub='', color='#0F172A'):
        return f'''
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;color:#64748B;font-size:13px;">{label}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;text-align:right;
                     font-size:16px;font-weight:700;color:{color};">{value}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;text-align:right;
                     font-size:12px;color:#94A3B8;">{sub}</td>
        </tr>'''

    avg_ticket = net // tickets if tickets else 0
    margin_pct = (profit / net * 100) if net else 0

    summary_table = f'''
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;font-size:13px;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
      {stat_row('Ingresos Netos (total cobrado)', _pesos(net),     f'Bruto {_pesos(gross)}', '#10B981')}
      {stat_row('Utilidad Bruta',                 _pesos(profit),
                f'Margen {margin_pct:.1f}% · COGS {_pesos(cogs)}', '#059669')}
      {stat_row('Descuentos y Promociones',       _pesos(disc),    '', '#EF4444')}
      {stat_row('Propinas',                       _pesos(tips),
                f'Efectivo {_pesos(_int(summary.get("tips_cash_cents")))} · '
                f'Tarjeta {_pesos(_int(summary.get("tips_card_cents")))}', '#F59E0B')}
      {stat_row('Tiempo de Mesa (billar)',         _pesos(pool_inc),
                'sin costo de insumo', '#8B5CF6')}
      {stat_row('Pago en Efectivo',               _pesos(cash),    '', '#0F172A')}
      {stat_row('Pago con Tarjeta',               _pesos(card),    '', '#0F172A')}
      {stat_row('Otros Pagos', _pesos(other), '', '#0F172A') if other else ''}
      {stat_row('Tickets Cerrados',               str(tickets),
                f'Promedio {_pesos(avg_ticket)}', '#0F172A')}
    </table>'''

    # Permanent honesty banner. Reported margin is inflated while inventory unit
    # costs are missing, and the email must never show a margin without it.
    coverage_note = ''
    if coverage is not None and coverage < 50:
        coverage_note = f'''
    <div style="margin:14px 0;padding:12px 14px;background:#FFFBEB;border:1px solid #FCD34D;
                border-radius:8px;font-size:12px;color:#92400E;line-height:1.5;">
      <b>⚠ Cobertura de costo: {coverage:.1f}%</b><br>
      La utilidad de arriba está <b>inflada</b>: solo el {coverage:.1f}% de la venta de artículos
      tiene costo real capturado. Faltan costos unitarios de insumos. Revisa la pestaña
      <b>Costos</b> en Analítica para ver qué capturar primero.
    </div>'''

    # ── Peak hours table ─────────────────────────────────────────────────────
    peak_rows = ''
    if hours:
        peak_rev = max(h['revenue_cents'] for h in hours)
        for h in hours:
            is_peak = h['revenue_cents'] == peak_rev
            row_bg  = '#FFFBEB' if is_peak else ('#F8FAFC' if hours.index(h) % 2 == 0 else '#FFFFFF')
            badge   = ' ⚡' if is_peak else ''
            peak_rows += f'''
            <tr style="background:{row_bg};">
              {_td(f"{h['hour']:02d}:00 – {h['hour']:02d}:59{badge}", align='left')}
              {_td(str(h['ticket_count']))}
              {_td(_pesos(h['revenue_cents']), bold=is_peak, color='#B45309' if is_peak else '')}
              {_td(_pesos(h['tips_cents']))}
            </tr>'''
    else:
        peak_rows = _no_data_row(4)

    hours_table = f'''
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;font-size:13px;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
      <thead><tr>
        {_th('Hora', align='left')}{_th('Tickets')}{_th('Ingresos')}{_th('Propinas')}
      </tr></thead>
      <tbody>{peak_rows}</tbody>
    </table>'''

    # ── Products table ───────────────────────────────────────────────────────
    prod_rows = ''
    medals = ['🥇', '🥈', '🥉']
    for i, p in enumerate(products):
        net_p  = p['gross_cents'] - p['discount_cents']
        row_bg = '#F8FAFC' if i % 2 == 0 else '#FFFFFF'
        medal  = medals[i] if i < 3 else str(i + 1)
        prod_rows += f'''
        <tr style="background:{row_bg};">
          {_td(medal, align='center')}
          {_td(p['item_name'], align='left')}
          {_td(p['category'], align='left')}
          {_td(str(p['units_sold']))}
          {_td(_pesos(p['gross_cents']))}
          {_td(_pesos(p['discount_cents']), color='#EF4444' if p['discount_cents'] else '#94A3B8')}
          {_td(_pesos(net_p), bold=True, color='#10B981')}
        </tr>'''
    if not prod_rows:
        prod_rows = _no_data_row(7)

    products_table = f'''
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;font-size:13px;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
      <thead><tr>
        {_th('#', align='center')}{_th('Producto', align='left')}{_th('Categoría', align='left')}
        {_th('Uds.')}{_th('Bruto')}{_th('Descuento')}{_th('Neto')}
      </tr></thead>
      <tbody>{prod_rows}</tbody>
    </table>'''

    # ── Staff table ──────────────────────────────────────────────────────────
    staff_rows = ''
    for i, s in enumerate(staff_data):
        row_bg = '#F8FAFC' if i % 2 == 0 else '#FFFFFF'
        medal  = (medals[i] + ' ') if i < 3 else ''
        role_label = {'MANAGER': 'Gerente', 'WAITER': 'Mesero', 'ADMIN': 'Admin',
                      'BAR_STAFF': 'Bar', 'KITCHEN_STAFF': 'Cocina'}.get(s['role'], s['role'])
        staff_rows += f'''
        <tr style="background:{row_bg};">
          {_td(f"{medal}{s['staff_name']}", align='left')}
          {_td(role_label, align='left')}
          {_td(str(s['tickets_closed']))}
          {_td(_pesos(s['total_sales_cents']), bold=True, color='#10B981')}
          {_td(_pesos(s['total_tips_cents']),  color='#F59E0B')}
          {_td(_pesos(s['cash_cents']))}
          {_td(_pesos(s['card_cents']))}
        </tr>'''
    if not staff_rows:
        staff_rows = _no_data_row(7)

    staff_table = f'''
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;font-size:13px;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
      <thead><tr>
        {_th('Personal', align='left')}{_th('Rol', align='left')}
        {_th('Tickets')}{_th('Ventas')}{_th('Propinas')}{_th('Efectivo')}{_th('Tarjeta')}
      </tr></thead>
      <tbody>{staff_rows}</tbody>
    </table>'''

    # ── Pool tables table ────────────────────────────────────────────────────
    pool_rows = ''
    for i, p in enumerate(pool):
        mins   = p['total_seconds'] // 60
        row_bg = '#F8FAFC' if i % 2 == 0 else '#FFFFFF'
        pool_rows += f'''
        <tr style="background:{row_bg};">
          {_td(p['table_code'], align='left', bold=True)}
          {_td(str(p['sessions']))}
          {_td(f"{mins // 60}h {mins % 60:02d}m")}
          {_td(_pesos(p['revenue_cents']), bold=True, color='#8B5CF6')}
        </tr>'''
    if not pool_rows:
        pool_rows = _no_data_row(4)

    pool_table = f'''
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;font-size:13px;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
      <thead><tr>
        {_th('Mesa', align='left')}{_th('Sesiones')}{_th('Tiempo Total')}{_th('Ingresos')}
      </tr></thead>
      <tbody>{pool_rows}</tbody>
    </table>'''

    # ── Highlights bar ───────────────────────────────────────────────────────
    if hours:
        peak = max(hours, key=lambda h: h['revenue_cents'])
        peak_txt = f"{peak['hour']:02d}:00 – {peak['hour']:02d}:59 ({_pesos(peak['revenue_cents'])})"
    else:
        peak_txt = '—'
    best_product = f"{products[0]['item_name']} ({_pesos(products[0]['gross_cents'])})" if products else '—'
    best_staff   = f"{staff_data[0]['staff_name']} ({_pesos(staff_data[0]['total_sales_cents'])})" if staff_data else '—'

    generated_at = datetime.now(LOCAL_TZ).strftime('%d/%m/%Y %H:%M')

    return f'''<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reporte de Ventas — {date_label}</title>
</head>
<body style="{_STYLE['body']}">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:24px 16px;">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

  <!-- Header -->
  <tr><td style="background:#0F172A;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
    <div style="font-size:28px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px;">🎱 Billar POS</div>
    <div style="font-size:13px;color:#64748B;margin-top:4px;">Reporte Diario de Ventas</div>
    <div style="display:inline-block;background:#1D4ED8;color:#BFDBFE;
                font-size:14px;font-weight:600;padding:6px 20px;border-radius:20px;margin-top:12px;">
      📅 {date_label}
    </div>
  </td></tr>

  <!-- Highlights strip -->
  <tr><td style="background:#1E293B;padding:12px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:4px 8px;font-size:11px;color:#94A3B8;text-align:center;border-right:1px solid #334155;">
          <span style="color:#FCD34D;font-weight:700;">⚡ Hora pico</span><br>{peak_txt}
        </td>
        <td style="padding:4px 8px;font-size:11px;color:#94A3B8;text-align:center;border-right:1px solid #334155;">
          <span style="color:#6EE7B7;font-weight:700;">🏆 Top producto</span><br>{best_product}
        </td>
        <td style="padding:4px 8px;font-size:11px;color:#94A3B8;text-align:center;">
          <span style="color:#FCA5A5;font-weight:700;">⭐ Top staff</span><br>{best_staff}
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#FFFFFF;border-radius:0 0 12px 12px;padding:28px 32px;">

    {_section('💰 Resumen del Día', summary_table + coverage_note)}
    {_section('⏰ Ingresos por Hora', hours_table)}
    {_section('🍺 Top Productos (por venta bruta)', products_table)}
    {_section('👥 Rendimiento del Personal', staff_table)}
    {_section('🎱 Mesas de Billar', pool_table)}

    <div style="margin-top:24px;padding-top:18px;border-top:1px solid #E2E8F0;
                text-align:center;color:#94A3B8;font-size:11px;">
      Generado automáticamente por Billar POS · {generated_at}
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>'''


# ---------------------------------------------------------------------------
# SMTP sender
# ---------------------------------------------------------------------------

def _send(subject: str, html: str):
    from_addr = Config.REPORT_FROM
    to_addrs  = [a.strip() for a in Config.REPORT_TO.split(',') if a.strip()]

    if not from_addr:
        raise RuntimeError("REPORT_FROM is not configured")
    if not to_addrs:
        raise RuntimeError("REPORT_TO is not configured")
    if not Config.SMTP_USER or not Config.SMTP_PASSWORD:
        raise RuntimeError("SMTP_USER / SMTP_PASSWORD are not configured")

    msg = MIMEMultipart('alternative')
    msg['Subject'] = Header(subject, 'utf-8')
    msg['From']    = from_addr
    msg['To']      = ', '.join(to_addrs)
    msg.attach(MIMEText(html, 'html', 'utf-8'))

    password = Config.SMTP_PASSWORD.replace(' ', '')  # strip spaces from Google App Password format
    with smtplib.SMTP(Config.SMTP_HOST, Config.SMTP_PORT, timeout=30) as smtp:
        smtp.ehlo()
        smtp.starttls()
        smtp.login(Config.SMTP_USER, password)
        smtp.send_message(msg)

    log.info("Daily report sent → %s", ', '.join(to_addrs))


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def generate_and_send_report(target_date: date_type | None = None):
    """Collect yesterday's data, build the HTML email, and send it."""
    local_now = datetime.now(LOCAL_TZ)
    if target_date is None:
        target_date = (local_now - timedelta(days=1)).date()

    from_dt, to_dt = _day_range(target_date)
    date_label = target_date.strftime('%-d de %B de %Y')   # e.g. "1 de agosto de 2026"

    log.info("Building daily report for %s (%s → %s UTC)", target_date, from_dt, to_dt)

    summ     = _summary(from_dt, to_dt)
    prods    = _products(from_dt, to_dt)
    hrs      = _peak_hours(from_dt, to_dt)
    staff    = _staff(from_dt, to_dt)
    pool     = _pool_tables(from_dt, to_dt)

    html     = _build_html(date_label, summ, prods, hrs, staff, pool)
    subject  = f"📊 Reporte de Ventas — {date_label}"

    _send(subject, html)
