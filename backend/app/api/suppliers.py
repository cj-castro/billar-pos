import uuid
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt
from sqlalchemy.exc import IntegrityError
from ..extensions import db
from ..models.supplier import Supplier

suppliers_bp = Blueprint('suppliers', __name__)


def _require_manager():
    """Supplier records are purchasing master data, not operational data.
    Mutating them is manager/admin territory, matching menu.py, inventory.py
    and resources.py. Reads stay open to any authenticated user because the
    restock screen needs the dropdown."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


@suppliers_bp.get('')
@jwt_required()
def list_suppliers():
    suppliers = Supplier.query.filter_by(is_active=True).order_by(Supplier.name).all()
    return jsonify([s.to_dict() for s in suppliers])


@suppliers_bp.post('')
@jwt_required()
def create_supplier():
    err = _require_manager()
    if err: return err
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    if Supplier.query.filter_by(name=name).first():
        return jsonify({'error': 'Supplier already exists'}), 409
    supplier = Supplier(
        id=str(uuid.uuid4()),
        name=name,
        contact_phone=data.get('contact_phone') or None,
        notes=data.get('notes') or None,
    )
    db.session.add(supplier)
    # The pre-check above is advisory only: a concurrent request can commit the
    # same name between it and our commit. Without this the UNIQUE violation
    # escapes as a 500 and leaves the session in a failed transaction.
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'Supplier already exists'}), 409
    return jsonify(supplier.to_dict()), 201


@suppliers_bp.patch('/<supplier_id>')
@jwt_required()
def update_supplier(supplier_id):
    err = _require_manager()
    if err: return err
    supplier = Supplier.query.get_or_404(supplier_id)
    data = request.get_json() or {}
    if 'name' in data:
        name = (data['name'] or '').strip()
        if not name:
            return jsonify({'error': 'Name is required'}), 400
        supplier.name = name
    if 'contact_phone' in data:
        supplier.contact_phone = data['contact_phone'] or None
    if 'notes' in data:
        supplier.notes = data['notes'] or None
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'Supplier already exists'}), 409
    return jsonify(supplier.to_dict())


@suppliers_bp.delete('/<supplier_id>')
@jwt_required()
def delete_supplier(supplier_id):
    err = _require_manager()
    if err: return err
    supplier = Supplier.query.get_or_404(supplier_id)
    supplier.is_active = False
    db.session.commit()
    return '', 204
