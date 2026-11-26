# Deploy 2026-11-26 — everything since August (migrations 002–004 + 040–056), one go

This is the single runbook for tomorrow. It follows the phases of
`DEPLOY-WINDOWS.md` (bundle → backup → migrations → rebuild → verify → rollback)
and replaces running the 14 batch runbooks one by one. The batch runbooks
(`DEPLOY-BATCH1-INVENTORY.md` … `DEPLOY-E8-PORTIONING.md`) explain *what* each
change does; read them for detail.

**Bar closed. No open tickets. Internet available** (the frontend build runs `npm ci`).

---

## What you are deploying

| Batch | What it is | Migration |
|---|---|---|
| 1 | Bottles → shots fixes, whole numbers for counted units | 040, 041 |
| A, B, C0, C | Correct analytics, honest margins, exact unit costs, Inicio, blind cash count | 042, 043, 044 |
| D1 | Venue (name, timezone, currency, logo), closing-hour business day | 045, 046 |
| D3, D4 | One **Reportes** screen (6 pages); 14 dead views removed | 047 |
| E1 | Voids ask "¿se tiró o regresó?"; quantity changes move only the difference | 048 |
| E2 | Opened spirits in **ml**; per-bottle records; blind **Conteo de barra** | 049, 050 |
| E3 | Sunday **purchase forecast** (email + Telegram + Reportes) | 051 |
| E4 | Every purchase needs its price; no "case of 1" | 052, 053 |
| E5 | **Cortesías** and **Consumo de personal** | 054 |
| E6, E7 | **↔ Mover** lines; pool time: stop / new count / correct hours / free time | 055 |
| E8 | **🔪 Porcionar**: raw kg → packs, yield, real cost per pack | 056 |
| Girish #1 | Mobile staff app backend extensions (idempotent add / close, socket auth, health) | 002, 003, 004 |
| Girish #2 | **`backup` service**: nightly `pg_dump` to S3 (needs AWS credentials, see Phase 1.5) | — |
| Girish #3 | The backend container stops if a migration fails (instead of starting on a half schema) | — |

`003_restore_reference_data` only inserts lookup rows (movement types, reason
codes, settings) with "do nothing if present" — it never overwrites a setting.

---

## Phase 0 — Rehearsal (done on the Mac, 2026-11-25, repeated after the merge on 2026-11-26)

**After merging Girish's work (2026-11-26):** script order **20/20** (002–004 then
040–056), invariants 0, new backend boots clean; all 21 suites pass again on the
upgraded copy; his migration-exit test passes; on a **fresh install** (new pool
hall) both mobile live suites pass (13 + 21 checks). Two fixes came out of it:
fresh installs could not seed units (`unit_catalog.allows_fraction` had no
database default), and his test now sets the owner-only `waiter_can_close_ticket`
as admin.

**Final round (2026-11-26, afternoon, `main` + pesos price fields + migration-status fix):**
both upgrade paths from the production-like dump pass (script order 20/20 then
boot; startup-only 20 applied), second boot is a no-op, invariants all 0, all 21
suites + migration-exit pass on the upgraded copy, fresh install seeds and both
mobile live suites pass (31 + 21), frontend builds, no secrets in tracked files.
`flask migration-status` no longer reports 027–039 as "unknown" (they live in
the 001 squash) — expect `21/21 applied, 0 pending` on the bar machine.

Original rehearsal (before the merge):

Against a production-like copy (backup taken right before 040: schema at 039,
1,217 tickets), both upgrade orders were tested:

| Check | Result |
|---|---|
| `Invoke-Migrations.ps1` order: 040–056 with `psql -f`, old code still installed | **17/17 applied**, invariants 0 |
| New backend starts after that (`init-db`, `seed.py`, `factory-finalize`, `apply-migrations`) | exit 0, **0 pending**, analytics ready, venue copied |
| Startup-only order (new backend applies the migrations itself) | 17/17, exit 0 |
| Second restart | **0 applied**; staff orders still allowed; comps still out of sales; business-day views intact |
| The script's six invariants (drift, chain, warnings, double deductions, modifier gaps, legacy rows) | **all 0** |
| Stock vs ledger on every item; open ledger violations | 0 mismatches, 0 violations |
| Install without the `001` record (pre-squash): baseline applied on top | records `001`, data identical |
| All 21 test suites on fresh copies of the upgraded database | **352 + 168 checks, 0 failures** |
| Frontend type-check + build; 48 live API / permission checks; 11 screens | all pass |

**Optional, if there is time before opening:** repeat it with a *fresh* dump
from the POS (its data is newer than the Mac's copy) — `DEPLOY-WINDOWS.md`
Phase 0.1–0.4, then on the Mac:

```bash
cd /Users/cjcastro/devops/billar-pos
DB=billar_scratch_prod
docker exec billar-pos-postgres-1 psql -U billiard -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER billiard"
docker cp <the-pos-dump>.dump billar-pos-postgres-1:/tmp/prod.dump
docker exec billar-pos-postgres-1 pg_restore -U billiard -d $DB --no-owner /tmp/prod.dump
docker run --rm --entrypoint sh --network billar-pos_billiardbar_net -v "$PWD:/repo" -w /repo/backend \
  -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/$DB -e SECRET_KEY=rehearsal-0123456789abcdef0123456789abcdef \
  -e JWT_REFRESH_SECRET=x -e TZ=America/Mexico_City -e CURRENCY=MXN -e VENUE_NAME="Bola 8 Pool Club" -e DAY_CUTOFF=06:00 \
  -e FLASK_APP=wsgi.py billar-pos-backend -c "set -e; flask init-db; python seed.py; flask factory-finalize; flask apply-migrations" \
  | grep -E "applied|Migrations:|Traceback"
```

Expect 17 `applied` lines and `Migrations: 17 applied, 1 already present, 0 failed`.

---

## Phase 1 — Bundle and copy (no git on the POS)

Commit first (see "Commits" at the end), then build the bundle exactly as in
`DEPLOY-WINDOWS.md` 1.1. It must include the updated **`docker-compose.yml`**
(it passes `VENUE_NAME`, `DAY_CUTOFF`, `SCHEDULED_REPORTS`, `PURCHASE_FORECAST_HOUR`)
and **`telegram-bot/bot.py`**.

Phase 1.2–1.3 unchanged (keep `.env`, zip the old folder, expand over it).

**1.4 — Verify the copy** on the POS:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
Test-Path .\.env                                               # True
(Get-ChildItem .\backend\migrations\sql\*.sql).Count             # 49
(Get-Content .\backend\migrations\sql\manifest.txt | Select-String '^\d').Count   # 21
Get-FileHash .\backend\migrations\sql\manifest.txt -Algorithm MD5          # A82AD10969CFC98BE939789ABE45F1A0
Get-FileHash .\backend\migrations\sql\056_portioning.sql -Algorithm MD5   # AF81C455006E58387CE0BC8340A4E0A5
Get-FileHash .\backend\migrations\sql\003_restore_reference_data.sql -Algorithm MD5 # 4DF6176B68FB1EE75B3D62254A8A0FF9
Get-FileHash .\backend\app\__init__.py -Algorithm MD5                     # EC0C640953300A16A3BA2705143546B5
```

(Values for the merged `main` of 2026-11-26. If any of these files changes, recompute on the Mac with `md5`.)

**1.5 — Add to the POS `.env`** (do not copy the Mac's `.env`):

```
VENUE_NAME=Bola 8 Pool Club
DAY_CUTOFF=06:00
```

`SCHEDULED_REPORTS` (default `on`) and `PURCHASE_FORECAST_HOUR` (default `10`)
need no line. `SMTP_*`, `REPORT_TO`, `TELEGRAM_TOKEN`, `ADMIN_CHAT_ID` stay as they are.

**Backup to S3 (Girish #2) — decide before Phase 4.** The `backup` service needs
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET` and
`POSTGRES_PASSWORD` in `.env`. Without them it exits every minute and restarts
forever (harmless to the POS, but no backups and noisy logs).
- **Have the credentials:** add the lines to `.env`, build and start everything (Phases 4–5 as written).
- **Not yet:** leave it out — in Phase 4 do not build `backup`, and in Phase 5 start the services by name (see there).

---

## Phase 2 — Stop and back up

As `DEPLOY-WINDOWS.md` Phase 2, label **`pre-040`**:

```powershell
docker compose stop backend scheduler telegram-bot frontend
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Backup-Database.ps1 -Label pre-040 -KeepDays 0
```

Write down the `.dump` path. That is the rollback.

---

## Phase 3 — Migrations

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -DryRun     # expect 20 pending: 002–004, 040 … 056 (or 21, see below)
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -SkipBackup
```

Expect **20** lines ending in `OK` (002, 003, 004, then 040 … 056) and the six invariants **all 0**.

If the dry run lists **21** (`001_baseline_squash` first), the POS was installed
before the August squash and never recorded version `001`. That is safe: the file
detects the existing install, records `001` and changes nothing else
(rehearsed 2026-11-25 — tickets, lines, items, stock and movements identical
before and after). Notable NOTICE lines:
`046: 6 view(s) now group by business day`, `049: 5 open-spirit item(s) converted to ml`.
If a file fails it rolls back completely; send CJ the `ERROR` text (Phase 6 if needed).

---

## Phase 4 — Rebuild (includes the Telegram bot this time)

```powershell
docker compose build --no-cache backend frontend scheduler telegram-bot
# only with S3 credentials in .env:
docker compose build --no-cache backup
```

---

## Phase 5 — Start and verify

```powershell
docker compose up -d                                              # with S3 credentials
# without them:  docker compose up -d postgres backend frontend scheduler telegram-bot
docker compose ps                                   # backend healthy; scheduler/bot/frontend Up
docker compose logs backend | Select-String "Migrations:|analytics layer|Venue settings|Traceback"
```

Expect `Migrations: 0 applied, 21 already present, 0 failed`, `analytics layer ready`,
`Venue settings: N default(s) copied` (first start only), no `Traceback`.
(A line `STEP 26 ... FAILED` *before* the migrations line is harmless — the view
rebuild after migrations is the one that counts.)

```powershell
docker compose logs scheduler | Select-String "Scheduler ready"
# Scheduler ready (America/Mexico_City) — daily report 08:00; purchase forecast Sundays 10:00

docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT max(version) FROM schema_migrations"   # 056
docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT pg_get_constraintdef(oid) LIKE '%STAFF%' FROM pg_constraint WHERE conname='chk_open_ticket_has_resource'"   # t
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -DryRun   # Nothing to do; invariants 0
```

**Reload every tablet / browser** (the void dialog and many screens changed).

### Smoke test (owner login), ~10 minutes

1. Login screen and nav bar say **Bola 8 Pool Club**; nav shows 🔐 Caja fuerte · 📊 Reportes.
2. **Reportes** opens Ventas → Resumen; click the six pages.
3. Inventario → a tequila bottle row: "↳ N shots abiertos · X ml". 🍾 on a bottle asks its size (750).
4. A ticket: add a beer, send → **🎁 Cortesía** (reason + PIN) → shows $0 · 🎁; **Quitar cortesía**.
5. Same ticket: **↔ Mover** 1 item → Cuenta nueva "prueba" → it moves. Cancel the test accounts.
6. Void a line → the dialog asks the reason (list) and "¿se tiró o regresó?".
7. Floor → **🍽 Consumo de personal** → employee + reason + PIN → opens; empty → **Cancelar**.
8. A pool table: **⏹ Detener tiempo** → floor shows ⏸; **▶ Nuevo tiempo**; Descuento box → 🎱 tiempo gratis.
9. Inventario → Reabastecer: empty price → "Falta el precio".
10. Telegram: `/compras` answers with the purchase list.

---

## Phase 6 — Rollback

`DEPLOY-WINDOWS.md` Phase 6 with the **`pre-040`** dump, and restore the
`billiards-before-YYYYMMDD.zip` folder. Rebuild `backend frontend scheduler telegram-bot`.

---

## After the deploy — owner to-do (not blocking)

1. **Conteo de barra** at the first close: sets the real shelf stock (e.g. Tequila Blanco shows 19 sealed on the books).
2. **Bottle sizes** (Inventario → ✏️): all were assumed 750 ml.
3. **Portioning set-up**: `SETUP-PORTIONING-BOLA8.md` (alitas, boneless, tenders, papas francesa, papas gajo, dedos de queso, aros de cebolla).
4. **Costs, case sizes, suppliers** on items (the Sunday list and margins need them).
5. **Ajustes → Límites** (optional): owner limit for cortesías, staff allowance per day.
6. Fix the "Clamato Preparado" recipe (deducts 1 ml of Clamato).

---

## Commits (on the Mac, before Phase 1)

All of this is uncommitted on branch `fix/inventory-bottle-batch1`. Most files
carry several batches at once (`TicketPage.tsx`, `inventory.py`,
`analytics_views.py`…), so a commit per batch is not practical; two commits are:

(Done: the overhaul is commit `2c64ffb7`; Girish's `main` is merged on top, plus a
small fix commit — see the 2026-11-26 merge notes in Phase 0.)

Leave out (they are not part of this work): `.claude/` (local permissions),
`telegram-bot.zip`, `deploy/2026-08-02-email-report/`, `scripts/settings.json`,
`scripts/restoredb.md`, `scripts/CLAUDE.md`. `.env` and `backups/` are ignored by git.
