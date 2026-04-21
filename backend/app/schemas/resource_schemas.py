from marshmallow import Schema, fields


class ResourceSchema(Schema):
    id = fields.Str(dump_only=True)
    code = fields.Str(required=True)
    name = fields.Str(required=True)
    type = fields.Str(required=True)
    status = fields.Str(dump_only=True)
    is_active = fields.Bool(dump_only=True)
    sort_order = fields.Int(load_default=0)


class PoolTableConfigSchema(Schema):
    billing_mode = fields.Str(load_default='PER_MINUTE')
    rate_cents = fields.Int(required=True)
    promo_free_minutes = fields.Int(load_default=0)
