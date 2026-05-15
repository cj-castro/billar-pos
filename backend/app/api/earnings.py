from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt
from sqlalchemy import text
from app.extensions import db
from app.config import Config
from zoneinfo import ZoneInfo
from datetime import datetime, timezone

LOCAL_TZ = ZoneInfo(Config.TZ)

earnings_bp = Blueprint('earnings', __name__)


def _require_admin():
    claims = get_jwt()
    if claims.get('role') != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


def _parse_dates():
    """Same tz-aware date parsing as reports.py."""
    from_str = request.args.get('from')
    to_str = request.args.get('to')
    today = datetime.now(LOCAL_TZ).date()
    if from_str:
        naive = datetime.fromisoformat(from_str)
        from_dt = naive.replace(tzinfo=LOCAL_TZ).astimezone(timezone.utc)
    else:
        from_dt = datetime(today.year, today.month, today.day, tzinfo=LOCAL_TZ).astimezone(timezone.utc)
    if to_str:
        naive = datetime.fromisoformat(to_str)
        to_dt = naive.replace(tzinfo=LOCAL_TZ).astimezone(timezone.utc)
    else:
        to_dt = datetime(today.year, today.month, today.day, 23, 59, 59, tzinfo=LOCAL_TZ).astimezone(timezone.utc)
    return from_dt, to_dt


def _int(v):
    if v is None:
        return 0
    return int(v)


# Shared CTE used by all three sub-routes.
# net_gross_cents: line revenue after proportional discount (ticket.discount_cents
# is distributed across line items by their share of subtotal_cents).
# Falls back to gross_cents when subtotal is zero (prevents division by zero).
_RECIPE_CTE = """
WITH recipe_cost AS (
    SELECT
        ib.menu_item_id,
        SUM(ib.quantity * ii.unit_cost_cents) AS unit_cost_cents
    FROM insumos_base ib
    JOIN inventory_items ii ON ii.id = ib.inventory_item_id
    GROUP BY ib.menu_item_id
),
line_costs AS (
    SELECT
        tli.id                                          AS line_item_id,
        tli.ticket_id,
        tli.menu_item_id,
        tli.item_name,
        tli.quantity,
        tli.unit_price_cents,
        t.ticket_type,
        tli.quantity * tli.unit_price_cents             AS gross_cents,
        COALESCE(
            ROUND(
                tli.quantity * tli.unit_price_cents
                * (t.subtotal_cents - COALESCE(t.discount_cents, 0))::numeric
                / NULLIF(t.subtotal_cents, 0)::numeric
            ),
            tli.quantity * tli.unit_price_cents
        )                                               AS net_gross_cents,
        COALESCE(
            tli.cost_snapshot_cents,
            tli.quantity * rc.unit_cost_cents,
            0
        )                                               AS cogs_cents,
        CASE
            WHEN COALESCE(tli.cost_snapshot_cents, rc.unit_cost_cents) IS NULL
            THEN tli.item_name
        END                                             AS no_cost_item
    FROM ticket_line_items tli
    JOIN tickets t ON tli.ticket_id = t.id
    LEFT JOIN recipe_cost rc ON rc.menu_item_id = tli.menu_item_id
    WHERE t.status = 'CLOSED'
      AND t.closed_at BETWEEN :from_dt AND :to_dt
      AND tli.status != 'VOIDED'
)
"""


@earnings_bp.route('', methods=['GET'])
@jwt_required()
def earnings_summary():
    err = _require_admin()
    if err: return err
    from_dt, to_dt = _parse_dates()

    sql = text(_RECIPE_CTE + """
        SELECT
            COALESCE(SUM(net_gross_cents), 0)       AS ingresos_cents,
            COALESCE(SUM(CASE WHEN ticket_type != 'DELIVERY' THEN net_gross_cents ELSE 0 END), 0)
                                                    AS ingresos_barra_cents,
            COALESCE(SUM(CASE WHEN ticket_type = 'DELIVERY'  THEN net_gross_cents ELSE 0 END), 0)
                                                    AS ingresos_rappi_cents,
            COALESCE(SUM(cogs_cents), 0)            AS cogs_cents,
            COALESCE(SUM(net_gross_cents - cogs_cents), 0) AS ganancia_cents,
            array_agg(DISTINCT no_cost_item)
                FILTER (WHERE no_cost_item IS NOT NULL) AS items_sin_costo
        FROM line_costs
    """)

    # Pool revenue (no COGS)
    pool_sql = text("""
        SELECT COALESCE(SUM(pts.charge_cents), 0) AS pool_cents
        FROM pool_timer_sessions pts
        JOIN tickets t ON t.id = pts.ticket_id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
          AND pts.charge_cents IS NOT NULL
    """)

    row = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().one()
    pool_row = db.session.execute(pool_sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().one()

    ingresos_rappi = _int(row['ingresos_rappi_cents'])
    ingresos_barra = _int(row['ingresos_barra_cents']) + _int(pool_row['pool_cents'])
    ingresos = ingresos_barra + ingresos_rappi
    cogs = _int(row['cogs_cents'])
    ganancia = ingresos - cogs
    margen = round((ganancia / ingresos * 100), 2) if ingresos > 0 else 0.0
    items_sin_costo = [x for x in (row['items_sin_costo'] or []) if x]

    return jsonify({
        'from': from_dt.astimezone(LOCAL_TZ).date().isoformat(),
        'to': to_dt.astimezone(LOCAL_TZ).date().isoformat(),
        'ingresos_cents': ingresos,
        'ingresos_barra_cents': ingresos_barra,
        'ingresos_rappi_cents': ingresos_rappi,
        'cogs_cents': cogs,
        'ganancia_cents': ganancia,
        'margen_pct': margen,
        'pool_cents': _int(pool_row['pool_cents']),
        'items_sin_costo': items_sin_costo,
        'items_sin_costo_count': len(items_sin_costo),
    })


@earnings_bp.route('/by-category', methods=['GET'])
@jwt_required()
def earnings_by_category():
    err = _require_admin()
    if err: return err
    from_dt, to_dt = _parse_dates()

    sql = text(_RECIPE_CTE + """
        SELECT
            COALESCE(mc.name, '— Sin categoría')   AS category,
            COALESCE(SUM(lc.net_gross_cents), 0)    AS ingresos_cents,
            COALESCE(SUM(lc.cogs_cents), 0)         AS cogs_cents,
            COALESCE(SUM(lc.net_gross_cents - lc.cogs_cents), 0) AS ganancia_cents
        FROM line_costs lc
        LEFT JOIN menu_items mi ON mi.id = lc.menu_item_id
        LEFT JOIN menu_categories mc ON mc.id = mi.category_id
        GROUP BY mc.name
        ORDER BY ingresos_cents DESC
    """)

    pool_sql = text("""
        SELECT COALESCE(SUM(pts.charge_cents), 0) AS pool_cents
        FROM pool_timer_sessions pts
        JOIN tickets t ON t.id = pts.ticket_id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
          AND pts.charge_cents IS NOT NULL
    """)

    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    pool_row = db.session.execute(pool_sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().one()
    pool_cents = _int(pool_row['pool_cents'])

    result = [
        {
            'category': r['category'],
            'ingresos_cents': _int(r['ingresos_cents']),
            'cogs_cents': _int(r['cogs_cents']),
            'ganancia_cents': _int(r['ganancia_cents']),
        }
        for r in rows
    ]

    if pool_cents > 0:
        result.append({
            'category': 'Billar',
            'ingresos_cents': pool_cents,
            'cogs_cents': 0,
            'ganancia_cents': pool_cents,
            'note': 'Sin costo de insumos',
        })

    # Totals row
    total_ingresos = sum(r['ingresos_cents'] for r in result)
    total_cogs = sum(r['cogs_cents'] for r in result)
    total_ganancia = total_ingresos - total_cogs

    return jsonify({
        'rows': result,
        'total': {
            'ingresos_cents': total_ingresos,
            'cogs_cents': total_cogs,
            'ganancia_cents': total_ganancia,
            'margen_pct': round(total_ganancia / total_ingresos * 100, 2) if total_ingresos > 0 else 0.0,
        }
    })


@earnings_bp.route('/by-staff', methods=['GET'])
@jwt_required()
def earnings_by_staff():
    err = _require_admin()
    if err: return err
    from_dt, to_dt = _parse_dates()

    sql = text(_RECIPE_CTE + """
        SELECT
            u.id                                        AS user_id,
            u.name                                      AS staff_name,
            COALESCE(SUM(lc.net_gross_cents), 0)        AS ingresos_cents,
            COALESCE(SUM(lc.cogs_cents), 0)             AS cogs_cents,
            COALESCE(SUM(lc.net_gross_cents - lc.cogs_cents), 0) AS ganancia_cents
        FROM line_costs lc
        JOIN tickets t ON t.id = lc.ticket_id
        JOIN users u ON u.id = t.opened_by
        WHERE u.is_active = TRUE
        GROUP BY u.id, u.name
        ORDER BY ingresos_cents DESC
    """)

    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()

    result = [
        {
            'user_id': r['user_id'],
            'staff_name': r['staff_name'],
            'ingresos_cents': _int(r['ingresos_cents']),
            'cogs_cents': _int(r['cogs_cents']),
            'ganancia_cents': _int(r['ganancia_cents']),
            'margen_pct': round(
                _int(r['ganancia_cents']) / _int(r['ingresos_cents']) * 100, 2
            ) if _int(r['ingresos_cents']) > 0 else 0.0,
        }
        for r in rows
    ]

    total_ingresos = sum(r['ingresos_cents'] for r in result)
    total_cogs = sum(r['cogs_cents'] for r in result)
    total_ganancia = total_ingresos - total_cogs

    return jsonify({
        'rows': result,
        'total': {
            'ingresos_cents': total_ingresos,
            'cogs_cents': total_cogs,
            'ganancia_cents': total_ganancia,
            'margen_pct': round(total_ganancia / total_ingresos * 100, 2) if total_ingresos > 0 else 0.0,
        }
    })
