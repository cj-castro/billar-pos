# Deploying migrations 027–039 to the Windows POS

Bola 8 · La Calma · `C:\Users\bola8lacalma\Desktop\POS\billiards`

This is a runbook. Every command here is one **you** run — nothing in this
process is automated end to end, on purpose. Work top to bottom and do not skip
Phase 0.

**Total downtime in Phase 3–5: about 15 minutes.** Do it on a closed day or
before opening, never mid-service.

---

## What is actually changing

28 SQL files in `backend/migrations/sql/`, applied in the order given by
`manifest.txt`. They add the ledger integrity layer, the authorization
framework, the KDS outbox, the unified inventory model, production batches, and
the availability engine.

**Nothing changes behaviour on day one.** Every enforcement mode ships as `off`
in the `settings` table. The migrations are schema plus reference data plus
three data corrections (the Rusa/Fresca and Combo Dogo double-deductions). You
flip enforcement on later, one setting at a time, one week apart.

Application changes riding along:

- `manager_id` is no longer accepted on quantity-reduce and void. The client
  sends the actual PIN, which the server verifies. The old parameter was
  forgeable and wrote a manager's name into the audit trail for actions they
  never performed.
- `flask apply-migrations` now runs at container startup, so a rebuilt backend
  keeps itself in sync.
- **Auto-conversion is wired.** `check_stock_for_item` now locks the
  auto-convertible parents alongside the ingredients and calls
  `fn_ensure_available`, so selling a loose cigarette can open a pack and
  selling a shot can open a bottle. **Both gates ship closed** — the code path
  exists but does nothing until you flip the settings after the count.
- `InventoryConversion` was missing from the models even though
  `api/inventory.py` imported it, so `DELETE /inventory/items/<id>` raised
  `ImportError` before it could run. Model added; the endpoint works again.

---

## Five traps, read before you start

**1. Do not rename the folder.** Compose derives the project name from the
folder name. `billiards` produces the volume `billiards_pg_data`. Rename the
folder to `billar-pos` and compose looks for `billar-pos_pg_data`, does not find
it, **creates a new empty one, and the POS boots with a blank database.** Your
real data is still there, but nothing points at it. Keep the folder named
`billiards`.

**2. Never pipe SQL or dumps through PowerShell.** Not `Get-Content x.sql |
docker exec -i psql`, not `pg_dump | Out-File`. Windows PowerShell 5.1
re-encodes with the console code page and turns `Porción` into `PorciÃ³n`. That
is the same damage the 11 mojibake rows in migration 031 had to repair, and the
old `scripts\backup-pos.ps1` does exactly this — which is why it is being
replaced. The scripts here use `docker cp` so the bytes never enter the
pipeline.

**3. `docker compose build` does not restart anything.** It builds an image; the
container keeps running the old one. Always `build` **then** `up -d`. This has
bitten this project twice.

**4. Keep your `.env`.** It is not in git and not in the copy you bring from the
Mac. If you overwrite it the POS loses its database password, JWT secrets and
SMTP config. Back it up before you touch the folder.

**5. `flask init-db` runs on every container start,** and the container restarts
at every Windows login. STEP 16 used to be able to resurrect the recipe rows
migration 032 deletes. It is now guarded to skip once `029b` is registered — but
that is why Phase 5 makes you restart and re-check. Do not skip it.

---

## Phase 0 — Rehearse on the Mac against real production data

### Already validated on 2026-08-08 — what this phase is really for

Before this runbook was written, the whole chain was rehearsed on the Mac
against `backups/pre-027-20260807-184935.sql`, a genuine pre-migration snapshot
(1,206 tickets, 76 inventory items, 95 legacy recipe rows, no
`schema_migrations` table):

- all 28 migrations applied cleanly through the same runner the POS uses, every
  assertion passing, ~0.9 s of database time total
- all six invariants zero afterwards
- `init-db` re-run on top changed nothing — `insumos_base` held at 103 rows
- the STEP 16 guard was proven to *fire*, not merely to be a no-op: a legacy
  recipe row was planted that the old code would have resurrected (verified: it
  would have inserted exactly 1 row), and after `init-db` the count was still
  103 with 0 double-deductions
- failure handling verified — missing manifest, unreachable database, and a
  deliberately broken migration all exit 0 with a clear message, so the POS
  always boots; `--strict` correctly exits 1; a fixed migration re-runs and the
  suite resumes exactly where it stopped

So the mechanism is known good. **Phase 0 is not testing the migrations — it is
testing them against YOUR CURRENT production data,** which has moved on since
that snapshot. That is the part nobody can verify in advance.

**Do not skip this.** The migrations carry roughly 60 hard assertions tuned to
the dev copy (`031c` asserts *exactly* 11 bottle-service options; `031b` asserts
*exactly* 3 michelada rules). Production has kept selling since that copy was
taken. If any assertion disagrees with production reality, the file aborts and
rolls back — safe, but you do not want to discover it at the bar.

### 0.1 — Take a dump on the Windows machine

On the POS, in PowerShell:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Backup-Database.ps1 -Label rehearsal -KeepDays 0
```

If `scripts\deploy\` does not exist yet on that machine, copy it there first —
see Phase 1. Note the `.dump` path it prints.

### 0.2 — Get the file onto the Mac

USB stick, or from the Mac over the network. Then confirm it arrived intact:

```powershell
# Windows
Get-FileHash "C:\...\backups\db_rehearsal_YYYYMMDD_HHMMSS.dump" -Algorithm MD5
```

```bash
# Mac — these two must match
md5 ~/Downloads/db_rehearsal_YYYYMMDD_HHMMSS.dump
```

### 0.3 — Load it into a scratch database

```bash
cd /Users/cjcastro/devops/billar-pos
DUMP=~/Downloads/db_rehearsal_YYYYMMDD_HHMMSS.dump

docker exec billar-pos-postgres-1 psql -U billiard -d postgres \
  -c "DROP DATABASE IF EXISTS rehearsal;"
docker exec billar-pos-postgres-1 psql -U billiard -d postgres \
  -c "CREATE DATABASE rehearsal OWNER billiard;"

docker cp "$DUMP" billar-pos-postgres-1:/tmp/rehearsal.dump
docker exec billar-pos-postgres-1 \
  pg_restore -U billiard -d rehearsal --no-owner --no-privileges /tmp/rehearsal.dump
```

`pg_restore` exiting 1 on ownership warnings is fine. Confirm it looks like
production:

```bash
docker exec billar-pos-postgres-1 psql -U billiard -d rehearsal -tA -c "
SELECT 'tickets    : '||count(*) FROM tickets;
SELECT 'items      : '||count(*) FROM inventory_items;
SELECT 'movements  : '||count(*) FROM inventory_movements;
SELECT 'migrations : '||CASE WHEN to_regclass('public.schema_migrations') IS NULL
                             THEN 'table absent (expected)'
                             ELSE (SELECT count(*)::text FROM schema_migrations) END;"
```

`migrations : table absent (expected)` is the normal answer — production has not
been migrated yet. (`to_regclass` is required here; a plain
`SELECT ... FROM schema_migrations` fails to even parse when the table is
missing, which is exactly the case you are testing for.)

### 0.4 — Run the full suite against it

```bash
cd backend/migrations/sql
PG="docker exec -i billar-pos-postgres-1 psql -U billiard -d rehearsal" ./run_all.sh
```

**This is the real test.** Every one of the 28 files must print `OK`, and the
six invariants at the bottom must all read `0`.

If a file fails, it printed the `ERROR` line and rolled itself back. Send that
error to CJ. The production data differs from dev in some way the assertion was
written to catch — that is the assertion doing its job, and it is far better to
see it here than on the POS.

### 0.5 — Prove it survives a restart

The one failure mode that does not show up in step 0.4: `init-db` running again
and undoing something.

```bash
cd /Users/cjcastro/devops/billar-pos
docker compose run --rm \
  -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/rehearsal \
  backend flask init-db

docker exec billar-pos-postgres-1 psql -U billiard -d rehearsal -tA -c "
SELECT 'double deductions  : '||count(*) FROM v_recipe_modifier_overlap;
SELECT 'legacy recipe rows : '||count(*) FROM menu_item_ingredients;
SELECT 'migrations applied : '||count(*) FROM schema_migrations;"
```

Use the real `POSTGRES_PASSWORD` from `.env` in that URL.

Required: `0`, `0`, `28`. A non-zero "double deductions" means STEP 16 put the
rows back and the deploy must stop.

### 0.6 — Prove apply-migrations is a no-op the second time

```bash
docker compose run --rm \
  -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/rehearsal \
  backend flask apply-migrations
```

Must report `0 applied, 28 already present, 0 failed`. This is the exact command
the container runs at every startup, so this is what the POS will do on every
Windows login from now on.

If instead it reports failures, note that the runner still exits 0 by design —
read the summary line, do not rely on the exit code. `flask migration-status`
lists exactly which versions are pending.

### 0.7 — Clean up

```bash
docker exec billar-pos-postgres-1 psql -U billiard -d postgres -c "DROP DATABASE rehearsal;"
docker exec billar-pos-postgres-1 rm -f /tmp/rehearsal.dump
```

**Only proceed to Phase 1 once 0.4, 0.5 and 0.6 all pass.**

---

## Phase 1 — Get the code onto the Windows machine (no git)

The POS has no git, so this is a file copy. Do it with a zip so line endings and
UTF-8 bytes are preserved exactly.

### 1.1 — Build the bundle on the Mac

```bash
cd /Users/cjcastro/devops/billar-pos
BUNDLE=~/Desktop/pos-bundle-$(date +%Y%m%d).zip
rm -f "$BUNDLE"

zip -r "$BUNDLE" . \
  -x '*.git/*' -x '*/node_modules/*' -x '*/__pycache__/*' \
  -x '*/.DS_Store' -x 'backups/*' -x '.env' -x '*/dist/*' -x '*/.venv/*'

md5 "$BUNDLE"
ls -lh "$BUNDLE"
```

`.env` is deliberately excluded. The POS keeps its own.

Record the checksums of the files that matter most:

```bash
md5 backend/migrations/sql/*.sql | tail -30
```

### 1.2 — Copy across and preserve what is already there

USB stick or network share. On the POS, **before unpacking anything**:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS

# Keep the .env and the whole current folder. This is your code-level rollback.
Copy-Item .\billiards\.env .\env-backup-$(Get-Date -f yyyyMMdd).txt
Compress-Archive -Path .\billiards -DestinationPath .\billiards-before-$(Get-Date -f yyyyMMdd).zip -Force
```

### 1.3 — Unpack over the existing folder

```powershell
cd C:\Users\bola8lacalma\Desktop\POS
Expand-Archive -Path .\pos-bundle-YYYYMMDD.zip -DestinationPath .\billiards -Force
```

`-Force` overwrites tracked files and leaves `.env` and `backups\` untouched
because they are not in the zip.

### 1.4 — Verify the copy

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards

# .env must still be there
Test-Path .\.env

# All 28 migrations plus the manifest
(Get-ChildItem .\backend\migrations\sql\*.sql).Count      # expect 28
Test-Path .\backend\migrations\sql\manifest.txt

# Byte-for-byte match against the Mac
Get-FileHash .\backend\migrations\sql\031c_bottle_service_options.sql -Algorithm MD5
Get-FileHash .\backend\entrypoint.sh -Algorithm MD5
```

Compare those two hashes with the Mac's `md5` output from 1.1. If they differ,
the transfer altered the files — re-copy, do not proceed.

---

## Phase 2 — Stop the POS and back up

Bar closed. No open tickets.

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards

# Confirm nothing is mid-sale
docker compose exec postgres psql -U billiard -d billiardbar -tA -c `
  "SELECT count(*) FROM tickets WHERE closed_at IS NULL;"
```

If that is not `0`, close them in the POS first.

```powershell
# Stop the apps. Postgres stays up — we need it for the backup and migrations.
docker compose stop backend scheduler telegram-bot frontend

powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Backup-Database.ps1 -Label pre-027 -KeepDays 0
```

The script verifies the archive with `pg_restore --list` before declaring
success. **Write down the `.dump` path it prints** — that is your rollback.

---

## Phase 3 — Apply the migrations

Dry run first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -DryRun
```

Expect 28 pending. Then for real:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -SkipBackup
```

`-SkipBackup` because Phase 2 already took one.

Watch for:

- a `checksum verified` line — the SQL reached the container unaltered
- 28 lines each ending in `OK`
- the six invariants, **all zero**

If a file fails, the script stops and tells you how many applied. That file
rolled back completely; the database is consistent at the previous migration.
Send CJ the `ERROR` text. You can either retry after a fix or roll back
(Phase 6) — there is no rush and nothing is half-written.

---

## Phase 4 — Rebuild the images from scratch

No cache, so nothing stale survives:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards

docker compose build --no-cache backend frontend scheduler telegram-bot
```

This takes 5–15 minutes; the frontend runs `npm ci` and a Vite build. It needs
internet. If `npm ci` fails on network, you cannot proceed — the frontend must
be rebuilt for the PIN change.

---

## Phase 5 — Start and verify

```powershell
docker compose up -d
```

`build` alone would have left the old containers running. This is the step that
was missed twice before.

### 5.1 — Containers healthy

```powershell
docker compose ps
```

`postgres`, `backend`, `frontend` must be `running`/`healthy`. (`scheduler` is a
known separate issue — do not let it block you.)

### 5.2 — Startup did not undo anything

```powershell
docker compose logs backend --tail=60
```

Look for, in order:

- `STEP 16 skipped: 029b retired menu_item_ingredients`
- `Database already seeded, skipping.`
- `Migrations: 0 applied, 28 already present, 0 failed`

`28 already present` is the point — the backend saw the work was done and left
it alone.

If STEP 13 prints `unmapped unit values defaulting to 'pieza'`, note which
values and tell CJ. A mass or volume unit landing in that list means an item is
being counted in pieces instead of grams.

### 5.3 — Invariants after restart

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -tA -c @"
SELECT 'drift               : '||count(*) FROM v_ledger_reconciliation WHERE is_drifted;
SELECT 'chain breaks        : '||count(*) FROM fn_ledger_scan_chain();
SELECT 'double deductions   : '||count(*) FROM v_recipe_modifier_overlap;
SELECT 'modifier gaps       : '||count(*) FROM v_modifier_coverage_gaps;
SELECT 'legacy recipe rows  : '||count(*) FROM menu_item_ingredients;
SELECT 'migrations applied  : '||count(*) FROM schema_migrations;
"@
```

First five must be `0`. Last must be `28`.

### 5.4 — Enforcement really is off

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -c `
  "SELECT key, value FROM settings WHERE key LIKE '%mode%' OR key LIKE '%enforce%' OR key LIKE '%block%' ORDER BY key;"
```

Expected on a fresh deploy — **two of these are deliberately not `off`:**

| key | expected | why |
|---|---|---|
| `ledger.enforcement_mode` | `off` | ladder step 1, not started |
| `auth.enforcement_mode` | `off` | ladder step 2 |
| `kds.enforcement_mode` | `off` | ladder step 3 |
| `modifiers.enforce_option_stock` | `false` | ladder step 5 |
| `modifiers.block_on_missing_rule` | `false` | ladder |
| `recipes.block_sale_without_recipe` | `false` | ladder step 7 |
| `ui.block_add_beyond_available` | `false` | ladder |
| `cigarettes.auto_convert_enabled` | `false` | ladder step 4a — pack → loose |
| `spirits.auto_convert_enabled` | `false` | ladder step 4b — bottle → shot |
| `inventory.negative_stock_mode` | **`warn`** | logs to `ledger_violations`, blocks nothing |
| `availability.block_parent_on_group_empty` | **`true`** | correct behaviour, and inert until the app calls `fn_product_availability` |

`warn` and `true` there are not a misconfiguration. Nothing blocks a sale
tonight.

### 5.5 — Smoke test in the browser

Hard-refresh first (`Ctrl+Shift+R`). Then:

1. Open a ticket, add an item — quantity goes up, stock goes down.
2. Press `−` on a line — **a PIN prompt must appear.** Enter a manager PIN; the
   quantity drops. Enter a wrong PIN; it is rejected. If it reduces with *no*
   prompt, the frontend is stale — you are on the old bundle.
3. Void a line — same PIN prompt.
4. With Fresca at zero, open a Rusa. The product must stay sellable with the
   Fresca option greyed out. Previously the whole product was blocked. This is
   issue (d) and it is the most visible improvement of the whole release.
5. Print a ticket. Confirm the print agent still responds.

### 5.6 — Twenty minutes of real use

Ring up a few real sales. Then:

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -c `
  "SELECT violation_type, count(*) FROM ledger_violations WHERE resolved_at IS NULL GROUP BY 1;"
```

**Read this by type — an empty result is not the pass condition.**

- `NEGATIVE_STOCK` — **expected, do not panic.** Migration 031b wired 34
  modifiers that previously deducted nothing, and 19 new items sit at 0 awaiting
  the physical count. The moment someone orders wings with a sauce that has
  never been counted, stock goes negative and this logs it. That is the system
  telling you which items need counting, which is exactly its job. Mode is
  `warn`, so nothing is blocked.
- `STOCK_MISMATCH`, `CHAIN_BREAK`, `NULL_TIMESTAMP` — **must be zero.** Any of
  these means a movement is being written that the ledger cannot reconcile.
  Capture it and stop.

To see which items are driving the negative-stock warnings:

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -c `
  "SELECT i.name, i.stock_quantity FROM inventory_items i WHERE i.is_active AND i.stock_quantity < 0 ORDER BY i.stock_quantity;"
```

Every name on that list belongs on the count sheet.

---

## Phase 6 — Rollback

You only need this if Phase 3 failed badly or Phase 5 verification failed.

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Restore-Database.ps1 `
  -DumpFile "C:\Users\bola8lacalma\Desktop\POS\billiards\backups\db_pre-027_YYYYMMDD_HHMMSS.dump"
```

It stops the app containers, drops and recreates the database, restores, and
leaves everything stopped so you can check the counts.

**Roll the code back too**, otherwise the rebuilt backend re-applies all 28
migrations at startup:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS
Remove-Item .\billiards -Recurse -Force
Expand-Archive -Path .\billiards-before-YYYYMMDD.zip -DestinationPath . -Force
cd .\billiards
docker compose build --no-cache backend frontend
docker compose up -d
```

Data loss is limited to whatever was sold between the Phase 2 backup and the
rollback — which should be nothing, because the bar is closed.

---

## After the deploy: what is still pending

Deploying does not finish the project. Still open:

**The physical count.** 41 items need a real count before any enforcement can be
switched on. `Marlboro Blanco Caja` reads 378 and is probably under 20. Nineteen
items created by these migrations sit at 0 deliberately — inventing numbers
would corrupt the ledger the migrations just secured.

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -c `
  "SELECT * FROM v_items_pending_count ORDER BY name;"
```

**The enforcement ladder.** One flip per week, in this order, each a single
`UPDATE settings`, each rollable back the same way with no redeploy:

1. ledger → `warn`, then `enforce`
2. authorization
3. KDS deltas
4. **auto-conversion, in two separate steps:**
   `cigarettes.auto_convert_enabled` first (pack → loose, 3 conversions), then
   `spirits.auto_convert_enabled` (bottle → shot, 5 conversions) only once the
   spirit items have counts — migration 034b created them all at stock 0.
   Migration 039 split these deliberately: before it, one flag named
   "cigarettes" also auto-opened tequila, whisky and vodka bottles. An opened
   bottle cannot go back to the supplier, so that must never be a side effect.
5. modifier option stock
6. negative-stock block
7. recipe blocking
8. production

**Application code** that the schema is still waiting on: single-delta movements
instead of reverse-then-reconsume, KDS outbox writes and consumers (the emit is
still `socketio.emit('kitchen:update', {})` with an empty payload), merge-on-add
for the `+`/`−` stepper, per-option greying in the UI via `fn_option_availability`,
and `device_id`/`location` on `audit_svc.log()` calls.

The availability wiring is **done** — `check_stock_for_item` now locks
convertible parents and calls `fn_ensure_available`. Verified against a clone of
production: with the gate open, selling 15 loose Marlboro Rojo when only 14
existed opened exactly one pack (12 → 11), took loose to 34, wrote the
`CONVERSION_OUT`/`CONVERSION_IN` pair against the ordering user, and left drift,
chain breaks and violations all at 0.

**Two loose ends** logged separately: the `scheduler` container is unhealthy so
the nightly reconciliation does not run, and `.env` line 40 reads
`TELEGRAM_TOKEN: ...` with a colon instead of `=`, so compose never passes it
and the bot has been running with an empty token. That token is also sitting in
plaintext — rotate it via BotFather when you fix the `=`.

---

## Quick reference

| Task | Command (from the project folder) |
|---|---|
| Backup | `.\scripts\deploy\Backup-Database.ps1 -Label manual` |
| What is pending | `.\scripts\deploy\Invoke-Migrations.ps1 -DryRun` |
| Apply | `.\scripts\deploy\Invoke-Migrations.ps1` |
| Restore | `.\scripts\deploy\Restore-Database.ps1 -DumpFile <path>` |
| Migration status | `docker compose exec backend flask migration-status` |
| Invariants | see Phase 5.3 |
| Logs | `docker compose logs backend --tail=60` |

Container names are resolved through `docker compose ps -q postgres`, never
hardcoded — so these work whatever the folder is called. But see trap 1: the
folder still must stay `billiards` or the data volume changes identity.
