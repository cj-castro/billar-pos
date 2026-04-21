from marshmallow import Schema, fields


class MenuItemSchema(Schema):
    id = fields.Str(dump_only=True)
    category_id = fields.Str(required=True)
    name = fields.Str(required=True)
    price_cents = fields.Int(required=True)
    requires_flavor = fields.Bool(load_default=False)
    is_active = fields.Bool(dump_only=True)
    sort_order = fields.Int(load_default=0)


class MenuCategorySchema(Schema):
    id = fields.Str(dump_only=True)
    name = fields.Str(required=True)
    routing = fields.Str(required=True)
    sort_order = fields.Int(load_default=0)
