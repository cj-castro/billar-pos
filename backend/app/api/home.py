"""Inicio — the manager/owner landing page, in ONE call (batch C).

Role-aware, enforced HERE rather than in the browser:

    both roles   ahora       drawer open/closed, tables in use, tabs, tabs waiting to pay
                 pendientes  bottles/boxes to open, low stock
    ADMIN only   hoy         sales of the shift vs the same window a week ago,
                             billar / barra / cocina split, average ticket, profit
                             (or "sin costo suficiente" -- batch B rules)
                 alertas     voids, cancelled-with-consumption, force-closes,
                             last close over/short, costs to fix

A MANAGER response is BUILT without the owner sections, so no money figure
ever reaches a manager's device (policy: sales are owner-only).

"Hoy" is the SHIFT: since the open cash session started (a bar's night crosses
midnight -- at 1 a.m. the owner wants tonight, not a fresh empty day). With no
session open it is the bar's calendar day. The comparison is the same window
shifted back exactly 7 days, so "tonight so far" is compared with "last week up
to this same time", not with a whole finished day.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required, get_jwt
from sqlalchemy import text

from app.config import Config
from app.extensions import db

home_bp = Blueprint('home', __name__)
# The bar's timezone, from venue settings (batch D1). Call bar_tz() at use
# time -- the owner can change it in Ajustes without a restart.
from app.services.venue_svc import bar_tz  # noqa: E402


def _rows(sql, **kw):
    return db.session.execute(text(sql), kw).mappings().all()


def _one(sql, **kw):
    return db.session.execute(text(sql), kw).mappings().first()


def _window():
    """(start, now, label, session_row) for the current shift."""
    now = datetime.now(timezone.utc)
    sess = _one("""
        SELECT cs.id, cs.opened_at, u.name AS opened_by_name
        FROM cash_sessions cs LEFT JOIN users u ON u.id = cs.opened_by
        WHERE cs.status = 'OPEN' ORDER BY cs.opened_at DESC LIMIT 1""")
    if sess:
        return sess['opened_at'], now, 'turno', sess
    from app.services.venue_svc import business_today, business_day_start
    return business_day_start(business_today()), now, 'dia', None


def _ahora(sess) -> dict:
    res = _one("""
        SELECT COUNT(*) FILTER (WHERE COALESCE(is_active, TRUE))                       AS total,
               COUNT(*) FILTER (WHERE COALESCE(is_active, TRUE) AND status = 'IN_USE') AS en_uso
        FROM resources""")
    t = _one("""
        SELECT COUNT(*)                                             AS abiertas,
               COUNT(*) FILTER (WHERE COALESCE(payment_requested, FALSE)) AS por_cobrar
        FROM tickets WHERE status = 'OPEN'""")
    return {
        'caja_abierta': sess is not None,
        'caja_abierta_por': sess['opened_by_name'] if sess else None,
        'caja_abierta_desde': sess['opened_at'].isoformat() if sess else None,
        'mesas_en_uso': int(res['en_uso'] or 0),
        'mesas_total': int(res['total'] or 0),
        'cuentas_abiertas': int(t['abiertas'] or 0),
        'cuentas_por_cobrar': int(t['por_cobrar'] or 0),
    }


def _pendientes(is_admin: bool) -> dict:
    # A shot / loose cigarette that is ON THE MENU, has less than one serving left, and has a sealed
    # parent on the shelf: someone needs to press "Abrir botella / caja".
    abrir = _rows("""
        SELECT ch.name AS producto, pa.name AS abrir, pa.stock_quantity AS selladas,
               c.conversion_type
        FROM inventory_conversions c
        JOIN inventory_items ch ON ch.id = c.to_item_id
        JOIN inventory_items pa ON pa.id = c.from_item_id
        WHERE c.is_active
          AND c.conversion_type IN ('BOTTLE_TO_SHOT', 'PACK_TO_LOOSE')
          -- less than one serving left (ml items: one standard pour, 049)
          AND COALESCE(ch.stock_quantity, 0) <
              CASE WHEN ch.base_unit_key = 'ml' AND ch.portion_size > 0 THEN ch.portion_size ELSE 1 END
          AND COALESCE(pa.stock_quantity, 0) >= 1
          AND EXISTS (SELECT 1 FROM insumos_base b JOIN menu_items m ON m.id = b.menu_item_id
                       WHERE b.inventory_item_id = ch.id AND COALESCE(m.is_active, TRUE))
        ORDER BY pa.name""")
    bajo = _rows("""
        SELECT name, stock_quantity, low_stock_threshold, base_unit_key
        FROM inventory_items
        WHERE COALESCE(is_active, TRUE) AND COALESCE(low_stock_threshold, 0) > 0
          AND stock_quantity <= low_stock_threshold
        ORDER BY (stock_quantity / NULLIF(low_stock_threshold, 0)), name""")
    out = {
        'por_abrir': [{'producto': r['producto'], 'abrir': r['abrir'],
                       'selladas': float(r['selladas']),
                       'tipo': 'botella' if r['conversion_type'] == 'BOTTLE_TO_SHOT' else 'caja'}
                      for r in abrir],
        'stock_bajo_total': len(bajo),
        'stock_bajo': [{'nombre': r['name'], 'existencia': float(r['stock_quantity']),
                        'minimo': float(r['low_stock_threshold']), 'unidad': r['base_unit_key']}
                       for r in bajo[:6]],
    }
    if is_admin:
        c = _one("""
            SELECT COUNT(*) FILTER (WHERE NOT tiene_costo AND lineas_expuestas > 0) AS faltantes,
                   COUNT(*) FILTER (WHERE revisar_motivo IS NOT NULL)               AS revisar
            FROM v_bola8_cobertura_costo""")
        out['costos_faltantes'] = int(c['faltantes'] or 0)
        out['costos_a_revisar'] = int(c['revisar'] or 0)
    return out


def _ventas(start, end) -> dict:
    t = _one("""
        SELECT COALESCE(SUM(total_cents), 0)     AS ventas,
               COALESCE(SUM(pool_time_cents), 0) AS billar,
               COUNT(*)                          AS tickets
        FROM tickets
        WHERE status = 'CLOSED' AND closed_at >= :s AND closed_at < :e""", s=start, e=end)
    split = {r['dest']: int(r['net'] or 0) for r in _rows("""
        SELECT li.routing_dest AS dest, SUM(v.net_sales_cents) AS net
        FROM v_bola8_lineas_venta v
        JOIN ticket_line_items li ON li.id = v.line_item_id
        WHERE v.closed_at >= :s AND v.closed_at < :e
        GROUP BY li.routing_dest""", s=start, e=end)}
    return {
        'ventas_cents': int(t['ventas']),
        'billar_cents': int(t['billar']),
        'barra_cents': split.get('BAR', 0),
        'cocina_cents': split.get('KITCHEN', 0),
        'tickets': int(t['tickets']),
        'ticket_promedio_cents': int(t['ventas'] // t['tickets']) if t['tickets'] else 0,
    }


def _hoy(start, now) -> dict:
    from app.api.analytics import COV_AGG, _margin
    cur = _ventas(start, now)
    prev = _ventas(start - timedelta(days=7), now - timedelta(days=7))
    m = _margin(_one("SELECT " + COV_AGG + " FROM v_bola8_lineas_venta "
                     "WHERE closed_at >= :s AND closed_at < :e", s=start, e=now))
    # Staff orders (batch E5) are not customer money.
    en_mesas = _one("""SELECT COALESCE(SUM(total_cents), 0) AS v, COUNT(*) AS n
                       FROM tickets WHERE status = 'OPEN' AND COALESCE(ticket_type, '') <> 'STAFF'""")

    def delta(a, b):
        return round((a - b) / b * 100, 1) if b else None

    return {
        **cur,
        'semana_pasada': prev,
        'variacion_ventas_pct': delta(cur['ventas_cents'], prev['ventas_cents']),
        'en_mesas_ahora_cents': int(en_mesas['v'] or 0),
        'cuentas_abiertas': int(en_mesas['n'] or 0),
        # Profit only when the cost behind it is known (batch B); else null + coverage.
        'utilidad_cents': (m['utilidad_estimada_cents'] + cur['billar_cents']
                           if m['utilidad_estimada_cents'] is not None else None),
        'margen_pct': m['margen_pct'] if m['margen_confiable'] else None,
        'cobertura_costo_pct': m['cobertura_costo_pct'],
    }


def _alertas(start, now) -> dict:
    voids = _one("""
        SELECT COUNT(*) AS n, COALESCE(SUM(quantity * unit_price_cents), 0) AS cents
        FROM ticket_line_items
        WHERE voided_at >= :s AND voided_at < :e""", s=start, e=now)
    anom = {r['tipo']: {'n': int(r['n']), 'cents': int(r['cents'] or 0)} for r in _rows("""
        SELECT tipo, COUNT(*) AS n, SUM(round(monto_mxn * 100)) AS cents
        FROM v_bola8_anomalias_operativas
        WHERE ocurrido_en >= :s AND ocurrido_en < :e
          AND tipo IN ('TICKET_CANCELADO', 'CIERRE_FORZADO', 'TICKET_REABIERTO')
        GROUP BY tipo""", s=start, e=now)}
    last = _one("""
        SELECT cs.id, cs.closed_at, u.name AS closed_by_name
        FROM cash_sessions cs LEFT JOIN users u ON u.id = cs.closed_by
        WHERE cs.status = 'CLOSED' AND cs.closing_cash_counted_cents IS NOT NULL
        ORDER BY cs.closed_at DESC LIMIT 1""")
    ultimo = None
    if last:
        from app.api.cash_session import _build_summary
        from app.models.cash_session import CashSession
        s = _build_summary(CashSession.query.get(last['id']))
        ultimo = {'cerrada': last['closed_at'].isoformat(), 'por': last['closed_by_name'],
                  'diferencia_cents': s['cash_over_short_cents']}
    has_view = _one("SELECT to_regclass('public.v_consumo_sin_venta') IS NOT NULL AS ok")['ok']
    regalo = {'nc': 0, 'cc': 0, 'np': 0, 'cp': 0} if not has_view else _one("""
        SELECT COUNT(*) FILTER (WHERE tipo = 'CORTESIA') AS nc,
               COALESCE(SUM(costo_cents) FILTER (WHERE tipo = 'CORTESIA'), 0) AS cc,
               COUNT(*) FILTER (WHERE tipo = 'PERSONAL') AS np,
               COALESCE(SUM(costo_cents) FILTER (WHERE tipo = 'PERSONAL'), 0) AS cp
        FROM v_consumo_sin_venta WHERE closed_at >= :s AND closed_at < :e""", s=start, e=now)
    return {
        'cancelaciones': {'n': int(voids['n']), 'cents': int(voids['cents'])},
        # Batch E5: what was given away, at cost.
        'cortesias': {'n': int(regalo['nc'] or 0), 'costo_cents': int(regalo['cc'] or 0)},
        'consumo_personal': {'n': int(regalo['np'] or 0), 'costo_cents': int(regalo['cp'] or 0)},
        'cancelados_con_consumo': anom.get('TICKET_CANCELADO', {'n': 0, 'cents': 0}),
        'cierres_forzados': anom.get('CIERRE_FORZADO', {'n': 0, 'cents': 0}),
        'reaperturas': anom.get('TICKET_REABIERTO', {'n': 0, 'cents': 0}),
        'ultimo_cierre': ultimo,
    }


@home_bp.route('', methods=['GET'])
@jwt_required()
def home():
    role = get_jwt().get('role')
    if role not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    is_admin = role == 'ADMIN'
    start, now, kind, sess = _window()
    out = {
        'rol': role,
        'ventana': {'tipo': kind, 'desde': start.isoformat(), 'hasta': now.isoformat()},
        'ahora': _ahora(sess),
        'pendientes': _pendientes(is_admin),
    }
    if is_admin:
        out['hoy'] = _hoy(start, now)
        out['alertas'] = _alertas(start, now)
    return jsonify(out)
