from marshmallow import Schema, fields


class LineItemModifierSchema(Schema):
    modifier_id = fields.Str(required=True)


class AddLineItemSchema(Schema):
    menu_item_id = fields.Str(required=True)
    quantity = fields.Int(load_default=1)
    modifiers = fields.List(fields.Nested(LineItemModifierSchema), load_default=[])
    notes = fields.Str(load_default=None)


class CloseTicketSchema(Schema):
    payment_type = fields.Str(required=True)
    tendered_cents = fields.Int(load_default=None)
