"""
Analytics API — ADMIN ONLY.

Exposes cost structure, supplier pricing, per-employee performance and drawer
variance. MANAGER is deliberately excluded, matching /reports, /earnings and
/safe.

HARD RULES (docs/analytics-blueprint.md)
  * Every query in this module reads ONLY v_bola8_* views. No transactional
    table (tickets, ticket_line_items, menu_items, inventory_items, …) is
    referenced here. The views own the joins.
  * Money crosses the wire as INTEGER CENTS, never as a float. NUMERIC(18,2)
    from the view is multiplied by 100 in Decimal space, so nothing is lost.
    The frontend renders with formatMXN() from utils/money.ts.
  * Dates are bar-local (America/Mexico_City). The views already expose
    fecha_mx, so `from`/`to` compare directly against it — no UTC round-trip.

COST-COVERAGE DISCIPLINE
    Reported gross margin is currently ~97% because 64 of 76 inventory items
    have no unit cost. Every response that carries a margin also carries
    cobertura_costo_pct. A margin without its coverage next to it is a number
    the owner will act on and shouldn't.
"""

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt
from sqlalchemy import text

from app.config import Config
from app.extensions import db

LOCAL_TZ = ZoneInfo(Config.TZ)

analytics_bp = Blueprint('analytics', __name__)

# Views created by STEP 25. If a deployment never ran init-db these are absent,
# and we want a clear 503 rather than a raw ProgrammingError.
_NEW_VIEWS = (
    'v_bola8_pagos_desglosados',
    'v_bola8_flujo_caja',
    'v_bola8_cobertura_costo',
    'v_bola8_varianza_inventario',
    'v_bola8_personal_desempeno',
    'v_bola8_anomalias_operativas',
    'v_bola8_promo_redenciones',
    'v_bola8_costos_fijos',
    'v_bola8_billar_por_mesa',
    'v_bola8_rentabilidad_diaria',
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _require_admin():
    """Analytics is ADMIN-only. Returns an error tuple, or None when allowed."""
    claims = get_jwt()
    if claims.get('role') != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


def _parse_range(default_days: int = 30):
    """`from`/`to` as YYYY-MM-DD, interpreted as bar-local dates.

    Compared directly against fecha_mx, which the views already derive with
    AT TIME ZONE 'America/Mexico_City'. Defaults to the trailing `default_days`
    ending today.
    """
    today = datetime.now(LOCAL_TZ).date()
    to_str = request.args.get('to')
    from_str = request.args.get('from')
    try:
        date_to = datetime.fromisoformat(to_str).date() if to_str else today
    except ValueError:
        date_to = today
    try:
        date_from = (datetime.fromisoformat(from_str).date() if from_str
                     else date_to - timedelta(days=default_days - 1))
    except ValueError:
        date_from = date_to - timedelta(days=default_days - 1)
    if date_from > date_to:
        date_from, date_to = date_to, date_from
    return date_from, date_to


def _cents(value) -> int:
    """NUMERIC(18,2) MXN -> integer cents, in Decimal space (never float)."""
    if value is None:
        return 0
    return int((Decimal(str(value)) * 100).to_integral_value())


def _pct(value):
    """NUMERIC percentage -> float for display, or None. Not a money value."""
    return None if value is None else float(value)


def _missing_views():
    rows = db.session.execute(text(
        "SELECT table_name FROM information_schema.views "
        "WHERE table_schema = 'public' AND table_name = ANY(:names)"
    ), {'names': list(_NEW_VIEWS)}).fetchall()
    return [v for v in _NEW_VIEWS if v not in {r[0] for r in rows}]


def _guard():
    """Admin check + analytics-layer presence check."""
    denied = _require_admin()
    if denied:
        return denied
    missing = _missing_views()
    if missing:
        # `flask init-db` alone is NOT enough when the 13 original v_bola8_* views
        # are absent: STEP 26 skips itself in that case, so the ten views below
        # never get created. The SQL installer is self-contained and fixes both.
        foundation = db.session.execute(text(
            "SELECT count(*) FROM information_schema.views "
            "WHERE table_schema = 'public' AND table_name IN "
            "('v_bola8_lineas_venta', 'v_bola8_tickets_cerrados')"
        )).scalar()
        return jsonify({
            'error': 'ANALYTICS_LAYER_MISSING',
            'missing_views': missing,
            'foundation_views_present': int(foundation) == 2,
            'hint': (
                'Ejecuta deploy/analytics/db_update_analytics.sql en esta base de datos:  '
                'docker cp db_update_analytics.sql billar-pos-postgres-1:/tmp/  &&  '
                'docker exec billar-pos-postgres-1 psql -U billiard -d billiardbar '
                '-v ON_ERROR_STOP=1 -f /tmp/db_update_analytics.sql'
            ) if int(foundation) != 2 else (
                'Ejecuta `flask init-db` (STEP 26) en esta base de datos.'
            ),
        }), 503
    return None


# ── GET /api/v1/analytics/health ─────────────────────────────────────────────

@analytics_bp.route('/health', methods=['GET'])
@jwt_required()
def health():
    """Which analytics views exist. Cheap probe for the UI to disable tabs."""
    denied = _require_admin()
    if denied:
        return denied
    missing = _missing_views()
    return jsonify({
        'ready': not missing,
        'missing_views': missing,
    })


# ── GET /api/v1/analytics/overview ───────────────────────────────────────────

@analytics_bp.route('/overview', methods=['GET'])
@jwt_required()
def overview():
    """Executive dashboard.

    v_bola8_kpis_ejecutivos cannot serve this — it aggregates ALL history into a
    single row with no date predicate. Period totals are therefore rebuilt from
    the two grain views, which are the only date-filterable ones.

    Revenue reconciles as:  ventas = venta_articulos + billar
    Billiard time is ~16% of revenue, lives only at ticket grain, and carries no
    COGS row, so it is reported as a separate ~100%-margin stream rather than
    folded silently into product margin.
    """
    denied = _guard()
    if denied:
        return denied
    date_from, date_to = _parse_range()
    span = (date_to - date_from).days + 1
    prev_to = date_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=span - 1)
    params = {'f': date_from, 't': date_to, 'pf': prev_from, 'pt': prev_to}

    # Daily series: ticket-level KPIs joined to line-level profit. kpis_diarios
    # has no COGS at all, so profit must come from lineas_venta.
    daily = db.session.execute(text("""
        WITH profit AS (
            SELECT fecha_mx,
                   SUM(net_sales_cents)   AS net_cents,
                   SUM(total_cost_cents)  AS costo_cents,
                   SUM(gross_profit_cents) AS utilidad_cents,
                   SUM(CASE WHEN total_cost_cents > 0 THEN net_sales_cents ELSE 0 END)
                                          AS net_con_costo_cents
            FROM v_bola8_lineas_venta
            WHERE fecha_mx BETWEEN :f AND :t
            GROUP BY fecha_mx
        )
        SELECT k.fecha_mx,
               k.tickets_cerrados,
               k.ventas_mxn,
               k.billar_mxn,
               k.descuentos_mxn,
               k.propinas_mxn,
               k.ticket_promedio_mxn,
               COALESCE(p.net_cents, 0)            AS net_cents,
               COALESCE(p.costo_cents, 0)          AS costo_cents,
               COALESCE(p.utilidad_cents, 0)       AS utilidad_cents,
               COALESCE(p.net_con_costo_cents, 0)  AS net_con_costo_cents
        FROM v_bola8_kpis_diarios k
        LEFT JOIN profit p ON p.fecha_mx = k.fecha_mx
        WHERE k.fecha_mx BETWEEN :f AND :t
        ORDER BY k.fecha_mx
    """), params).mappings().all()

    def _period_totals(f_key, t_key):
        row = db.session.execute(text("""
            SELECT COALESCE(SUM(t.total_cents), 0)     AS ventas_cents,
                   COALESCE(SUM(t.pool_time_cents), 0) AS billar_cents,
                   COALESCE(SUM(t.tip_cents), 0)       AS propinas_cents,
                   COALESCE(SUM(t.discount_cents), 0)  AS descuentos_cents,
                   COUNT(*)                            AS tickets,
                   COUNT(DISTINCT t.fecha_mx)          AS dias
            FROM v_bola8_tickets_cerrados t
            WHERE t.fecha_mx BETWEEN :%s AND :%s
        """ % (f_key, t_key)), params).mappings().first()
        prof = db.session.execute(text("""
            SELECT COALESCE(SUM(net_sales_cents), 0)   AS net_cents,
                   COALESCE(SUM(total_cost_cents), 0)  AS costo_cents,
                   COALESCE(SUM(gross_profit_cents), 0) AS utilidad_cents,
                   COALESCE(SUM(CASE WHEN total_cost_cents > 0
                                     THEN net_sales_cents ELSE 0 END), 0) AS net_con_costo_cents
            FROM v_bola8_lineas_venta
            WHERE fecha_mx BETWEEN :%s AND :%s
        """ % (f_key, t_key)), params).mappings().first()
        return row, prof

    cur, cur_p = _period_totals('f', 't')
    prv, prv_p = _period_totals('pf', 'pt')

    # Payment mix from the corrected view. kpis_diarios' cash/card columns
    # double-count split tickets by $93,541.10 over 90 days and are not used.
    mix = db.session.execute(text("""
        SELECT metodo_pago,
               SUM(monto_cents)   AS monto_cents,
               SUM(propina_cents) AS propina_cents,
               COUNT(*)           AS pagos
        FROM v_bola8_pagos_desglosados
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY metodo_pago
        ORDER BY SUM(monto_cents) DESC
    """), params).mappings().all()

    por_hora = db.session.execute(text("""
        SELECT hora_mx,
               COUNT(DISTINCT ticket_id) AS tickets,
               SUM(net_sales_cents)      AS net_cents,
               SUM(gross_profit_cents)   AS utilidad_cents
        FROM v_bola8_lineas_venta
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY hora_mx ORDER BY hora_mx
    """), params).mappings().all()

    por_categoria = db.session.execute(text("""
        SELECT categoria,
               SUM(quantity)           AS unidades,
               SUM(net_sales_cents)    AS net_cents,
               SUM(gross_profit_cents) AS utilidad_cents
        FROM v_bola8_lineas_venta
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY categoria
        ORDER BY SUM(net_sales_cents) DESC
    """), params).mappings().all()

    forecast = db.session.execute(text("""
        SELECT fecha_forecast, dia_semana, forecast_ventas_mxn, forecast_tickets
        FROM v_bola8_forecast_semanal ORDER BY fecha_forecast
    """)).mappings().all()

    def _delta(now_v, prev_v):
        if not prev_v:
            return None
        return round((now_v - prev_v) / prev_v * 100, 2)

    cobertura = (round(cur_p['net_con_costo_cents'] / cur_p['net_cents'] * 100, 2)
                 if cur_p['net_cents'] else None)

    return jsonify({
        'rango': {'from': str(date_from), 'to': str(date_to), 'dias': span},
        'comparativo': {'from': str(prev_from), 'to': str(prev_to)},
        'totales': {
            'ventas_cents': int(cur['ventas_cents']),
            'billar_cents': int(cur['billar_cents']),
            'venta_articulos_cents': int(cur_p['net_cents']),
            'costo_cents': int(cur_p['costo_cents']),
            'utilidad_cents': int(cur_p['utilidad_cents']),
            # Billiard time has no COGS row, so it is pure contribution.
            'utilidad_total_cents': int(cur_p['utilidad_cents']) + int(cur['billar_cents']),
            'propinas_cents': int(cur['propinas_cents']),
            'descuentos_cents': int(cur['descuentos_cents']),
            'tickets': int(cur['tickets']),
            'dias_operados': int(cur['dias']),
            'ticket_promedio_cents': (int(cur['ventas_cents'] // cur['tickets'])
                                      if cur['tickets'] else 0),
            'venta_diaria_promedio_cents': (int(cur['ventas_cents'] // cur['dias'])
                                            if cur['dias'] else 0),
            'margen_pct': (round(cur_p['utilidad_cents'] / cur_p['net_cents'] * 100, 2)
                           if cur_p['net_cents'] else None),
            'cobertura_costo_pct': cobertura,
        },
        'variacion_pct': {
            'ventas': _delta(int(cur['ventas_cents']), int(prv['ventas_cents'])),
            'tickets': _delta(int(cur['tickets']), int(prv['tickets'])),
            'utilidad': _delta(int(cur_p['utilidad_cents']), int(prv_p['utilidad_cents'])),
        },
        'serie_diaria': [{
            'fecha': str(r['fecha_mx']),
            'tickets': int(r['tickets_cerrados']),
            'ventas_cents': _cents(r['ventas_mxn']),
            'billar_cents': _cents(r['billar_mxn']),
            'propinas_cents': _cents(r['propinas_mxn']),
            'descuentos_cents': _cents(r['descuentos_mxn']),
            'venta_articulos_cents': int(r['net_cents']),
            'costo_cents': int(r['costo_cents']),
            'utilidad_cents': int(r['utilidad_cents']),
            'ticket_promedio_cents': _cents(r['ticket_promedio_mxn']),
        } for r in daily],
        'mezcla_pago': [{
            'metodo': r['metodo_pago'],
            'monto_cents': int(r['monto_cents']),
            'propina_cents': int(r['propina_cents']),
            'pagos': int(r['pagos']),
        } for r in mix],
        'por_hora': [{
            'hora': int(r['hora_mx']),
            'tickets': int(r['tickets']),
            'venta_cents': int(r['net_cents']),
            'utilidad_cents': int(r['utilidad_cents']),
        } for r in por_hora],
        'por_categoria': [{
            'categoria': r['categoria'],
            'unidades': int(r['unidades']),
            'venta_cents': int(r['net_cents']),
            'utilidad_cents': int(r['utilidad_cents']),
        } for r in por_categoria],
        'pronostico_7d': [{
            'fecha': str(r['fecha_forecast']),
            'dia': (r['dia_semana'] or '').strip(),
            'ventas_cents': _cents(r['forecast_ventas_mxn']),
            'tickets': float(r['forecast_tickets'] or 0),
        } for r in forecast],
        'nota_cobertura': (
            'El margen mostrado es provisional: solo '
            f'{cobertura if cobertura is not None else 0}% de la venta de artículos '
            'tiene costo real capturado.'
        ),
    })


# ── GET /api/v1/analytics/menu-engineering ───────────────────────────────────

@analytics_bp.route('/menu-engineering', methods=['GET'])
@jwt_required()
def menu_engineering():
    """Star / Plowhorse / Puzzle / Dog classification.

    Popularity and margin are compared against the MEDIAN of the period, not the
    mean — a single runaway seller (Cubeta Premium at $106k) would drag a mean
    so far right that almost everything classifies as unpopular.

    Products whose cost coverage is 0% are flagged: their margin is not a
    measurement, it is an artefact of a missing unit cost, and they must not be
    read as Stars.
    """
    denied = _guard()
    if denied:
        return denied
    date_from, date_to = _parse_range()
    params = {'f': date_from, 't': date_to}

    rows = db.session.execute(text("""
        WITH prod AS (
            SELECT producto,
                   categoria,
                   SUM(quantity)                                   AS unidades,
                   COUNT(DISTINCT ticket_id)                       AS tickets,
                   SUM(net_sales_cents)                            AS net_cents,
                   SUM(total_cost_cents)                           AS costo_cents,
                   SUM(gross_profit_cents)                         AS utilidad_cents,
                   SUM(CASE WHEN total_cost_cents > 0
                            THEN net_sales_cents ELSE 0 END)       AS net_con_costo_cents,
                   SUM(allocated_discount_cents)                   AS descuento_cents
            FROM v_bola8_lineas_venta
            WHERE fecha_mx BETWEEN :f AND :t
            GROUP BY producto, categoria
        ),
        stats AS (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY unidades) AS med_unidades,
                   percentile_cont(0.5) WITHIN GROUP (
                       ORDER BY CASE WHEN net_cents > 0
                                     THEN utilidad_cents::numeric / net_cents
                                     ELSE 0 END)                          AS med_margen
            FROM prod
        )
        SELECT p.*,
               s.med_unidades,
               (s.med_margen * 100)::numeric(18,2) AS med_margen_pct,
               CASE
                   WHEN p.unidades >= s.med_unidades
                    AND (CASE WHEN p.net_cents > 0
                              THEN p.utilidad_cents::numeric / p.net_cents
                              ELSE 0 END) >= s.med_margen THEN 'ESTRELLA'
                   WHEN p.unidades >= s.med_unidades                  THEN 'CABALLO'
                   WHEN (CASE WHEN p.net_cents > 0
                              THEN p.utilidad_cents::numeric / p.net_cents
                              ELSE 0 END) >= s.med_margen             THEN 'ROMPECABEZAS'
                   ELSE 'PERRO'
               END AS cuadrante
        FROM prod p CROSS JOIN stats s
        ORDER BY p.utilidad_cents DESC
    """), params).mappings().all()

    lentos = db.session.execute(text("""
        SELECT producto, categoria, precio_mxn, unidades_30d,
               ventas_30d_mxn, ultima_fecha_venta, diagnostico
        FROM v_bola8_productos_lentos
        ORDER BY unidades_30d, producto
        LIMIT 40
    """)).mappings().all()

    productos = []
    for r in rows:
        net = int(r['net_cents'])
        cobertura = round(int(r['net_con_costo_cents']) / net * 100, 2) if net else None
        productos.append({
            'producto': r['producto'],
            'categoria': r['categoria'],
            'unidades': int(r['unidades']),
            'tickets': int(r['tickets']),
            'venta_cents': net,
            'costo_cents': int(r['costo_cents']),
            'utilidad_cents': int(r['utilidad_cents']),
            'descuento_cents': int(r['descuento_cents'] or 0),
            'margen_pct': round(int(r['utilidad_cents']) / net * 100, 2) if net else None,
            'precio_promedio_cents': int(net // r['unidades']) if r['unidades'] else 0,
            'cobertura_costo_pct': cobertura,
            'cuadrante': r['cuadrante'],
            # A 100%-margin product with no cost captured is not a Star.
            'margen_confiable': bool(cobertura and cobertura >= 50),
        })

    med_unidades = float(rows[0]['med_unidades']) if rows else 0
    med_margen = float(rows[0]['med_margen_pct']) if rows else 0

    return jsonify({
        'rango': {'from': str(date_from), 'to': str(date_to)},
        'medianas': {'unidades': med_unidades, 'margen_pct': med_margen},
        'resumen_cuadrantes': {
            q: sum(1 for p in productos if p['cuadrante'] == q)
            for q in ('ESTRELLA', 'CABALLO', 'ROMPECABEZAS', 'PERRO')
        },
        'productos': productos,
        'productos_lentos': [{
            'producto': r['producto'],
            'categoria': r['categoria'],
            'precio_cents': _cents(r['precio_mxn']),
            'unidades_30d': int(r['unidades_30d']),
            'ventas_30d_cents': _cents(r['ventas_30d_mxn']),
            'ultima_venta': str(r['ultima_fecha_venta']) if r['ultima_fecha_venta'] else None,
            'diagnostico': r['diagnostico'],
        } for r in lentos],
    })


# ── GET /api/v1/analytics/cash-flow ──────────────────────────────────────────

@analytics_bp.route('/cash-flow', methods=['GET'])
@jwt_required()
def cash_flow():
    """Drawer variance, expenses, safe drops, and the CORRECTED payment mix.

    v_bola8_kpis_diarios attributes the full ticket total to cash if either slot
    is CASH and again to card if either is CARD — a $93,541.10 (14.3%) overstate
    across 90 days. Everything here reads v_bola8_pagos_desglosados instead,
    where cash + card reconcile exactly to revenue.
    """
    denied = _guard()
    if denied:
        return denied
    date_from, date_to = _parse_range()
    params = {'f': date_from, 't': date_to}

    sesiones = db.session.execute(text("""
        SELECT session_id, fecha_mx, status, opened_at, closed_at,
               abierta_por, cerrada_por, tickets, num_gastos, num_retiros,
               fondo_inicial_mxn, efectivo_ventas_mxn, tarjeta_ventas_mxn,
               otros_ventas_mxn, ventas_totales_mxn,
               propinas_efectivo_mxn, propinas_tarjeta_mxn, propinas_pagadas_mxn,
               gastos_mxn, retiros_caja_fuerte_mxn,
               efectivo_esperado_mxn, efectivo_esperado_sin_pago_propinas_mxn,
               efectivo_contado_mxn, diferencia_mxn, diagnostico_caja
        FROM v_bola8_flujo_caja
        WHERE fecha_mx BETWEEN :f AND :t
        ORDER BY opened_at DESC
    """), params).mappings().all()

    mezcla_diaria = db.session.execute(text("""
        SELECT fecha_mx, metodo_pago,
               SUM(monto_cents)   AS monto_cents,
               SUM(propina_cents) AS propina_cents
        FROM v_bola8_pagos_desglosados
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY fecha_mx, metodo_pago
        ORDER BY fecha_mx
    """), params).mappings().all()

    # Reconciliation proof: legs must sum to ticket revenue.
    recon = db.session.execute(text("""
        SELECT (SELECT COALESCE(SUM(monto_cents), 0)
                  FROM v_bola8_pagos_desglosados
                 WHERE fecha_mx BETWEEN :f AND :t)      AS suma_pagos_cents,
               (SELECT COALESCE(SUM(total_cents), 0)
                  FROM v_bola8_tickets_cerrados
                 WHERE fecha_mx BETWEEN :f AND :t)      AS ventas_cents
    """), params).mappings().first()

    total_dif = sum(_cents(s['diferencia_mxn']) for s in sesiones
                    if s['diferencia_mxn'] is not None)
    faltantes = [s for s in sesiones
                 if s['diagnostico_caja'] in ('Faltante', 'Faltante grave')]

    return jsonify({
        'rango': {'from': str(date_from), 'to': str(date_to)},
        'resumen': {
            'sesiones': len(sesiones),
            'efectivo_ventas_cents': sum(_cents(s['efectivo_ventas_mxn']) for s in sesiones),
            'tarjeta_ventas_cents': sum(_cents(s['tarjeta_ventas_mxn']) for s in sesiones),
            'gastos_cents': sum(_cents(s['gastos_mxn']) for s in sesiones),
            'retiros_cents': sum(_cents(s['retiros_caja_fuerte_mxn']) for s in sesiones),
            'propinas_efectivo_cents': sum(_cents(s['propinas_efectivo_mxn']) for s in sesiones),
            'propinas_tarjeta_cents': sum(_cents(s['propinas_tarjeta_mxn']) for s in sesiones),
            'propinas_pagadas_cents': sum(_cents(s['propinas_pagadas_mxn']) for s in sesiones),
            'diferencia_total_cents': total_dif,
            'sesiones_con_faltante': len(faltantes),
            'faltante_total_cents': sum(_cents(s['diferencia_mxn']) for s in faltantes),
            'sesiones_ok': sum(1 for s in sesiones if s['diagnostico_caja'] == 'OK'),
            'sesiones_sobrante': sum(1 for s in sesiones if s['diagnostico_caja'] == 'Sobrante'),
        },
        'reconciliacion': {
            'suma_pagos_cents': int(recon['suma_pagos_cents']),
            'ventas_tickets_cents': int(recon['ventas_cents']),
            'diferencia_cents': int(recon['suma_pagos_cents']) - int(recon['ventas_cents']),
            'nota': 'Debe ser 0. Si no lo es, hay tickets con monto de pago inconsistente.',
        },
        'sesiones': [{
            'session_id': s['session_id'],
            'fecha': str(s['fecha_mx']),
            'status': s['status'],
            'abierta_por': s['abierta_por'],
            'cerrada_por': s['cerrada_por'],
            'tickets': int(s['tickets']),
            'fondo_inicial_cents': _cents(s['fondo_inicial_mxn']),
            'efectivo_ventas_cents': _cents(s['efectivo_ventas_mxn']),
            'tarjeta_ventas_cents': _cents(s['tarjeta_ventas_mxn']),
            'propinas_efectivo_cents': _cents(s['propinas_efectivo_mxn']),
            'propinas_tarjeta_cents': _cents(s['propinas_tarjeta_mxn']),
            'propinas_pagadas_cents': _cents(s['propinas_pagadas_mxn']),
            'gastos_cents': _cents(s['gastos_mxn']),
            'num_gastos': int(s['num_gastos']),
            'retiros_cents': _cents(s['retiros_caja_fuerte_mxn']),
            'num_retiros': int(s['num_retiros']),
            'esperado_cents': _cents(s['efectivo_esperado_mxn']),
            'esperado_sin_pago_propinas_cents':
                _cents(s['efectivo_esperado_sin_pago_propinas_mxn']),
            'contado_cents': (_cents(s['efectivo_contado_mxn'])
                              if s['efectivo_contado_mxn'] is not None else None),
            'diferencia_cents': (_cents(s['diferencia_mxn'])
                                 if s['diferencia_mxn'] is not None else None),
            'diagnostico': s['diagnostico_caja'],
        } for s in sesiones],
        'mezcla_diaria': [{
            'fecha': str(r['fecha_mx']),
            'metodo': r['metodo_pago'],
            'monto_cents': int(r['monto_cents']),
            'propina_cents': int(r['propina_cents']),
        } for r in mezcla_diaria],
    })


# ── GET /api/v1/analytics/inventory ──────────────────────────────────────────

@analytics_bp.route('/inventory', methods=['GET'])
@jwt_required()
def inventory():
    """Purchasing + shrinkage.

    v_bola8_forecast_compras is reused wholesale — it already classifies items as
    'Comprar urgente' / 'Comprar esta semana' / 'Debajo de mínimo'. Rebuilding
    that would duplicate an existing report. Both it and
    v_bola8_varianza_inventario use a fixed 28-day window, so this endpoint takes
    no date parameters by design.
    """
    denied = _guard()
    if denied:
        return denied

    compras = db.session.execute(text("""
        SELECT insumo, category, unit, stock_quantity, low_stock_threshold,
               unit_cost_mxn, supplier, consumo_neto_28d, consumo_promedio_semanal,
               dias_cobertura, sugerido_comprar_unidades,
               costo_estimado_compra_mxn, recomendacion_compra
        FROM v_bola8_forecast_compras
    """)).mappings().all()

    merma = db.session.execute(text("""
        SELECT insumo, category, unit, consumo_neto_28d, merma_declarada_28d,
               ajuste_manual_28d, ajuste_conteo_28d, eventos_no_venta,
               merma_total_unidades, merma_valorizada_mxn,
               merma_pct_sobre_consumo, diagnostico_merma
        FROM v_bola8_varianza_inventario
        WHERE merma_total_unidades > 0 OR eventos_no_venta > 0
        LIMIT 60
    """)).mappings().all()

    urgentes = [c for c in compras
                if c['recomendacion_compra'] in ('Comprar urgente', 'Comprar esta semana',
                                                 'Debajo de mínimo')]

    return jsonify({
        'ventana': '28 días (fija — definida por las vistas base)',
        'resumen': {
            'insumos': len(compras),
            'por_comprar': len(urgentes),
            'costo_compra_estimado_cents': sum(_cents(c['costo_estimado_compra_mxn'])
                                               for c in urgentes),
            'merma_valorizada_cents': sum(_cents(m['merma_valorizada_mxn']) for m in merma),
            'insumos_con_merma': sum(1 for m in merma if m['merma_total_unidades'] > 0),
        },
        'compras': [{
            'insumo': c['insumo'],
            'categoria': c['category'],
            'unidad': c['unit'],
            'stock': float(c['stock_quantity'] or 0),
            'minimo': float(c['low_stock_threshold'] or 0),
            'costo_unitario_cents': _cents(c['unit_cost_mxn']),
            'proveedor': c['supplier'],
            'consumo_28d': float(c['consumo_neto_28d'] or 0),
            'consumo_semanal': float(c['consumo_promedio_semanal'] or 0),
            'dias_cobertura': (float(c['dias_cobertura'])
                               if c['dias_cobertura'] is not None else None),
            'sugerido_comprar': float(c['sugerido_comprar_unidades'] or 0),
            'costo_estimado_cents': _cents(c['costo_estimado_compra_mxn']),
            'recomendacion': c['recomendacion_compra'],
        } for c in compras],
        'merma': [{
            'insumo': m['insumo'],
            'categoria': m['category'],
            'unidad': m['unit'],
            'consumo_28d': float(m['consumo_neto_28d'] or 0),
            'merma_declarada': float(m['merma_declarada_28d'] or 0),
            'ajuste_manual': float(m['ajuste_manual_28d'] or 0),
            'ajuste_conteo': float(m['ajuste_conteo_28d'] or 0),
            'eventos_no_venta': int(m['eventos_no_venta']),
            'merma_unidades': float(m['merma_total_unidades'] or 0),
            'merma_valorizada_cents': _cents(m['merma_valorizada_mxn']),
            'merma_pct': _pct(m['merma_pct_sobre_consumo']),
            'diagnostico': m['diagnostico_merma'],
        } for m in merma],
    })


# ── GET /api/v1/analytics/cost-coverage ──────────────────────────────────────

@analytics_bp.route('/cost-coverage', methods=['GET'])
@jwt_required()
def cost_coverage():
    """The COGS remediation worklist — the single highest-ROI screen here.

    64 of 76 active inventory items have unit_cost_cents = 0, and $468,419.70 of
    line revenue flows through them. purchase_cost_cents is 0 on all of them too,
    so nothing can be derived — the numbers must be typed in. Items are ranked by
    revenue exposure so the shortest possible list of edits recovers the most
    margin accuracy.

    After entering costs, run:  flask restate-costs
    """
    denied = _guard()
    if denied:
        return denied

    rows = db.session.execute(text("""
        SELECT inventory_item_id, insumo, category, unit, supplier,
               unit_cost_mxn, tiene_costo, lineas_expuestas,
               ventas_expuestas_mxn, ultima_venta, prioridad
        FROM v_bola8_cobertura_costo
    """)).mappings().all()

    # Line-level coverage. 'Daños' (damage recovery) and 'INGRESOS' (misc income)
    # are legitimately costless and are excluded from the denominator — otherwise
    # coverage can never reach 100% and the metric stops being trusted.
    cov = db.session.execute(text("""
        SELECT COALESCE(SUM(net_sales_cents), 0) AS net_cents,
               COALESCE(SUM(CASE WHEN total_cost_cents > 0
                                 THEN net_sales_cents ELSE 0 END), 0) AS con_costo_cents,
               COUNT(*)                                               AS lineas,
               COUNT(*) FILTER (WHERE total_cost_cents > 0)           AS lineas_con_costo
        FROM v_bola8_lineas_venta
        WHERE categoria NOT IN ('Daños', 'INGRESOS')
    """)).mappings().first()

    sin_costo = [r for r in rows if not r['tiene_costo']]
    expuesto = sum(_cents(r['ventas_expuestas_mxn']) for r in sin_costo)

    return jsonify({
        'resumen': {
            'insumos_activos': len(rows),
            'insumos_sin_costo': len(sin_costo),
            'venta_expuesta_cents': expuesto,
            'lineas': int(cov['lineas']),
            'lineas_con_costo': int(cov['lineas_con_costo']),
            'venta_evaluable_cents': int(cov['net_cents']),
            'venta_con_costo_cents': int(cov['con_costo_cents']),
            'cobertura_pct': (round(int(cov['con_costo_cents']) / int(cov['net_cents']) * 100, 2)
                              if cov['net_cents'] else None),
            'excluidas': ['Daños', 'INGRESOS'],
        },
        'accion': ('Captura unit_cost_cents para los insumos listados (mayor exposición '
                   'primero), después ejecuta `flask restate-costs` para recalcular el '
                   'histórico.'),
        'insumos': [{
            'inventory_item_id': r['inventory_item_id'],
            'insumo': r['insumo'],
            'categoria': r['category'],
            'unidad': r['unit'],
            'proveedor': r['supplier'],
            'costo_unitario_cents': _cents(r['unit_cost_mxn']),
            'tiene_costo': bool(r['tiene_costo']),
            'lineas_expuestas': int(r['lineas_expuestas']),
            'venta_expuesta_cents': _cents(r['ventas_expuestas_mxn']),
            'ultima_venta': str(r['ultima_venta']) if r['ultima_venta'] else None,
            'prioridad': r['prioridad'],
        } for r in rows],
    })


# ── GET /api/v1/analytics/profitability ──────────────────────────────────────

@analytics_bp.route('/profitability', methods=['GET'])
@jwt_required()
def profitability():
    """NET profit: gross profit minus the fixed operating costs.

    Fixed costs are charged over the CALENDAR span of the range, not over trading
    days — rent and payroll accrue on days the bar is closed too. Over the 90 days
    of sales in this database that is 104 calendar days, a 14-day difference that
    would otherwise flatter the result by ~$62k.

    The COGS caveat matters more here than anywhere else in the platform: at these
    fixed-cost levels the missing unit costs decide profit versus loss, not just
    the size of the margin. Hence `escenarios`, which recomputes net profit across
    plausible COGS rates, and `cogs_equilibrio_pct`, the rate above which the bar
    loses money.
    """
    denied = _guard()
    if denied:
        return denied
    date_from, date_to = _parse_range()
    params = {'f': date_from, 't': date_to}
    dias_calendario = (date_to - date_from).days + 1

    costos = db.session.execute(text("""
        SELECT concepto, categoria, monto_mensual_mxn, monto_diario_mxn, monto_anual_mxn
        FROM v_bola8_costos_fijos
    """)).mappings().all()
    fijo_mensual_cents = sum(_cents(c['monto_mensual_mxn']) for c in costos)
    # 30.4167 = 365/12. Decimal throughout so no float touches a peso amount.
    fijo_periodo_cents = int((Decimal(fijo_mensual_cents) * Decimal(dias_calendario)
                              / Decimal('30.4167')).to_integral_value())

    serie = db.session.execute(text("""
        SELECT fecha_mx, tickets, ventas_mxn, billar_mxn, articulos_mxn, cogs_mxn,
               utilidad_articulos_mxn, utilidad_bruta_mxn, costo_fijo_diario_mxn,
               utilidad_neta_mxn, punto_equilibrio_ventas_mxn, cobertura_costo_pct
        FROM v_bola8_rentabilidad_diaria
        WHERE fecha_mx BETWEEN :f AND :t
        ORDER BY fecha_mx
    """), params).mappings().all()

    tot = db.session.execute(text("""
        SELECT COALESCE(SUM(t.total_cents), 0)     AS ventas_cents,
               COALESCE(SUM(t.pool_time_cents), 0) AS billar_cents,
               COUNT(*)                            AS tickets,
               COUNT(DISTINCT t.fecha_mx)          AS dias_operados
        FROM v_bola8_tickets_cerrados t
        WHERE t.fecha_mx BETWEEN :f AND :t
    """), params).mappings().first()

    lin = db.session.execute(text("""
        SELECT COALESCE(SUM(net_sales_cents), 0)    AS articulos_cents,
               COALESCE(SUM(total_cost_cents), 0)   AS cogs_cents,
               COALESCE(SUM(gross_profit_cents), 0) AS utilidad_art_cents,
               COALESCE(SUM(CASE WHEN total_cost_cents > 0
                                 THEN net_sales_cents ELSE 0 END), 0) AS con_costo_cents
        FROM v_bola8_lineas_venta
        WHERE fecha_mx BETWEEN :f AND :t
    """), params).mappings().first()

    ventas = int(tot['ventas_cents'])
    billar = int(tot['billar_cents'])
    articulos = int(lin['articulos_cents'])
    utilidad_bruta = int(lin['utilidad_art_cents']) + billar
    utilidad_neta = utilidad_bruta - fijo_periodo_cents
    meses = Decimal(dias_calendario) / Decimal('30.4167')

    # What COGS rate would wipe out the profit? Billiard time has no COGS, so it
    # covers part of the nut before a single peso of product margin is needed.
    cogs_equilibrio_pct = None
    if articulos > 0:
        margen_articulos_necesario = fijo_periodo_cents - billar
        cogs_max = articulos - margen_articulos_necesario
        cogs_equilibrio_pct = round(cogs_max / articulos * 100, 1)

    escenarios = []
    for pct in (25, 30, 35, 40, 45):
        cogs_sim = int(articulos * pct / 100)
        bruta_sim = (articulos - cogs_sim) + billar
        neta_sim = bruta_sim - fijo_periodo_cents
        escenarios.append({
            'cogs_pct': pct,
            'cogs_cents': cogs_sim,
            'utilidad_bruta_cents': bruta_sim,
            'utilidad_neta_cents': neta_sim,
            'utilidad_neta_mensual_cents': int(Decimal(neta_sim) / meses) if meses else 0,
        })

    return jsonify({
        'rango': {'from': str(date_from), 'to': str(date_to),
                  'dias_calendario': dias_calendario,
                  'dias_operados': int(tot['dias_operados']),
                  'meses_equivalentes': float(round(meses, 3))},
        'costos_fijos': {
            'mensual_cents': fijo_mensual_cents,
            'diario_cents': int(Decimal(fijo_mensual_cents) / Decimal('30.4167')),
            'periodo_cents': fijo_periodo_cents,
            'conceptos': [{
                'concepto': c['concepto'],
                'categoria': c['categoria'],
                'mensual_cents': _cents(c['monto_mensual_mxn']),
                'diario_cents': _cents(c['monto_diario_mxn']),
                'anual_cents': _cents(c['monto_anual_mxn']),
            } for c in costos],
        },
        'resultado': {
            'ventas_cents': ventas,
            'articulos_cents': articulos,
            'billar_cents': billar,
            'cogs_cents': int(lin['cogs_cents']),
            'utilidad_articulos_cents': int(lin['utilidad_art_cents']),
            'utilidad_bruta_cents': utilidad_bruta,
            'costos_fijos_cents': fijo_periodo_cents,
            'utilidad_neta_cents': utilidad_neta,
            'utilidad_neta_mensual_cents': int(Decimal(utilidad_neta) / meses) if meses else 0,
            'margen_neto_pct': round(utilidad_neta / ventas * 100, 2) if ventas else None,
            'tickets': int(tot['tickets']),
            'cobertura_costo_pct': (round(int(lin['con_costo_cents']) / articulos * 100, 2)
                                    if articulos else None),
            # Share of the fixed nut that billiard time alone pays for.
            'billar_cubre_fijos_pct': (round(billar / fijo_periodo_cents * 100, 1)
                                       if fijo_periodo_cents else None),
        },
        'equilibrio': {
            'venta_diaria_necesaria_cents': (
                int(Decimal(fijo_periodo_cents) / Decimal(dias_calendario)
                    / (Decimal(utilidad_bruta) / Decimal(ventas)))
                if ventas and utilidad_bruta > 0 else None),
            'venta_diaria_actual_cents': (int(ventas / int(tot['dias_operados']))
                                          if tot['dias_operados'] else 0),
            'cogs_equilibrio_pct': cogs_equilibrio_pct,
            'nota': ('Si el COGS real supera este porcentaje de la venta de artículos, '
                     'el negocio pierde dinero.'),
        },
        'escenarios': escenarios,
        'serie_diaria': [{
            'fecha': str(r['fecha_mx']),
            'tickets': int(r['tickets']),
            'ventas_cents': _cents(r['ventas_mxn']),
            'billar_cents': _cents(r['billar_mxn']),
            'cogs_cents': _cents(r['cogs_mxn']),
            'utilidad_bruta_cents': _cents(r['utilidad_bruta_mxn']),
            'costo_fijo_cents': _cents(r['costo_fijo_diario_mxn']),
            'utilidad_neta_cents': _cents(r['utilidad_neta_mxn']),
            'equilibrio_cents': (_cents(r['punto_equilibrio_ventas_mxn'])
                                 if r['punto_equilibrio_ventas_mxn'] is not None else None),
        } for r in serie],
    })


# ── GET/PUT /api/v1/analytics/fixed-costs ────────────────────────────────────

@analytics_bp.route('/fixed-costs', methods=['GET'])
@jwt_required()
def fixed_costs_list():
    denied = _guard()
    if denied:
        return denied
    rows = db.session.execute(text("""
        SELECT id, concepto, categoria, monto_mensual_mxn, monto_diario_mxn,
               monto_anual_mxn, notas, updated_at
        FROM v_bola8_costos_fijos
    """)).mappings().all()
    return jsonify({
        'total_mensual_cents': sum(_cents(r['monto_mensual_mxn']) for r in rows),
        'conceptos': [{
            'id': r['id'],
            'concepto': r['concepto'],
            'categoria': r['categoria'],
            'mensual_cents': _cents(r['monto_mensual_mxn']),
            'diario_cents': _cents(r['monto_diario_mxn']),
            'anual_cents': _cents(r['monto_anual_mxn']),
            'notas': r['notas'],
            'updated_at': r['updated_at'].isoformat() if r['updated_at'] else None,
        } for r in rows],
    })


@analytics_bp.route('/fixed-costs/<cost_id>', methods=['PUT'])
@jwt_required()
def fixed_costs_update(cost_id):
    """Update one fixed-cost amount. Writes to the base table, not a view."""
    denied = _require_admin()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    if 'mensual_cents' not in body:
        return jsonify({'error': 'mensual_cents requerido'}), 400
    try:
        monto = int(body['mensual_cents'])
    except (TypeError, ValueError):
        return jsonify({'error': 'mensual_cents debe ser entero (centavos)'}), 400
    if monto < 0:
        return jsonify({'error': 'mensual_cents no puede ser negativo'}), 400

    result = db.session.execute(text("""
        UPDATE fixed_costs
           SET monto_cents = :m,
               notas       = COALESCE(:n, notas),
               is_active   = COALESCE(:a, is_active),
               updated_at  = now()
         WHERE id = :i
    """), {'m': monto, 'n': body.get('notas'),
           'a': body.get('is_active'), 'i': cost_id})
    if not result.rowcount:
        return jsonify({'error': 'NOT_FOUND'}), 404
    db.session.commit()
    return jsonify({'ok': True, 'id': cost_id, 'mensual_cents': monto})


# ── GET /api/v1/analytics/pool-tables ────────────────────────────────────────

@analytics_bp.route('/pool-tables', methods=['GET'])
@jwt_required()
def pool_tables():
    """Billiard earnings per table.

    Distinct from /reports/pool-time, which lists raw seconds and revenue per
    table code with no totals. This frames pool time as CONTRIBUTION: it consumes
    no inventory, so every peso is margin, and the headline number is how much of
    the monthly fixed-cost nut billiards pays for on its own.
    """
    denied = _guard()
    if denied:
        return denied
    date_from, date_to = _parse_range()
    params = {'f': date_from, 't': date_to}
    dias_calendario = (date_to - date_from).days + 1

    mesas = db.session.execute(text("""
        SELECT mesa_codigo, mesa_nombre,
               SUM(sesiones)                AS sesiones,
               SUM(tickets)                 AS tickets,
               SUM(segundos)                AS segundos,
               SUM(horas)                   AS horas,
               SUM(minutos_gratis_promo)    AS minutos_gratis,
               SUM(ingreso_cents)           AS ingreso_cents,
               SUM(sesiones_editadas)       AS sesiones_editadas,
               COUNT(DISTINCT fecha_mx)     AS dias_activa
        FROM v_bola8_billar_por_mesa
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY mesa_codigo, mesa_nombre
        ORDER BY SUM(ingreso_cents) DESC
    """), params).mappings().all()

    serie = db.session.execute(text("""
        SELECT fecha_mx,
               SUM(ingreso_cents) AS ingreso_cents,
               SUM(horas)         AS horas,
               SUM(sesiones)      AS sesiones
        FROM v_bola8_billar_por_mesa
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY fecha_mx ORDER BY fecha_mx
    """), params).mappings().all()

    por_dia_semana = db.session.execute(text("""
        SELECT dia_semana_iso,
               SUM(ingreso_cents) AS ingreso_cents,
               SUM(horas)         AS horas
        FROM v_bola8_billar_por_mesa
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY dia_semana_iso ORDER BY dia_semana_iso
    """), params).mappings().all()

    total_cents = sum(int(m['ingreso_cents']) for m in mesas)
    total_horas = sum(float(m['horas'] or 0) for m in mesas)

    # Total business revenue in the same window, to size billiards' share.
    ventas = db.session.execute(text("""
        SELECT COALESCE(SUM(total_cents), 0) AS v
        FROM v_bola8_tickets_cerrados WHERE fecha_mx BETWEEN :f AND :t
    """), params).scalar()

    fijo_mensual_cents = _cents(db.session.execute(text(
        "SELECT COALESCE(SUM(monto_mensual_mxn), 0) FROM v_bola8_costos_fijos"
    )).scalar())
    fijo_periodo_cents = int((Decimal(fijo_mensual_cents) * Decimal(dias_calendario)
                              / Decimal('30.4167')).to_integral_value())

    return jsonify({
        'rango': {'from': str(date_from), 'to': str(date_to),
                  'dias_calendario': dias_calendario},
        'resumen': {
            'ingreso_total_cents': total_cents,
            'horas_totales': round(total_horas, 2),
            'sesiones': sum(int(m['sesiones']) for m in mesas),
            'mesas_activas': len(mesas),
            'ingreso_por_hora_cents': (int(total_cents / total_horas)
                                       if total_horas else 0),
            'ingreso_diario_cents': int(total_cents / dias_calendario) if dias_calendario else 0,
            'pct_de_ventas_totales': (round(total_cents / int(ventas) * 100, 2)
                                      if ventas else None),
            # Pool time has no COGS, so this is 100% contribution.
            'cubre_costos_fijos_pct': (round(total_cents / fijo_periodo_cents * 100, 1)
                                       if fijo_periodo_cents else None),
            'costos_fijos_periodo_cents': fijo_periodo_cents,
        },
        'nota': ('El tiempo de billar no consume inventario: cada peso es margen de '
                 'contribución directo contra los costos fijos.'),
        'mesas': [{
            'mesa': m['mesa_codigo'],
            'nombre': m['mesa_nombre'],
            'sesiones': int(m['sesiones']),
            'tickets': int(m['tickets']),
            'horas': round(float(m['horas'] or 0), 2),
            'minutos_gratis_promo': round(float(m['minutos_gratis'] or 0), 2),
            'ingreso_cents': int(m['ingreso_cents']),
            'ingreso_por_hora_cents': (int(int(m['ingreso_cents']) / float(m['horas']))
                                       if m['horas'] else 0),
            'dias_activa': int(m['dias_activa']),
            'sesiones_editadas': int(m['sesiones_editadas']),
            'pct_del_billar': (round(int(m['ingreso_cents']) / total_cents * 100, 1)
                               if total_cents else 0),
        } for m in mesas],
        'serie_diaria': [{
            'fecha': str(r['fecha_mx']),
            'ingreso_cents': int(r['ingreso_cents']),
            'horas': round(float(r['horas'] or 0), 2),
            'sesiones': int(r['sesiones']),
        } for r in serie],
        'por_dia_semana': [{
            'dia_semana_iso': int(r['dia_semana_iso']),
            'ingreso_cents': int(r['ingreso_cents']),
            'horas': round(float(r['horas'] or 0), 2),
        } for r in por_dia_semana],
    })


# ── GET /api/v1/analytics/staff ──────────────────────────────────────────────

@analytics_bp.route('/staff', methods=['GET'])
@jwt_required()
def staff():
    """Per-server output.

    CAVEAT: opened_by/closed_by are TICKET actors, not per-line servers, so this
    attributes a whole ticket to whoever opened it. No schedule or wage table
    exists, so labour COST % is not computable — this measures output, not cost
    efficiency.
    """
    denied = _guard()
    if denied:
        return denied
    date_from, date_to = _parse_range()
    params = {'f': date_from, 't': date_to}

    rows = db.session.execute(text("""
        SELECT COALESCE(abrio, 'Sin asignar')                     AS empleado,
               MAX(rol_abrio)                                     AS rol,
               COUNT(*)                                           AS tickets,
               SUM(unidades)                                      AS unidades,
               SUM(round(total_mxn * 100))                        AS ventas_cents,
               SUM(round(venta_articulos_mxn * 100))              AS articulos_cents,
               SUM(round(utilidad_mxn * 100))                     AS utilidad_cents,
               SUM(round(propina_mxn * 100))                      AS propinas_cents,
               SUM(round(descuento_mxn * 100))                    AS descuentos_cents,
               SUM(round(billar_mxn * 100))                       AS billar_cents,
               AVG(duracion_min)                                  AS duracion_prom_min,
               COUNT(*) FILTER (WHERE fue_reabierto)              AS reaperturas,
               COUNT(*) FILTER (WHERE edited_after_close)         AS editados,
               COUNT(*) FILTER (WHERE manual_discount_pct > 0)    AS con_descuento
        FROM v_bola8_personal_desempeno
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY COALESCE(abrio, 'Sin asignar')
        ORDER BY SUM(round(total_mxn * 100)) DESC
    """), params).mappings().all()

    return jsonify({
        'rango': {'from': str(date_from), 'to': str(date_to)},
        'nota': ('Atribución por quien ABRIÓ el ticket (aproximación: no existe '
                 'mesero por línea). Sin tabla de turnos no se puede calcular '
                 'costo laboral.'),
        'empleados': [{
            'empleado': r['empleado'],
            'rol': r['rol'],
            'tickets': int(r['tickets']),
            'unidades': int(r['unidades'] or 0),
            'ventas_cents': int(r['ventas_cents'] or 0),
            'articulos_cents': int(r['articulos_cents'] or 0),
            'billar_cents': int(r['billar_cents'] or 0),
            'utilidad_cents': int(r['utilidad_cents'] or 0),
            'propinas_cents': int(r['propinas_cents'] or 0),
            'descuentos_cents': int(r['descuentos_cents'] or 0),
            'ticket_promedio_cents': (int((r['ventas_cents'] or 0) // r['tickets'])
                                      if r['tickets'] else 0),
            'duracion_prom_min': (round(float(r['duracion_prom_min']), 1)
                                  if r['duracion_prom_min'] is not None else None),
            'reaperturas': int(r['reaperturas']),
            'editados': int(r['editados']),
            'con_descuento': int(r['con_descuento']),
        } for r in rows],
    })


# ── GET /api/v1/analytics/anomalies ──────────────────────────────────────────

@analytics_bp.route('/anomalies', methods=['GET'])
@jwt_required()
def anomalies():
    """Voids, reopens, manual discounts and post-close edits, with an actor.

    v_bola8_lineas_venta excludes voided lines by design — correct for revenue,
    blind for risk. This is the deliberate inverse.
    """
    denied = _guard()
    if denied:
        return denied
    date_from, date_to = _parse_range()
    params = {'f': date_from, 't': date_to}

    resumen = db.session.execute(text("""
        SELECT tipo, COUNT(*) AS eventos, SUM(round(monto_mxn * 100)) AS monto_cents
        FROM v_bola8_anomalias_operativas
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY tipo ORDER BY SUM(round(monto_mxn * 100)) DESC
    """), params).mappings().all()

    por_usuario = db.session.execute(text("""
        SELECT COALESCE(usuario, 'Desconocido') AS usuario,
               tipo,
               COUNT(*) AS eventos,
               SUM(round(monto_mxn * 100)) AS monto_cents
        FROM v_bola8_anomalias_operativas
        WHERE fecha_mx BETWEEN :f AND :t
        GROUP BY COALESCE(usuario, 'Desconocido'), tipo
        ORDER BY SUM(round(monto_mxn * 100)) DESC
    """), params).mappings().all()

    detalle = db.session.execute(text("""
        SELECT tipo, ticket_id, fecha_mx, ocurrido_en, detalle, motivo,
               usuario, rol_usuario, monto_mxn
        FROM v_bola8_anomalias_operativas
        WHERE fecha_mx BETWEEN :f AND :t
        ORDER BY monto_mxn DESC, ocurrido_en DESC
        LIMIT 200
    """), params).mappings().all()

    return jsonify({
        'rango': {'from': str(date_from), 'to': str(date_to)},
        'resumen': [{
            'tipo': r['tipo'],
            'eventos': int(r['eventos']),
            'monto_cents': int(r['monto_cents'] or 0),
        } for r in resumen],
        'por_usuario': [{
            'usuario': r['usuario'],
            'tipo': r['tipo'],
            'eventos': int(r['eventos']),
            'monto_cents': int(r['monto_cents'] or 0),
        } for r in por_usuario],
        'detalle': [{
            'tipo': r['tipo'],
            'ticket_id': r['ticket_id'],
            'fecha': str(r['fecha_mx']) if r['fecha_mx'] else None,
            'ocurrido_en': r['ocurrido_en'].isoformat() if r['ocurrido_en'] else None,
            'detalle': r['detalle'],
            'motivo': r['motivo'],
            'usuario': r['usuario'],
            'rol': r['rol_usuario'],
            'monto_cents': _cents(r['monto_mxn']),
        } for r in detalle],
    })
