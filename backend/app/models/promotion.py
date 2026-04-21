import uuid
from app.extensions import db

class Promotion(db.Model):
    __tablename__ = 'promotions'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(100), nullable=False)
    promo_type = db.Column(db.String(30), nullable=False)  # HAPPY_HOUR, ITEM_DISCOUNT, BUNDLE, POOL_TIME_FREE_MINUTES
    discount_type = db.Column(db.String(20))  # PERCENTAGE, FLAT_CENTS
    discount_value = db.Column(db.Integer)
    applies_to_item_id = db.Column(db.String(36), db.ForeignKey('menu_items.id'))
    applies_to_category_id = db.Column(db.String(36), db.ForeignKey('menu_categories.id'))
    free_pool_minutes = db.Column(db.Integer)
    happy_hour_start = db.Column(db.String(5))  # 'HH:MM'
    happy_hour_end = db.Column(db.String(5))
    valid_from = db.Column(db.Date)
    valid_to = db.Column(db.Date)
    is_active = db.Column(db.Boolean, default=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'promo_type': self.promo_type,
            'discount_type': self.discount_type,
            'discount_value': self.discount_value,
            'applies_to_item_id': self.applies_to_item_id,
            'applies_to_category_id': self.applies_to_category_id,
            'free_pool_minutes': self.free_pool_minutes,
            'happy_hour_start': self.happy_hour_start,
            'happy_hour_end': self.happy_hour_end,
            'valid_from': str(self.valid_from) if self.valid_from else None,
            'valid_to': str(self.valid_to) if self.valid_to else None,
            'is_active': self.is_active
        }
