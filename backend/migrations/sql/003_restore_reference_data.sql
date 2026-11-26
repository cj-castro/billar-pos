-- ============================================================================
-- 003_restore_reference_data.sql
-- Restore reference/lookup rows that 027..039 INSERTed but the schema-only
-- 001_baseline_squash.sql dropped. Without movement_event_types every
-- inventory movement violates fk_movement_event_type (add-item 500).
--
-- Idempotent (ON CONFLICT DO NOTHING): no-op on installs that already have the
-- rows (production, migrated incrementally). Values mirror the originals:
--   028 reason codes + actions, 029 event types, 033b/035 actions,
--   027/031/032/033/034c/035/036/037/038/039 settings (031 description tweak folded in).
--
-- DOWN (manual): DELETE FROM schema_migrations WHERE version='003'; rows are
-- reference data and harmless to keep.
-- ============================================================================
BEGIN;

INSERT INTO movement_event_types (code, description_es, direction, is_legacy, requires_reason) VALUES
    ('SALE_DEDUCTION',     'Venta',                      'OUT',  false, false),
    ('SALE_CONSUMPTION',   'Venta (legado, pre-mayo)',   'OUT',  true,  false),
    ('VOID_REVERSAL',      'Reversa por cancelacion',    'IN',   false, false),
    ('RESTOCK',            'Reabasto',                   'IN',   false, false),
    ('OPENING_STOCK',      'Stock inicial',              'IN',   false, false),
    ('MANUAL_ADJUSTMENT',  'Ajuste manual',              'BOTH', false, true),
    ('COUNT_ADJUSTMENT',   'Ajuste por conteo fisico',   'BOTH', false, true),
    ('WASTE',              'Merma',                      'OUT',  false, true),
    ('BOX_OPENING',        'Apertura de caja (legado)',  'BOTH', true,  false),
    ('BOTTLE_OPENING',     'Apertura de botella (leg.)', 'BOTH', true,  false),
    ('CONVERSION_OUT',     'Conversion: origen',         'OUT',  false, false),
    ('CONVERSION_IN',      'Conversion: destino',        'IN',   false, false),
    ('PRODUCTION_CONSUME', 'Produccion: insumo',         'OUT',  false, false),
    ('PRODUCTION_YIELD',   'Produccion: rendimiento',    'IN',   false, false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO authorization_reason_codes (code,label_es,label_en,requires_text,sort_order) VALUES
    ('CUSTOMER_CHANGED_MIND','Cliente cambio de opinion','Customer changed mind', false, 10),
    ('WRONG_ITEM_ENTERED',   'Articulo mal capturado',   'Wrong item entered',     false, 20),
    ('ITEM_UNAVAILABLE',     'Producto agotado',         'Item unavailable',       false, 30),
    ('KITCHEN_ERROR',        'Error de cocina',          'Kitchen error',          false, 40),
    ('CUSTOMER_COMPLAINT',   'Queja del cliente',        'Customer complaint',     true,  50),
    ('SPILLAGE',             'Derrame / merma',          'Spillage / waste',       false, 60),
    ('COURTESY',             'Cortesia',                 'Courtesy / comp',        true,  70),
    ('PRICE_MATCH',          'Ajuste de precio',         'Price match',            true,  80),
    ('TRAINING',             'Capacitacion',             'Training',               false, 90),
    ('SYSTEM_ERROR',         'Error del sistema',        'System error',           true, 100),
    ('OTHER',                'Otro',                     'Other',                  true, 999)
ON CONFLICT (code) DO NOTHING;

INSERT INTO authorized_actions
 (action_code, description_es, category, min_role, requires_reason, reduces_value, increases_inventory) VALUES
 ('LINE_ITEM.DELETE',          'Eliminar partida del ticket',    'TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.QTY_DECREASE',    'Reducir cantidad',               'TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.VOID',            'Cancelar partida enviada',       'TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.MODIFIER_REMOVE', 'Quitar modificador (precio o inventario)','TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.PRICE_OVERRIDE',  'Cambiar precio unitario',        'TICKET','MANAGER',true, true, false),
 ('TICKET.VOID',               'Cancelar ticket completo',       'TICKET','MANAGER',true, true, true),
 ('TICKET.DISCOUNT_APPLY',     'Aplicar descuento manual',       'TICKET','MANAGER',true, true, false),
 ('TICKET.COMP',               'Cortesia / no cobrar',           'TICKET','MANAGER',true, true, true),
 ('TICKET.REOPEN',             'Reabrir ticket cerrado',         'TICKET','MANAGER',true, false,false),
 ('TICKET.TRANSFER',           'Transferir ticket a otra mesa',  'TICKET','MANAGER',false,false,false),
 ('PAYMENT.REFUND',            'Reembolso',                      'PAYMENT','MANAGER',true, true, true),
 ('INVENTORY.MANUAL_ADJUSTMENT','Ajuste manual de inventario',   'INVENTORY','MANAGER',true,false,true),
 ('INVENTORY.WASTE',           'Registrar merma',                'INVENTORY','MANAGER',true, false,false),
 ('INVENTORY.COUNT_ADJUSTMENT','Ajuste por conteo fisico',       'INVENTORY','MANAGER',true, false,true),
 ('CASH.DRAWER_OPEN_NOSALE',   'Abrir cajon sin venta',          'CASH','MANAGER',true, false,false),
 ('CASH.SESSION_CLOSE_VARIANCE','Cerrar caja con diferencia',    'CASH','MANAGER',true, false,false),
 ('CASH.SAFE_COLLECTION',      'Retiro a caja fuerte',           'CASH','MANAGER',true, false,false),
 ('PROMO.OVERRIDE',            'Forzar/anular promocion',        'PROMO','MANAGER',true, true, false),
 ('POOL.TIMER_CANCEL',         'Cancelar temporizador de mesa',  'POOL','MANAGER',true, true, false),
 ('POOL.TIME_ADJUST',          'Ajustar tiempo cobrado',         'POOL','MANAGER',true, true, false)
ON CONFLICT (action_code) DO NOTHING;

INSERT INTO authorized_actions
 (action_code, description_es, category, min_role, requires_pin, requires_reason,
  reduces_value, increases_inventory) VALUES
 ('INVENTORY.PACK_OPEN','Abrir cajetilla','INVENTORY','WAITER',false,false,false,false),
 ('INVENTORY.CONVERSION_REVERSE','Revertir apertura de botella/caja','INVENTORY','MANAGER',true,true,false,true),
 ('PRODUCTION.BATCH_CREATE','Registrar lote de produccion','INVENTORY','BAR_STAFF',false,false,false,false),
 ('PRODUCTION.VARIANCE_APPROVE','Aprobar merma fuera de rango','INVENTORY','MANAGER',true,true,false,false),
 ('PRODUCTION.BATCH_CANCEL','Cancelar lote','INVENTORY','MANAGER',true,true,false,true)
ON CONFLICT (action_code) DO NOTHING;

INSERT INTO settings (key, value) VALUES
    ('ledger.cutover_at',       '2026-06-01T00:00:00-06:00'),
    ('ledger.enforcement_mode', 'off'),
    ('ledger.reconcile_hour',   '4'),
    ('modifiers.enforce_option_stock',  'false'),
    ('modifiers.block_on_missing_rule', 'false'),
    ('modifiers.low_stock_warn_qty',    '5'),
    ('availability.low_stock_badge_qty',        '5'),
    ('availability.show_unavailable_options',   'true'),
    ('availability.block_parent_on_group_empty','true'),
    ('cigarettes.auto_convert_enabled', 'false'),
    ('cigarettes.baseline_counted_at',  ''),
    ('conversions.require_baseline',    'true'),
    ('spirits.auto_convert_enabled',    'false'),
    ('recipes.block_sale_without_recipe', 'false'),
    ('recipes.warn_on_zero_cost',         'true'),
    ('production.default_variance_warn_pct','10'),
    ('production.require_grant_above_pct','15'),
    ('production.enabled','false'),
    ('inventory.negative_stock_mode','warn'),
    ('ui.merge_identical_lines',      'true'),
    ('ui.optimistic_qty_updates',     'true'),
    ('ui.show_availability_badges',   'true'),
    ('ui.block_add_beyond_available', 'false'),
    ('ui.pin_dialog_show_target',     'true'),
    ('ui.kds_poll_fallback_seconds',  '30'),
    ('audit.retention_months','36'),
    ('audit.require_device_id','false'),
    ('audit.violation_alert_threshold','1')
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('003', '003_restore_reference_data', 'Re-seed reference rows dropped by the schema-only 001 baseline squash')
ON CONFLICT (version) DO NOTHING;

DO $$ BEGIN RAISE NOTICE '003 OK -- reference data restored (idempotent)'; END $$;
COMMIT;
