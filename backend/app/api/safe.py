from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity
from app.extensions import db
from sqlalchemy import text

safe_bp = Blueprint('safe', __name__)


def _require_admin():
    claims = get_jwt()
    if claims.get('role') != 'ADMIN':
        return jsonify({'error': 'Solo un administrador puede acceder a las colectas de caja fuerte.'}), 403
    return None


@safe_bp.route('', methods=['GET'])
@jwt_required()
def list_collections():
    err = _require_admin()
    if err: return err

    from_str = request.args.get('from')
    to_str   = request.args.get('to')
    from_dt  = datetime.fromisoformat(from_str) if from_str else datetime(2000, 1, 1, tzinfo=timezone.utc)
    to_dt    = datetime.fromisoformat(to_str)   if to_str   else datetime.now(timezone.utc)

    rows = db.session.execute(text("""
        SELECT sc.id, sc.amount_cents, sc.notes, sc.created_at,
               u.name AS collector_name, u.username AS collector_username
        FROM safe_collections sc
        JOIN users u ON u.id = sc.collected_by
        WHERE sc.created_at BETWEEN :from_dt AND :to_dt
        ORDER BY sc.created_at DESC
    """), {'from_dt': from_dt, 'to_dt': to_dt}).mappings().all()

    return jsonify([dict(r) for r in rows])


@safe_bp.route('', methods=['POST'])
@jwt_required()
def create_collection():
    err = _require_admin()
    if err: return err

    user_id = get_jwt_identity()
    data    = request.get_json()

    amount_cents = data.get('amount_cents')
    if not amount_cents or amount_cents <= 0:
        return jsonify({'error': 'Monto inválido.'}), 400

    db.session.execute(text("""
        INSERT INTO safe_collections (amount_cents, collected_by, notes)
        VALUES (:amount, :uid, :notes)
    """), {'amount': amount_cents, 'uid': user_id, 'notes': data.get('notes')})
    db.session.commit()

    # Return the just-inserted row
    row = db.session.execute(text("""
        SELECT sc.id, sc.amount_cents, sc.notes, sc.created_at,
               u.name AS collector_name, u.username AS collector_username
        FROM safe_collections sc
        JOIN users u ON u.id = sc.collected_by
        WHERE sc.collected_by = :uid
        ORDER BY sc.created_at DESC LIMIT 1
    """), {'uid': user_id}).mappings().first()

    return jsonify(dict(row)), 201


@safe_bp.route('/<collection_id>', methods=['DELETE'])
@jwt_required()
def delete_collection(collection_id):
    err = _require_admin()
    if err: return err

    result = db.session.execute(
        text("DELETE FROM safe_collections WHERE id = :id"), {'id': collection_id}
    )
    if result.rowcount == 0:
        return jsonify({'error': 'No encontrado.'}), 404
    db.session.commit()
    return jsonify({'ok': True})


@safe_bp.route('/summary', methods=['GET'])
@jwt_required()
def summary():
    err = _require_admin()
    if err: return err

    from_str = request.args.get('from')
    to_str   = request.args.get('to')
    from_dt  = datetime.fromisoformat(from_str) if from_str else datetime(2000, 1, 1, tzinfo=timezone.utc)
    to_dt    = datetime.fromisoformat(to_str)   if to_str   else datetime.now(timezone.utc)

    row = db.session.execute(text("""
        SELECT
            COUNT(*)         AS total_collections,
            COALESCE(SUM(amount_cents), 0) AS total_amount_cents
        FROM safe_collections
        WHERE created_at BETWEEN :from_dt AND :to_dt
    """), {'from_dt': from_dt, 'to_dt': to_dt}).mappings().first()

    return jsonify(dict(row))
