import uuid
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required
from ..extensions import db
from ..models.supplier import Supplier

suppliers_bp = Blueprint('suppliers', __name__)


@suppliers_bp.get('')
@jwt_required()
def list_suppliers():
    suppliers = Supplier.query.filter_by(is_active=True).order_by(Supplier.name).all()
    return jsonify([s.to_dict() for s in suppliers])


@suppliers_bp.post('')
@jwt_required()
def create_supplier():
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
    db.session.commit()
    return jsonify(supplier.to_dict()), 201


@suppliers_bp.patch('/<supplier_id>')
@jwt_required()
def update_supplier(supplier_id):
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
    db.session.commit()
    return jsonify(supplier.to_dict())


@suppliers_bp.delete('/<supplier_id>')
@jwt_required()
def delete_supplier(supplier_id):
    supplier = Supplier.query.get_or_404(supplier_id)
    supplier.is_active = False
    db.session.commit()
    return '', 204
