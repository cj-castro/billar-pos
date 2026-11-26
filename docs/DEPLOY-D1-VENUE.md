# Batch D1 (the venue: name, timezone, currency, logo) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. One migration (`045`). Ships after
040–044 and batch C.

## What changes

| | Before | After |
|---|---|---|
| Name / logo | "Bola 8" / "BOLA 8 POOL CLUB" hard-coded in the nav bar, login, receipts and cash slips; Bola 8's logo built into the app | **Ajustes → Negocio** (owner): name, logo upload, timezone, currency, language/format. Every screen and printed slip uses them. With no logo uploaded, the build's default logo is used |
| Timezone | `America/Mexico_City` hard-coded in 6 views, 2 SQL functions and ~10 Python modules | One setting (`venue.timezone`). SQL reads it through `fn_bar_tz()`, Python through `venue_svc.bar_tz()`; it decides which day every sale belongs to, happy-hour windows, the daily email and "Hoy" |
| Currency | `MXN` / `es-MX` hard-coded in the frontend | From the venue (`venue.currency`, `venue.locale`) |
| Settings permissions | **Any manager could change any setting**, including system switches (spirits auto-convert, negative-stock mode, ledger enforcement) | Managers can change only their screen preferences (KDS sound, bar printing). Everything else is owner-only; venue values are validated |
| Cash summaries | (batch C follow-up) | Managers never receive sales figures, for open or past sessions; the printed slip at close leaves the sales lines out when a manager closes |

Defaults come from the install's environment, so nothing changes until someone
edits a setting: `TZ` → timezone, `CURRENCY` → currency, `VENUE_NAME` → name
(**default "Mi Billar"**), `LOCALE` → format (default es-MX). After migrations
the app copies them into `settings` (never overwriting).

## Closing hour (migration 046)

**Ajustes → Negocio → Hora de cierre del día** (`venue.day_cutoff`, `DAY_CUTOFF`
in the environment, default `00:00`). With `06:00`, a sale at 1:30 a.m. Sunday
belongs to **Saturday** in every report, the daily email, "Hoy" and the date
presets; hourly charts keep the real clock hour. `00:00` keeps calendar days
(no change from before). Changing it re-groups history too — the views compute
the day at read time, nothing is rewritten.

## ⚠ Bola 8 step: the name

Bola 8's `.env` has no `VENUE_NAME`, so after this deploy the screens would say
**"Mi Billar"**. Do ONE of:

- add `VENUE_NAME=Bola 8 Pool Club` to `.env` **before** Phase 4 (the app copies
  it into settings on first start). This only works with the updated
  `docker-compose.yml` from this batch, which passes `VENUE_NAME` to the backend
  (compose lists each variable explicitly) — make sure the bundle includes it. Or
- after deploy: log in as owner → **Ajustes → Negocio** → Nombre → Guardar.

**Closing hour:** Bola 8 closes between 11 pm and 1 am, so use **06:00** — add
`DAY_CUTOFF=06:00` to `.env` before Phase 4 (same compose requirement as
`VENUE_NAME`), or set Ajustes → Negocio → Hora de cierre del día after deploy.
Expect Sunday/Monday totals to move back to Saturday/Sunday nights.

Timezone and currency already come from `TZ` / `CURRENCY` in `.env` — check they
read `America/Mexico_City` / `MXN` in Ajustes after deploy.

## Files

Root: `docker-compose.yml` (passes `VENUE_NAME` to the backend).

Backend: `migrations/sql/045_venue_timezone.sql`, `046_business_day.sql`, `047_drop_unused_views.sql` (+ manifest), `app/services/venue_svc.py` (new),
`app/api/settings.py` (public `/api/v1/venue`, owner-only writes, validation),
`app/__init__.py`, `app/migrations_runner.py` (env defaults after migrations),
`app/analytics_views.py`, `app/api/{analytics,reports,home,tickets,cash_session}.py`,
`app/services/{promotion_svc,email_report_svc}.py`, `tests/test_venue.py` (new), `tests/test_batch_c.py`.

Frontend: `utils/venue.ts` (new), `components/{VenueGate,VenueSettings}.tsx` (new),
`main.tsx`, `hooks/useSocket.ts`, `utils/{money,dates,printReceipt,printCashReconciliation}.ts`,
`components/NavBar.tsx`, `pages/LoginPage.tsx`, `pages/TicketPage.tsx`,
`pages/manager/{SettingsPage,ManagerDashboard,CashSessionPage}.tsx`.

## Deploy

- **Phase 3:** pending list ends with **`047`** (8 pending if everything ships together: 040–047).
  047 (batch D4) drops 14 unused views — see `DIAGNOSTIC-VIEWS.md` for the ones kept.
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler`, then `up -d`.
- **Phase 5:** backend log after migrations shows `Venue settings: N default(s) copied from the environment` (first start only).
- **Rehearsal (Mac):** fresh scratch copy with 040–045: `tests.test_venue` → `22 passed, 0 failed`.

## Smoke test

1. Login screen shows the venue name (see the Bola 8 step above).
2. Owner → Ajustes → Negocio: change the name → the nav bar updates on every connected screen.
3. Print a receipt: header shows the venue name.
4. Manager token: `PUT /api/v1/settings/spirits.auto_convert_enabled` → 403.
