import json
import re
from datetime import date

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from app.extensions import db
from app.models.promotion import Promotion, QUANTITY_PROMO_TYPES
from app.services import audit_svc

promotions_bp = Blueprint('promotions', __name__)

VALID_PROMO_TYPES = (
    'HAPPY_HOUR', 'ITEM_DISCOUNT', 'BUNDLE', 'POOL_TIME_FREE_MINUTES',
) + QUANTITY_PROMO_TYPES

# 'HH:MM' in 24-hour form, used for the promotion's time-of-day window.
_TIME_RE = re.compile(r'^([01]\d|2[0-3]):([0-5]\d)$')


def _require_manager():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


def _parse_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _apply_payload(promo: Promotion, data: dict):
    """Copy an incoming payload onto a promotion. Returns an error string or None."""
    if 'name' in data:
        name = (data.get('name') or '').strip()
        if not name:
            return 'NAME_REQUIRED'
        promo.name = name
    if 'promo_type' in data:
        promo_type = (data.get('promo_type') or '').strip().upper()
        if promo_type not in VALID_PROMO_TYPES:
            return 'INVALID_PROMO_TYPE'
        promo.promo_type = promo_type
    if 'discount_type' in data:
        discount_type = (data.get('discount_type') or '').strip().upper() or None
        if discount_type and discount_type not in ('PERCENTAGE', 'FLAT_CENTS'):
            return 'INVALID_DISCOUNT_TYPE'
        promo.discount_type = discount_type

    for field in ('discount_value', 'free_pool_minutes', 'required_quantity',
                  'free_quantity', 'discounted_quantity',
                  'max_applications_per_ticket', 'priority'):
        if field in data:
            value = data.get(field)
            setattr(promo, field, None if value is None else int(value))

    for field in ('applies_to_item_id', 'applies_to_category_id',
                  'happy_hour_start', 'happy_hour_end'):
        if field in data:
            setattr(promo, field, (data.get(field) or None))

    for field in ('is_active', 'is_stackable', 'combine_across_items',
                  'requires_confirmation'):
        if field in data:
            setattr(promo, field, bool(data.get(field)))

    if 'valid_from' in data:
        promo.valid_from = _parse_date(data.get('valid_from'))
    if 'valid_to' in data:
        promo.valid_to = _parse_date(data.get('valid_to'))

    if 'eligible_item_ids' in data:
        ids = data.get('eligible_item_ids') or []
        if not isinstance(ids, list):
            return 'INVALID_ELIGIBLE_ITEM_IDS'
        promo.eligible_item_ids = json.dumps([str(i) for i in ids]) if ids else None

    # Column defaults only materialise on INSERT, so fill them in now — that
    # way a quantity promo created with just a name, type and product is valid.
    if promo.promo_type in QUANTITY_PROMO_TYPES:
        for field, fallback in (('required_quantity', 2), ('free_quantity', 1),
                                ('discounted_quantity', 1), ('priority', 0)):
            if getattr(promo, field) is None:
                setattr(promo, field, fallback)
        if promo.is_stackable is None:
            promo.is_stackable = False
        if promo.combine_across_items is None:
            promo.combine_across_items = False
        if promo.requires_confirmation is None:
            promo.requires_confirmation = False
        if promo.promo_type == 'QTY_PERCENT_DISCOUNT' and not promo.discount_type:
            promo.discount_type = 'PERCENTAGE'

    return _validate(promo)


def _validate(promo: Promotion):
    if promo.promo_type in QUANTITY_PROMO_TYPES:
        if not (promo.required_quantity or 0) > 0:
            return 'REQUIRED_QUANTITY_MUST_BE_POSITIVE'
        if not promo.applies_to_item_id and not promo.applies_to_category_id \
                and not promo.eligible_item_id_list():
            return 'ELIGIBLE_PRODUCTS_REQUIRED'
        if promo.promo_type == 'BOGO':
            if not (promo.free_quantity or 0) > 0:
                return 'FREE_QUANTITY_MUST_BE_POSITIVE'
            if (promo.free_quantity or 0) >= (promo.required_quantity or 0):
                return 'FREE_QUANTITY_MUST_BE_LESS_THAN_REQUIRED'
        if promo.promo_type == 'QTY_PERCENT_DISCOUNT':
            if not (promo.discounted_quantity or 0) > 0:
                return 'DISCOUNTED_QUANTITY_MUST_BE_POSITIVE'
            if promo.discount_type != 'PERCENTAGE':
                return 'DISCOUNT_TYPE_MUST_BE_PERCENTAGE'
            if not 0 < (promo.discount_value or 0) <= 100:
                return 'DISCOUNT_VALUE_OUT_OF_RANGE'
        if promo.max_applications_per_ticket is not None \
                and promo.max_applications_per_ticket <= 0:
            return 'MAX_APPLICATIONS_MUST_BE_POSITIVE'
    if promo.valid_from and promo.valid_to and promo.valid_from > promo.valid_to:
        return 'INVALID_DATE_RANGE'
    # Time-of-day window: both ends required together. Equal ends would be a
    # one-minute window, which is almost certainly a mistake. start > end is
    # allowed and means the window wraps past midnight (22:00 -> 02:00).
    if bool(promo.happy_hour_start) != bool(promo.happy_hour_end):
        return 'INCOMPLETE_TIME_RANGE'
    for value in (promo.happy_hour_start, promo.happy_hour_end):
        if value and not _TIME_RE.match(value):
            return 'INVALID_TIME_FORMAT'
    if promo.happy_hour_start and promo.happy_hour_start == promo.happy_hour_end:
        return 'INVALID_TIME_RANGE'
    return None


@promotions_bp.route('', methods=['GET'])
@jwt_required()
def list_promotions():
    q = Promotion.query
    if request.args.get('active_only', 'false').lower() == 'true':
        q = q.filter(Promotion.is_active.is_(True))
    promos = q.order_by(Promotion.priority, Promotion.name).all()
    return jsonify([p.to_dict() for p in promos])


@promotions_bp.route('/<promo_id>', methods=['GET'])
@jwt_required()
def get_promotion(promo_id):
    return jsonify(Promotion.query.get_or_404(promo_id).to_dict())


@promotions_bp.route('', methods=['POST'])
@jwt_required()
def create_promotion():
    err = _require_manager()
    if err:
        return err
    data = request.get_json() or {}
    if not (data.get('name') or '').strip():
        return jsonify({'error': 'NAME_REQUIRED'}), 422
    if not data.get('promo_type'):
        return jsonify({'error': 'PROMO_TYPE_REQUIRED'}), 422

    promo = Promotion(name='', promo_type='ITEM_DISCOUNT')
    problem = _apply_payload(promo, data)
    if problem:
        return jsonify({'error': problem}), 422

    db.session.add(promo)
    db.session.flush()
    audit_svc.log(get_jwt_identity(), 'PROMOTION_CREATE', 'promotion', promo.id,
                  after=promo.to_dict())
    db.session.commit()
    return jsonify(promo.to_dict()), 201


@promotions_bp.route('/<promo_id>', methods=['PATCH'])
@jwt_required()
def update_promotion(promo_id):
    err = _require_manager()
    if err:
        return err
    promo = Promotion.query.get_or_404(promo_id)
    before = promo.to_dict()
    problem = _apply_payload(promo, request.get_json() or {})
    if problem:
        db.session.rollback()
        return jsonify({'error': problem}), 422
    audit_svc.log(get_jwt_identity(), 'PROMOTION_UPDATE', 'promotion', promo.id,
                  before=before, after=promo.to_dict())
    db.session.commit()
    return jsonify(promo.to_dict())


@promotions_bp.route('/<promo_id>', methods=['DELETE'])
@jwt_required()
def deactivate_promotion(promo_id):
    """Soft-delete: deactivate instead of hard delete to preserve ticket history."""
    err = _require_manager()
    if err:
        return err
    promo = Promotion.query.get_or_404(promo_id)
    before = promo.to_dict()
    promo.is_active = False
    audit_svc.log(get_jwt_identity(), 'PROMOTION_DEACTIVATE', 'promotion', promo.id,
                  before=before, after=promo.to_dict())
    db.session.commit()
    return jsonify({'message': 'Promotion deactivated'})
