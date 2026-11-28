# Deploy 2026-11-xx — cash handoff count (migration 058)

Same mechanics as `DEPLOY-WINDOWS.md` (folder, backup, rebuild, rollback).
One migration (`058`). It ships after `DEPLOY-2026-11-26-ALL.md` (057 must be applied).
**The feature ships OFF.** Nothing changes for the staff until you turn it on.

Replace `xx` in the file name and in the zip name with the deploy date.

**Bar closed. No open tickets. Internet available** (the frontend build runs `npm ci`).

This deploy also carries two web/server fixes merged to main with it: deleted
inventory items leave the list (owner sees them under "Desactivados" and can
reactivate), and the close-screen tips + fund suggestion above. Neither needs a
migration beyond 058.

**Phone app:** the phone's close still uses the old order (pay tips first, then
count, and it asks for a note whenever what stays is not $2,000). Until Girish
updates it, **managers close from the POS screen (web)**, not from the phone.

---

## What changes

| | |
|---|---|
| **Count by bill and coin** | At open and at close the manager counts the drawer by denomination ($1,000 down to $0.50). The total is computed. |
| **Tips taken out by the POS** (web) | At close the manager counts the WHOLE drawer before paying tips. The POS shows the tips to pay (floor · bar · kitchen), says which bills and coins to take out (fewest pieces, coins stay for change), and shows what is left. If the drawer cannot cover the tips, it says how much is missing. |
| **Drawer fund** | The POS suggests what stays: $2,000 (coins and small bills first), or everything when there is less than $2,000 after tips (empty envelope). No note is needed when the manager leaves what the POS suggests; a note is required otherwise. The fund amount is set in Configuración. |
| **Envelope** | The rest goes into one numbered envelope for the safe. |
| **Two slips** | The close prints two slips: the envelope slip and the "queda en caja" slip. **Both go inside the envelope.** Printing never blocks a close. |
| **Reprint** | Owner can reprint both slips from the Caja history (closes that have an envelope). The manager who closed can reprint them until the next opening. |
| **Corregir conteo** | Owner only. The old count is kept. A reason is required. Every correction is audited. |
| **Owner only** | Managers never see the expected cash or the difference **before they submit the close** (after the close they see the result, as today). They never see the opening difference, the drawer-left lines after the close, or the close note of a counted close. The owner sees the opening difference on **Inicio** and in the Caja screen. |
| **Configuración → Límites (solo dueño)** | New block "Conteo de caja por billete y moneda": the on/off switch and the fund amount. |
| **Mobile** | Same count flow in the Caja screen of the staff app. |

Schema (058): tables `cash_counts`, `cash_count_lines`, `cash_envelopes`; sequence
`cash_envelope_number_seq`; settings `cash.count_by_denomination` = `off` and
`cash.drawer_fund_cents` = `200000`. Money is in integer cents.

---

## What to tell the managers (read this aloud)

> Desde hoy la caja se cuenta billete por billete y moneda por moneda, al abrir y al cerrar.
> Antes de contar, registra en Gastos cada compra hecha con efectivo de la caja.
> Al cerrar, cuenta TODO el efectivo **antes de pagar propinas**. El sistema te dice cuánto
> pagar de propinas y con qué billetes y monedas; sácalas de la caja.
> Luego el sistema sugiere qué se queda en la caja como fondo ($2,000, o todo si no alcanza)
> y el resto va al sobre. El sistema imprime dos comprobantes:
> el del sobre y el de lo que queda en caja. Los dos van dentro del sobre, y el sobre va a la caja fuerte.
> Si cuentas $0, el sistema pide confirmación: revisa que de verdad no haya efectivo.
> Antes de cerrar no verás cuánto debería haber ni la diferencia. Cuenta lo que realmente hay.
> Después de cerrar sí ves el resultado del cierre.

---

## Phase 1 — Bundle and copy (no git on the POS)

On the Mac, after you commit and push:

```bash
cd /Users/cjcastro/devops/billar-pos
git archive --format=zip -o ~/Desktop/pos-bundle-2026-11-xx.zip HEAD -- . ':(exclude)backend/app/#*'
md5 ~/Desktop/pos-bundle-2026-11-xx.zip
```

Copy the zip to the POS. Then on the POS check it matches the Mac's md5:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS
Get-FileHash .\pos-bundle-2026-11-xx.zip -Algorithm MD5
```

Keep `.env` (do not overwrite it). Keep the folder name `billiards`: the folder name
sets the data volume, and a rename gives a blank database. Zip the old folder first
and expand the new bundle over it, as in `DEPLOY-WINDOWS.md` Phase 1.

Verify the copy:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
Test-Path .\.env                                                     # True
Test-Path .\backend\migrations\sql\058_cash_counts.sql               # True
Get-Content .\backend\migrations\sql\manifest.txt | Select-String '058'   # one line
```

---

## Phase 2 — Stop and back up

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards

docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT count(*) FROM tickets WHERE closed_at IS NULL;"   # 0
docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT count(*) FROM cash_sessions WHERE closed_at IS NULL;"   # 0 if the bar is closed

docker compose stop backend scheduler telegram-bot frontend
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Backup-Database.ps1 -Label pre-058 -KeepDays 0
```

The script runs `pg_dump -Fc` inside the container and uses `docker cp` to bring the
file out. Never pipe a dump or SQL through PowerShell: it corrupts accents (UTF-8).
Write down the `.dump` path it prints. That is the rollback.

---

## Phase 3 — Migration

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -DryRun    # expect 1 pending: 058
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -SkipBackup
```

Expect one line ending in `OK` and the six invariants **all 0**. If 058 fails it
rolls back completely. Send CJ the `ERROR` text. Do not continue.

---

## Phase 4 — Rebuild

```powershell
docker compose build --no-cache backend frontend scheduler telegram-bot
docker compose up -d
```

`build` alone restarts nothing. Always `build` **then** `up -d`.

---

## Phase 5 — Verify with the flag OFF

```powershell
docker compose ps                                       # backend healthy; frontend, scheduler, bot Up
docker compose exec backend flask migration-status      # 058 applied, 0 pending
docker compose logs backend | Select-String "Migrations:|Traceback"
docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT key, value FROM settings WHERE key LIKE 'cash.%' ORDER BY key"
```

Expect: `Migrations: 0 applied, N already present, 0 failed`, no `Traceback`,
`cash.count_by_denomination|off` and `cash.drawer_fund_cents|200000`.

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT max(version) FROM schema_migrations"    # 058
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Invoke-Migrations.ps1 -DryRun    # Nothing to do; invariants 0
```

**Reload every tablet and browser.**

### Smoke test, flag OFF (owner login, about 10 minutes)

1. Caja: open the bar with a single typed amount, as before. No count grid.
2. Add one expense in Gastos.
3. Close the bar with the old form: the expected cash, the counted cash and the difference show as before.
4. Panel de Gerente → **⚙️ Configuración** → section **"Límites (solo dueño)"** shows the new block "Conteo de caja por billete y moneda". The switch is **off**. The fund shows $2,000.
5. Nothing prints an envelope slip.

---

## Phase 6 — Install the mobile build, then turn the flag ON

**Order matters.** An old mobile app does not know the count screens. If you turn the
flag on first, managers on old phones cannot open or close the bar: the server refuses
the old form, and the old app cannot show the server's message ("Cuenta billetes y
monedas en la pantalla de Caja del POS..."). It shows only a generic error.

### 6.1 — Build and publish the app

Use the existing procedure in `mobile/README.md` (sections **Build**, **Release**,
**Update path**). In short:

1. Raise `APP_VERSION` and `APP_BUILD` in `mobile/src/config/version.ts`. `APP_VERSION` is currently `1.2.0`: set the next version (for example `1.3.0`). `APP_BUILD` is currently 5: set **6**. Set the `version` in `mobile/package.json` to the same `APP_VERSION`.
2. Set `BOLA8_KEYSTORE`, `BOLA8_KEYSTORE_PASS`, `BOLA8_KEY_ALIAS`, `BOLA8_KEY_PASS`. Use the venue keystore. A new keystore means phones cannot update in place.
3. `pwsh scripts/mobile/build-android-release.ps1` gives `mobile/dist/bola8-staff-<version>-local.apk`.
4. Copy the APK to the bar machine so nginx serves it at `/mobile/latest.apk`.
5. **Required, before 6.3:** in the staff app, owner login → **Sistema** tab → field
   **"Versión mínima requerida"** (setting `min_mobile_version`), type the new
   `APP_VERSION` (for example `1.3.0`) and save. The app compares this with its own
   `APP_VERSION` (not `APP_BUILD`). An old app then opens on the "Actualiza la app"
   screen with the download link, instead of a generic error at close. The app checks
   this when it starts, so ask every manager to close the app completely and open it again.

### 6.2 — Install on every manager phone

Open `http://<pos-host>:8080/mobile/latest.apk` on each phone (or the "Actualiza la app" screen) and install.
A phone that opens on "Actualiza la app" still has the old app: install from that screen.
In Yo (profile) check that the version and build match the new one. Do all manager phones, and the owner's.

### 6.3 — Turn it ON

Only when every manager phone is updated **and** `min_mobile_version` is set (6.1 step 5).

1. Web, owner login: Panel de Gerente → **⚙️ Configuración** → section **"Límites (solo dueño)"** → block "Conteo de caja por billete y moneda".
2. Check **Fondo que se queda en caja ($)**. Normally 2,000. Set the real amount.
3. Turn on **Contar la caja por billete y moneda al abrir y al cerrar**. Save.
4. Read the manager text above to the managers before the next open.

### 6.4 — First open and close with the flag ON

1. Open the bar with the count grid (web or phone). A $0 count asks for confirmation.
2. Close: count the drawer, count what stays, add a note if it is not the fund. Two slips print. Put both in the envelope. The result shows "Sobre #N".
3. As owner, open that close in the Caja history: it shows the envelope and the drawer-left. Try "Reimprimir sobre y queda en caja". The opening difference shows from the second night (see below).
4. As manager, check you do **not** see the expected cash or the difference **before you submit the close**, and that you never see the drawer-left lines or the opening difference. After you submit the close you **do** see the close result (expected, counted, difference), as today.

**Expected, not a bug:** the first night after you turn it on shows **no overnight
difference**. There is no earlier counted drawer to compare against. From the second
night, after the next opening, the owner sees the **Diferencia de apertura** (opening
count minus what the close left in the drawer) in two places: on **Inicio**, as a tile
next to "Último cierre de caja", and in the Caja screen (the open session's close box
and each session in the history). It is hidden while there is nothing to compare.
Closings made before the flag was on keep their old numbers.

---

## Rollback

**Turning the flag OFF is the rollback.** Panel de Gerente → **⚙️ Configuración** → **"Límites (solo dueño)"** → switch off → Save.
Open and close go back to the single-amount form at once. No restart, no restore.

- **Never delete the new tables** (`cash_counts`, `cash_count_lines`, `cash_envelopes`). They hold the real counts and the envelope numbers. They are harmless when the flag is off.
- Counts already saved stay and stay readable by the owner.
- Only if Phase 3 or 5 failed badly: `DEPLOY-WINDOWS.md` Phase 6 with the **`pre-058`** dump, restore the zip of the old folder, then `docker compose build --no-cache backend frontend` and `docker compose up -d`. Data lost is only what happened after the backup (nothing, with the bar closed).

---

## Files

Backend: `migrations/sql/058_cash_counts.sql` (+ manifest), `app/models/cash_session.py`,
`app/services/cash_count_svc.py`, `app/services/cash_handoff_svc.py`, `app/api/cash_session.py`
(open/close counts, `/cash/sessions/<id>/slips`, `/cash/sessions/<id>/recount`),
`app/api/home.py`, `app/api/settings.py`, `app/services/settings_svc.py`,
tests `test_cash_counts_schema`, `test_cash_count_svc`, `test_cash_handoff`.

Frontend: `components/CashCountGrid.tsx`, `utils/cashCount.ts`, `pages/manager/CashSessionPage.tsx`,
`pages/manager/ManagerDashboard.tsx` (Inicio: opening difference tile),
`components/OwnerLimits.tsx`, `utils/printCashReconciliation.ts`, `i18n/es.ts`, `i18n/en.ts`.

Mobile: `features/manager/cash/CountGrid.tsx`, `CashScreen.tsx`, `cashModel.ts`, `api/endpoints/cash.ts`.

High-risk areas touched: migrations and models, cash sessions. A human reviews.
