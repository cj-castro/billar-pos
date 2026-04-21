from app.extensions import db
from app.models.inventory import InventoryItem, ModifierInventoryRule, MenuItemIngredient, StockMovement
from app.models.ticket import LineItemModifier


def check_stock_for_item(menu_item, modifiers_data: list, quantity: int = 1) -> list:
    """
    Returns a list of shortage dicts if any inventory item would go to/below 0.
    Each dict: { 'name': str, 'available': int, 'needed': int }
    Empty list means all items are in stock.
    """
    shortages = []
    needed: dict = {}  # inventory_item_id -> total needed

    # 1. Direct menu item ingredients
    for ing in MenuItemIngredient.query.filter_by(menu_item_id=menu_item.id).all():
        needed[ing.inventory_item_id] = needed.get(ing.inventory_item_id, 0) + ing.quantity * quantity

    # 2. Modifier-based rules
    from app.models.menu import Modifier
    for mod_data in modifiers_data:
        mod = Modifier.query.get(mod_data.get('modifier_id'))
        if not mod:
            continue
        for rule in ModifierInventoryRule.query.filter_by(modifier_id=mod.id).all():
            needed[rule.inventory_item_id] = needed.get(rule.inventory_item_id, 0) + rule.quantity * quantity

    for inv_id, qty_needed in needed.items():
        item = InventoryItem.query.get(inv_id)
        if item and item.quantity < qty_needed:
            shortages.append({
                'name': item.name,
                'available': item.quantity,
                'needed': qty_needed
            })

    return shortages


def consume_for_line_item(line_item, performed_by_id: str):
    """Decrement inventory for modifiers AND direct menu item ingredients."""
    # 1. Modifier-based rules (e.g., wing flavors, beer brand in michelada)
    for lim in line_item.modifiers:
        rules = ModifierInventoryRule.query.filter_by(modifier_id=lim.modifier_id).all()
        for rule in rules:
            item = InventoryItem.query.get(rule.inventory_item_id)
            if item:
                item.quantity -= rule.quantity * line_item.quantity
                mv = StockMovement(
                    inventory_item_id=item.id,
                    event_type='SALE_CONSUMPTION',
                    quantity_delta=-(rule.quantity * line_item.quantity),
                    reference_id=line_item.id,
                    performed_by=performed_by_id
                )
                db.session.add(mv)

    # 2. Direct menu item ingredients (e.g., clamato for michelada, tequila shot for margarita)
    if line_item.menu_item_id:
        ingredients = MenuItemIngredient.query.filter_by(menu_item_id=line_item.menu_item_id).all()
        for ing in ingredients:
            item = InventoryItem.query.get(ing.inventory_item_id)
            if item:
                item.quantity -= ing.quantity * line_item.quantity
                mv = StockMovement(
                    inventory_item_id=item.id,
                    event_type='SALE_CONSUMPTION',
                    quantity_delta=-(ing.quantity * line_item.quantity),
                    reference_id=line_item.id,
                    performed_by=performed_by_id
                )
                db.session.add(mv)


def reverse_for_line_item(line_item, performed_by_id: str):
    """Restore inventory for modifiers AND direct menu item ingredients on void."""
    for lim in line_item.modifiers:
        rules = ModifierInventoryRule.query.filter_by(modifier_id=lim.modifier_id).all()
        for rule in rules:
            item = InventoryItem.query.get(rule.inventory_item_id)
            if item:
                item.quantity += rule.quantity * line_item.quantity
                mv = StockMovement(
                    inventory_item_id=item.id,
                    event_type='VOID_REVERSAL',
                    quantity_delta=rule.quantity * line_item.quantity,
                    reference_id=line_item.id,
                    performed_by=performed_by_id
                )
                db.session.add(mv)

    if line_item.menu_item_id:
        ingredients = MenuItemIngredient.query.filter_by(menu_item_id=line_item.menu_item_id).all()
        for ing in ingredients:
            item = InventoryItem.query.get(ing.inventory_item_id)
            if item:
                item.quantity += ing.quantity * line_item.quantity
                mv = StockMovement(
                    inventory_item_id=item.id,
                    event_type='VOID_REVERSAL',
                    quantity_delta=ing.quantity * line_item.quantity,
                    reference_id=line_item.id,
                    performed_by=performed_by_id
                )
                db.session.add(mv)


def manual_adjust(inventory_item_id: str, qty_delta: int, reason: str, performed_by_id: str):
    item = InventoryItem.query.get(inventory_item_id)
    if not item:
        raise ValueError("Inventory item not found")
    item.quantity += qty_delta
    mv = StockMovement(
        inventory_item_id=item.id,
        event_type='MANUAL_ADJUSTMENT',
        quantity_delta=qty_delta,
        reason=reason,
        performed_by=performed_by_id
    )
    db.session.add(mv)
    return item
