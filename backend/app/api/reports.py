import csv
import io
from datetime import datetime, timezone
from decimal import Decimal
from flask import Blueprint, request, jsonify, Response
from flask_jwt_extended import jwt_required, get_jwt
from app.extensions import db
from sqlalchemy import text

reports_bp = Blueprint('reports', __name__)


def _int(v):
    """Convert numeric DB values (int, Decimal, None) to plain int."""
    if v is None:
        return 0
    return int(v)


def require_manager():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


def parse_dates():
    from_str = request.args.get('from')
    to_str = request.args.get('to')
    from_dt = datetime.fromisoformat(from_str) if from_str else datetime(2000, 1, 1, tzinfo=timezone.utc)
    to_dt = datetime.fromisoformat(to_str) if to_str else datetime.now(timezone.utc)
    return from_dt, to_dt


@reports_bp.route('/sales', methods=['GET'])
@jwt_required()
def sales_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    sql = text("""
        SELECT
            COALESCE(mi.id, 'deleted')        as item_id,
            COALESCE(mi.name, tli.item_name)  as item_name,
            COALESCE(mc.name, '—')            as category,
            COALESCE(mc.routing, tli.routing_dest) as routing,
            SUM(tli.quantity) as units_sold,
            SUM(tli.quantity * tli.unit_price_cents) as gross_cents,
            COALESCE(SUM(lip.discount_cents), 0) as discounts_cents
        FROM ticket_line_items tli
        JOIN tickets t ON tli.ticket_id = t.id
        LEFT JOIN menu_items mi ON tli.menu_item_id = mi.id
        LEFT JOIN menu_categories mc ON mi.category_id = mc.id
        LEFT JOIN line_item_promotions lip ON lip.line_item_id = tli.id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
          AND tli.status != 'VOIDED'
        GROUP BY mi.id, COALESCE(mi.name, tli.item_name), mc.name, COALESCE(mc.routing, tli.routing_dest)
        ORDER BY gross_cents DESC
    """)
    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    return jsonify([dict(r) for r in rows])


@reports_bp.route('/pool-time', methods=['GET'])
@jwt_required()
def pool_time_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    sql = text("""
        SELECT
            r.code as table_code,
            COUNT(pts.id) as sessions,
            SUM(pts.duration_seconds) as total_seconds,
            SUM(pts.charge_cents) as revenue_cents
        FROM pool_timer_sessions pts
        JOIN resources r ON pts.resource_id = r.id
        JOIN tickets t ON pts.ticket_id = t.id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
        GROUP BY r.code
        ORDER BY revenue_cents DESC
    """)
    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    return jsonify([{
        'table_code': r['table_code'],
        'sessions': int(r['sessions'] or 0),
        'total_seconds': _int(r['total_seconds']),
        'revenue_cents': _int(r['revenue_cents']),
    } for r in rows])


@reports_bp.route('/payments', methods=['GET'])
@jwt_required()
def payments_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    # Build per-method totals that properly split split-payment tickets
    sql = text("""
        WITH ticket_data AS (
            SELECT
                payment_type,
                payment_type_2,
                total_cents,
                COALESCE(tip_cents, 0) AS tip_cents,
                COALESCE(tendered_cents, 0) AS tendered_cents,
                COALESCE(tendered_cents_2, 0) AS tendered_cents_2
            FROM tickets
            WHERE status = 'CLOSED'
              AND closed_at BETWEEN :from_dt AND :to_dt
        ),
        -- Each ticket contributes one or two rows (one per method)
        payment_rows AS (
            -- Primary payment
            SELECT
                payment_type AS method,
                CASE
                    WHEN payment_type_2 IS NOT NULL THEN tendered_cents          -- split: use actual tendered
                    ELSE total_cents                                              -- single: use bill total
                END AS amount_cents,
                CASE
                    WHEN payment_type_2 IS NOT NULL
                    THEN ROUND(tip_cents * tendered_cents::numeric / NULLIF(tendered_cents + tendered_cents_2, 0))
                    ELSE tip_cents
                END AS tip_portion,
                (payment_type_2 IS NOT NULL) AS is_split
            FROM ticket_data
            UNION ALL
            -- Secondary payment (split tickets only)
            SELECT
                payment_type_2 AS method,
                tendered_cents_2 AS amount_cents,
                ROUND(tip_cents * tendered_cents_2::numeric / NULLIF(tendered_cents + tendered_cents_2, 0)) AS tip_portion,
                TRUE AS is_split
            FROM ticket_data
            WHERE payment_type_2 IS NOT NULL
        )
        SELECT
            method AS payment_type,
            COUNT(*) AS ticket_count,
            SUM(amount_cents) AS total_cents,
            SUM(tip_portion) AS tips_cents,
            SUM(CASE WHEN is_split THEN 1 ELSE 0 END) AS split_count
        FROM payment_rows
        GROUP BY method
        ORDER BY method
    """)
    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    return jsonify([{
        'payment_type': r['payment_type'],
        'ticket_count': int(r['ticket_count'] or 0),
        'total_cents': int(r['total_cents'] or 0),
        'tips_cents': int(r['tips_cents'] or 0),
        'split_count': int(r['split_count'] or 0),
    } for r in rows])


@reports_bp.route('/modifiers', methods=['GET'])
@jwt_required()
def modifiers_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    sql = text("""
        SELECT
            m.name as modifier_name,
            mg.name as group_name,
            SUM(tli.quantity) as usage_count
        FROM line_item_modifiers lim
        JOIN modifiers m ON lim.modifier_id = m.id
        JOIN modifier_groups mg ON m.modifier_group_id = mg.id
        JOIN ticket_line_items tli ON lim.line_item_id = tli.id
        JOIN tickets t ON tli.ticket_id = t.id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
          AND tli.status != 'VOIDED'
        GROUP BY m.name, mg.name
        ORDER BY usage_count DESC
    """)
    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    return jsonify([dict(r) for r in rows])


@reports_bp.route('/staff', methods=['GET'])
@jwt_required()
def staff_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    sql = text("""
        SELECT
            u.id as user_id,
            u.name as staff_name,
            u.role as role,
            COUNT(DISTINCT t.id) as tickets_opened,
            COUNT(DISTINCT t2.id) as tickets_closed,
            COALESCE(SUM(t2.total_cents), 0) as total_sales_cents,
            COALESCE(SUM(t2.tip_cents), 0) as total_tips_cents,
            COALESCE(SUM(CASE WHEN t2.payment_type = 'CASH' THEN t2.total_cents ELSE 0 END), 0) as cash_sales_cents,
            COALESCE(SUM(CASE WHEN t2.payment_type = 'CARD' THEN t2.total_cents ELSE 0 END), 0) as card_sales_cents
        FROM users u
        LEFT JOIN tickets t ON t.opened_by = u.id
            AND t.opened_at BETWEEN :from_dt AND :to_dt
        LEFT JOIN tickets t2 ON t2.opened_by = u.id
            AND t2.status = 'CLOSED'
            AND t2.closed_at BETWEEN :from_dt AND :to_dt
        WHERE u.is_active = TRUE
        GROUP BY u.id, u.name, u.role
        HAVING COUNT(DISTINCT t.id) > 0 OR COUNT(DISTINCT t2.id) > 0
        ORDER BY total_sales_cents DESC
    """)
    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    return jsonify([{
        'user_id': r['user_id'],
        'staff_name': r['staff_name'],
        'role': r['role'],
        'tickets_opened': int(r['tickets_opened'] or 0),
        'tickets_closed': int(r['tickets_closed'] or 0),
        'total_sales_cents': _int(r['total_sales_cents']),
        'total_tips_cents': _int(r['total_tips_cents']),
        'cash_sales_cents': _int(r['cash_sales_cents']),
        'card_sales_cents': _int(r['card_sales_cents']),
    } for r in rows])


@reports_bp.route('/voids', methods=['GET'])
@jwt_required()
def voids_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    sql = text("""
        SELECT
            t.id                            AS ticket_id,
            r.code                          AS table_code,
            COALESCE(mi.name, tli.item_name)        AS item_name,
            mc.name                         AS category,
            tli.quantity,
            tli.unit_price_cents,
            tli.void_reason                 AS reason,
            tli.voided_at,
            voider.name                     AS voided_by,
            opener.name                     AS ticket_opened_by
        FROM ticket_line_items tli
        JOIN tickets t             ON tli.ticket_id = t.id
        LEFT JOIN resources r      ON r.id = t.resource_id
        LEFT JOIN menu_items mi    ON mi.id = tli.menu_item_id
        LEFT JOIN menu_categories mc ON mc.id = mi.category_id
        LEFT JOIN users voider     ON voider.id = tli.voided_by
        LEFT JOIN users opener     ON opener.id = t.opened_by
        WHERE tli.status = 'VOIDED'
          AND tli.voided_at BETWEEN :from_dt AND :to_dt
        ORDER BY tli.voided_at DESC
    """)
    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    return jsonify([dict(r) for r in rows])


@reports_bp.route('/peak-hours', methods=['GET'])
@jwt_required()
def peak_hours_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()
    sql = text("""
        SELECT
            EXTRACT(HOUR FROM closed_at AT TIME ZONE 'America/Mexico_City')::int AS hour,
            COUNT(*) AS ticket_count,
            SUM(total_cents) AS revenue_cents,
            SUM(tip_cents) AS tips_cents,
            ROUND(AVG(total_cents)) AS avg_ticket_cents
        FROM tickets
        WHERE status = 'CLOSED'
          AND closed_at BETWEEN :from_dt AND :to_dt
        GROUP BY 1
        ORDER BY 1
    """)
    rows = db.session.execute(sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    return jsonify([{
        'hour': int(r['hour']),
        'ticket_count': int(r['ticket_count'] or 0),
        'revenue_cents': _int(r['revenue_cents']),
        'tips_cents': _int(r['tips_cents']),
        'avg_ticket_cents': _int(r['avg_ticket_cents']),
    } for r in rows])


@reports_bp.route('/inventory-deletions', methods=['GET'])
@jwt_required()
def inventory_deletions_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()
    from app.models.audit import AuditLog
    from app.models.user import User

    rows = (
        AuditLog.query
        .filter(
            AuditLog.action == 'INVENTORY_ITEM_DELETED',
            AuditLog.created_at >= from_dt,
            AuditLog.created_at <= to_dt,
        )
        .order_by(AuditLog.created_at.desc())
        .all()
    )

    result = []
    for r in rows:
        snap = r.before_state or {}
        result.append({
            'deleted_at': r.created_at.isoformat() if r.created_at else None,
            'deleted_by': r.user.username if r.user else '—',
            'item_name': snap.get('name', '—'),
            'item_category': snap.get('category', '—'),
            'item_unit': snap.get('unit', '—'),
            'last_quantity': snap.get('quantity', 0),
            'reason': r.reason or '—',
            'entity_id': r.entity_id,
        })
    return jsonify(result)


@reports_bp.route('/menu-deletions', methods=['GET'])
@jwt_required()
def menu_deletions_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()
    from app.models.audit import AuditLog

    rows = (
        AuditLog.query
        .filter(
            AuditLog.action == 'MENU_ITEM_DELETED',
            AuditLog.created_at >= from_dt,
            AuditLog.created_at <= to_dt,
        )
        .order_by(AuditLog.created_at.desc())
        .all()
    )

    result = []
    for r in rows:
        snap = r.before_state or {}
        result.append({
            'deleted_at': r.created_at.isoformat() if r.created_at else None,
            'deleted_by': r.user.username if r.user else '—',
            'item_name': snap.get('name', '—'),
            'category': snap.get('category', '—'),
            'price_cents': snap.get('price_cents', 0),
            'reason': r.reason or '—',
            'entity_id': r.entity_id,
        })
    return jsonify(result)


@reports_bp.route('/charts-data', methods=['GET'])
@jwt_required()
def charts_data():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    # Daily revenue (food+drinks net of discounts, pool time, total)
    daily_sql = text("""
        SELECT
            DATE(t.closed_at AT TIME ZONE 'America/Mexico_City') AS day,
            COALESCE(SUM(tli.quantity * tli.unit_price_cents) FILTER (WHERE tli.status != 'VOIDED'), 0)
                - COALESCE(SUM(lip.discount_cents), 0) AS items_net_cents,
            COALESCE(SUM(pts.charge_cents), 0) AS pool_cents
        FROM tickets t
        LEFT JOIN ticket_line_items tli ON tli.ticket_id = t.id
        LEFT JOIN line_item_promotions lip ON lip.line_item_id = tli.id
        LEFT JOIN pool_timer_sessions pts ON pts.ticket_id = t.id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
        GROUP BY day
        ORDER BY day
    """)

    # Top 15 products by units sold
    top_sql = text("""
        SELECT
            COALESCE(mi.name, tli.item_name) AS item_name,
            COALESCE(mc.name, '—')           AS category,
            SUM(tli.quantity) AS units_sold,
            SUM(tli.quantity * tli.unit_price_cents) AS gross_cents
        FROM ticket_line_items tli
        JOIN tickets t ON tli.ticket_id = t.id
        LEFT JOIN menu_items mi ON tli.menu_item_id = mi.id
        LEFT JOIN menu_categories mc ON mi.category_id = mc.id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
          AND tli.status != 'VOIDED'
        GROUP BY COALESCE(mi.name, tli.item_name), mc.name
        ORDER BY units_sold DESC
        LIMIT 15
    """)

    # Revenue by category
    cat_sql = text("""
        SELECT
            COALESCE(mc.name, '—') AS category,
            SUM(tli.quantity * tli.unit_price_cents) AS gross_cents
        FROM ticket_line_items tli
        JOIN tickets t ON tli.ticket_id = t.id
        LEFT JOIN menu_items mi ON tli.menu_item_id = mi.id
        LEFT JOIN menu_categories mc ON mi.category_id = mc.id
        WHERE t.status = 'CLOSED'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
          AND tli.status != 'VOIDED'
        GROUP BY mc.name
        ORDER BY gross_cents DESC
    """)

    daily_rows = db.session.execute(daily_sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    top_rows   = db.session.execute(top_sql,   {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    cat_rows   = db.session.execute(cat_sql,   {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()

    def fmt_day(r):
        day = r['day']
        return str(day) if day else '—'

    return jsonify({
        'daily_revenue': [
            {
                'day': fmt_day(r),
                'items_net': round(r['items_net_cents'] / 100, 2),
                'pool': round(r['pool_cents'] / 100, 2),
                'total': round((r['items_net_cents'] + r['pool_cents']) / 100, 2),
            }
            for r in daily_rows
        ],
        'top_products': [
            {
                'item_name': r['item_name'],
                'category': r['category'],
                'units_sold': int(r['units_sold']),
                'gross': round(r['gross_cents'] / 100, 2),
            }
            for r in top_rows
        ],
        'by_category': [
            {
                'category': r['category'],
                'gross': round(r['gross_cents'] / 100, 2),
            }
            for r in cat_rows
        ],
    })


@reports_bp.route('/cigarettes', methods=['GET'])
@jwt_required()
def cigarettes_report():
    err = require_manager()
    if err: return err
    from_dt, to_dt = parse_dates()

    # Sales of cigarette items (singles sold through tickets)
    sales_sql = text("""
        SELECT
            COALESCE(mi.name, tli.item_name)                AS item_name,
            SUM(tli.quantity)                               AS units_sold,
            SUM(tli.quantity * tli.unit_price_cents)        AS gross_cents,
            MIN(tli.unit_price_cents)                       AS unit_price_cents
        FROM ticket_line_items tli
        JOIN tickets t         ON tli.ticket_id = t.id
        LEFT JOIN menu_items mi     ON tli.menu_item_id = mi.id
        LEFT JOIN menu_categories mc ON mi.category_id = mc.id
        WHERE t.status = 'CLOSED'
          AND tli.status != 'VOIDED'
          AND mc.name ILIKE '%cigar%'
          AND t.closed_at BETWEEN :from_dt AND :to_dt
        GROUP BY COALESCE(mi.name, tli.item_name)
        ORDER BY gross_cents DESC
    """)

    # Box opening events
    boxes_sql = text("""
        SELECT
            ocb.brand,
            COUNT(*)                                        AS boxes_opened,
            SUM(ocb.cigs_per_box)                          AS total_cigs_added,
            SUM(ocb.cigs_sold)                             AS total_cigs_sold,
            SUM(ocb.cigs_per_box - ocb.cigs_sold)
                FILTER (WHERE NOT ocb.is_finished)         AS cigs_remaining,
            COUNT(*) FILTER (WHERE ocb.is_finished)        AS boxes_finished,
            MIN(ocb.opened_at)                             AS first_opened,
            MAX(ocb.opened_at)                             AS last_opened
        FROM open_cigarette_boxes ocb
        WHERE ocb.opened_at BETWEEN :from_dt AND :to_dt
        GROUP BY ocb.brand
        ORDER BY boxes_opened DESC
    """)

    sales_rows = db.session.execute(sales_sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()
    boxes_rows = db.session.execute(boxes_sql, {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()

    sales_list = [{
        'item_name': r['item_name'],
        'units_sold': _int(r['units_sold']),
        'gross_cents': _int(r['gross_cents']),
        'unit_price_cents': _int(r['unit_price_cents']),
    } for r in sales_rows]
    boxes_list = [{
        'brand': r['brand'],
        'boxes_opened': int(r['boxes_opened'] or 0),
        'total_cigs_added': _int(r['total_cigs_added']),
        'total_cigs_sold': _int(r['total_cigs_sold']),
        'cigs_remaining': _int(r['cigs_remaining']),
        'boxes_finished': int(r['boxes_finished'] or 0),
        'first_opened': r['first_opened'].isoformat() if r['first_opened'] else None,
        'last_opened': r['last_opened'].isoformat() if r['last_opened'] else None,
    } for r in boxes_rows]

    return jsonify({
        'sales': sales_list,
        'boxes': boxes_list,
        'totals': {
            'gross_cents': sum(r['gross_cents'] for r in sales_list),
            'units_sold': sum(r['units_sold'] for r in sales_list),
            'boxes_opened': sum(r['boxes_opened'] for r in boxes_list),
        }
    })


@reports_bp.route('/export', methods=['GET'])
@jwt_required()
def export_report():
    err = require_manager()
    if err: return err

    report_type = request.args.get('type', 'sales')
    fmt = request.args.get('format', 'csv')

    if report_type == 'sales':
        resp = sales_report()
        data = resp.get_json()
    elif report_type == 'pool-time':
        resp = pool_time_report()
        data = resp.get_json()
    elif report_type == 'payments':
        resp = payments_report()
        data = resp.get_json()
    elif report_type == 'staff':
        resp = staff_report()
        data = resp.get_json()
    elif report_type == 'voids':
        resp = voids_report()
        data = resp.get_json()
    else:
        data = []

    if fmt == 'json':
        return jsonify(data)

    if not data:
        return Response('', mimetype='text/csv')

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=data[0].keys())
    writer.writeheader()
    writer.writerows(data)
    today = datetime.now().strftime('%Y%m%d')
    return Response(
        output.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename={report_type}_{today}.csv'}
    )
