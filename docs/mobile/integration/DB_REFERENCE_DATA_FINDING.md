# DB reference data lost in baseline squash

## Symptom
Local stack (project `billarmobile`, API :8090). `POST /tickets/<id>/items` for an item with
inventory rules (Chicken Wings + mandatory flavour modifier) returned 500. Items with no rules (Soda) worked.

Backend log:
```
psycopg2.errors.ForeignKeyViolation: insert or update on table "inventory_movements"
violates foreign key constraint "fk_movement_event_type"
DETAIL: Key (event_type)=(SALE_DEDUCTION) is not present in table "movement_event_types".
```
`SELECT count(*) FROM movement_event_types;` returned 0.

## Root cause (genuine clean-install defect)
Commit 2b72b157 squashed migrations 027..039 into `backend/migrations/sql/001_baseline_squash.sql`.
The baseline is a schema-only snapshot (tables, columns, constraints, views; generator:
`scripts/gen_baseline_squash.py`, no INSERT of reference rows). The manifest no longer applies
027..039, so their reference-data INSERTs never run on a clean install:

- `029_unified_inventory_model.sql:44-59` seeds the 14 `movement_event_types`; the baseline only has
  `CREATE TABLE` (001_baseline_squash.sql:393) and the FK `fk_movement_event_type` (:4965).
- `028_authorization_framework.sql:43,82` -> `authorization_reason_codes` (11), `authorized_actions` (20).
- `033b_pack_open_and_baseline.sql:54`, `035_production_batches.sql:148` -> 5 more `authorized_actions`.
- Settings keys from 027, 031, 032, 033, 034c, 035, 036, 037, 038, 039 (28 keys).

Nothing else repopulates them: init-db (`app/__init__.py`) and `factory-finalize` do not touch these
tables, and there is no `seed.py` under backend/app.

## Other affected tables (row counts in local DB before fix)
Fixed (reference data): `movement_event_types` 0, `authorization_reason_codes` 0, `authorized_actions` 0,
`settings` 2 (only print_bar_tickets, kds_sound_enabled).
Not fixed, by design (tenant/menu-specific data, not generic reference): `insumos_base` 0,
`inventory_conversions` 0, `production_recipes` / `production_recipe_inputs` 0, `inventory_pack_lots` 0
(029/029b/031c/033c/034*/035b INSERT menu-specific rows keyed to a real menu; they need the factory
template menu, not a generic seed). `unit_catalog` (16) is populated by init-db.

## Production impact
Production was migrated incrementally (027..039 applied before the squash), so it most likely has all
rows. Check on the bar machine (read-only):
```sql
SELECT count(*) FROM movement_event_types;      -- expect 14
SELECT count(*) FROM authorization_reason_codes; -- expect 11
SELECT count(*) FROM authorized_actions;         -- expect 25
```
Migration 003 is `ON CONFLICT DO NOTHING`, so applying it there is a no-op. Risk is only on
fresh installs / factory-template machines built from the squashed baseline.

## Fix applied (repo)
- New `backend/migrations/sql/003_restore_reference_data.sql` (idempotent, mirrors the original INSERTs;
  031's description tweak for `LINE_ITEM.MODIFIER_REMOVE` folded in; records version `003`).
- Registered in `backend/migrations/sql/manifest.txt` (stem, CRLF like the rest).
- Local stack rebuilt with the start script's env (the image bakes migrations in):
  `FRONTEND_PORT=8090 SECRET_KEY=mobile-dev-secret-key JWT_REFRESH_SECRET=mobile-dev-refresh-secret POSTGRES_PASSWORD=mobile_dev_pg docker compose -p billarmobile up -d --build postgres backend frontend`
  (or just run `scripts/mobile/start-local-backend.ps1`).

## Verification
- Backend log: `003_restore_reference_data  003 OK ...`, `Migrations: 1 applied, 2 already present, 0 failed`.
- Counts after: movement_event_types 14, authorization_reason_codes 11, authorized_actions 25, settings 30.
- Wings add (Chicken Wings + flavour) -> HTTP 201; `inventory_movements` got `SALE_DEDUCTION -1.0000`.
  Ticket force-closed afterwards.
- `python -m tests.test_mobile_extensions_live` (from backend/): ALL PASSED.
- `scripts/verify_clean_install.sh` NOT run: it calls `docker compose exec` without `-p billarmobile`
  (and reads the production DB name), so it targets the compose project derived from the cwd rather than
  the isolated stack. Run it separately against a known-safe project.
- Note: `test_manifest_baseline.py` asserts on a throwaway manifest, not the real one; not re-run.

## Rollback
Remove the `003_restore_reference_data` line from manifest.txt and delete the file. On a DB that already
applied it: `DELETE FROM schema_migrations WHERE version='003';` (rows are reference data; keeping them is
harmless, and deleting `movement_event_types` rows would re-break inventory movement inserts).
Longer term: have `gen_baseline_squash.py` emit the reference-table INSERTs so future squashes keep them.
