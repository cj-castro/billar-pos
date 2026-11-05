# Mobile POS Companion — Project State

Source of truth for progress. Recoverable without chat history.

- **Worktree:** `D:/Projects/Code/billar-pos-worktrees/mobile-pos-companion`
- **Branch:** `feature/mobile-pos-companion` (from `main` @ `4e4430ff`). Local commits only. Never push.
- **Main checkout** `D:/Projects/Code/billar-pos` is off-limits (has user's uncommitted `.planning/ e2e/ electron/ installer/`).

## Current phase

Phase 1 — Product / Architecture / Design / Environment (parallel). Phase 0 discovery DONE.

## Locked decisions (orchestrator)

| ID | Decision | Rationale |
|---|---|---|
| D1 | **Expo (React Native) + TypeScript**, app in `mobile/`. Expo Router, TanStack Query, zustand, socket.io-client, i18next (reuse web `es`/`en` objects), expo-secure-store. | Web stack is React/TS/zustand/TanStack/socket.io/i18next → max reuse; one codebase Android + iOS; local Gradle builds on Windows; iOS later on Mac. |
| D2 | **Local builds only** (`expo prebuild` + Gradle `assembleDebug`, `expo run:android`). **No EAS cloud builds, no store publishing.** | Rule 2 (no remote). |
| D3 | Backend authority stays server-side. Mobile never computes authoritative totals, pool charges, or payment rules; timer amounts labelled "estimate". | Business rules doc §D/§G. |
| D4 | **No payment settlement in v1.** Waiter may *request bill* (`POST /tickets/<id>/request-payment`) and view total. Closing/charging stays on bar POS. | Safety; close/card flows lack server amount checks. |
| D5 | **Order composition = local draft → explicit "Send" (Enviar).** Server creates lines as SENT immediately (no staged step), so the draft lives on device (persisted) until Send posts each line. | Matches waiter mental model; avoids accidental kitchen sends. |
| D6 | **Duplicate-order prevention:** each draft line gets a UUID `Idempotency-Key`; backend extension (B1) dedupes. Send button disabled while in flight. | No idempotency in API (G13). |
| D7 | Offline: reads served from last-known cache with "offline / last updated" banner; **no mutation is queued offline**; draft order persists locally; Send requires connectivity and retries same keys. | Mandate §7. |
| D8 | Connectivity: configurable server URL (`http://<host>:8080`) entered on first launch, validated via `GET /api/v1/health`; stored locally; no hardcoded IP. Real-time via Socket.IO through nginx; TanStack refetch on reconnect/foreground. | Only nginx :8080 published. |
| D9 | Roles → entry: WAITER → Floor; KITCHEN_STAFF → KDS(kitchen); BAR_STAFF → KDS(bar); MANAGER → Ops overview (+ floor/KDS read); ADMIN → Ops + Admin diagnostics. Unknown role → access denied screen. | Mirrors web login redirect. |
| D10 | Manager-gated actions use existing server checks: void / qty-decrease send manager `pin`; discount requires MANAGER JWT (+ PIN UX via `/auth/verify-pin`). Mobile hides manager actions from other roles. | Business rules §E/§F/§K. |
| D11 | Design: **Claude Design not used** — all design artifacts produced locally (HTML/CSS prototypes + screenshots in `docs/mobile/design/`) to keep everything local. Dark theme, derived from web palette (slate surfaces, sky accent). Spanish-first copy. | Mandate §8 fallback; Rule 2. |
| D12 | Tests: Jest (jest-expo) + React Native Testing Library for unit/integration; contract tests against the **real local backend** (docker project `billarmobile`, port 8090); E2E with **Maestro** on emulator if it runs on this Windows host, else documented fallback. | Prefer real backend over mocks. |
| D13 | Mock adapter exists only for unit tests / offline demo, clearly labelled ("DEMO DATA" banner); never selected silently. | Mandate §7. |

## Backend extensions (worktree only, local; must be deployed to bar machine to take effect)

| ID | Change | Status |
|---|---|---|
| B1 | `POST /tickets/<id>/items` honours `Idempotency-Key` header: nullable `ticket_line_items.client_request_id` + partial unique index (new SQL migration); duplicate key → 200 with existing line. Response adds `ticket_version`. | planned |
| B2 | `kitchen:item_update` / `bar:item_update` / `ticket:item_status` payloads additionally carry `ticket_id, resource_code, menu_item_name, quantity, opened_by` (additive). | planned |
| B3 | `PATCH /queue/<item>/status` rejects items that are VOIDED (409 `ITEM_VOIDED`) — no other behaviour change. | planned |
| B4 | Socket `join` actually joins `manager` room after token check (G2 fix). | planned |

Mobile must degrade gracefully if B1/B2 absent (feature-detect: missing `ticket_version` → refetch ticket after send).

## Workstreams

| WS | Owner persona | Output | Status |
|---|---|---|---|
| Discovery | Explore (haiku) | `docs/mobile/discovery/*` | DONE (DEPENDENCIES_AND_GAPS pending in Product WS) |
| Env | DevOps Automator | `scripts/mobile/*`, `docs/mobile/architecture/LOCAL_DEV_ENVIRONMENT.md`, emulator `billar_mobile_api35` (emulator-5554, AVD in `D:\android-avd`), backend http://localhost:8090 (emulator: http://10.0.2.2:8090) | DONE |
| Product | Product Manager | `docs/mobile/product/*`, `discovery/DEPENDENCIES_AND_GAPS.md` | running |
| Architecture | Software Architect | `docs/mobile/architecture/*` (+ ADR/) | running |
| Design | UI Designer | `docs/mobile/design/**` | running |
| Backend ext | Backend Architect | B1–B4 + `backend/tests/test_mobile_extensions_live.py`, `docs/mobile/integration/BACKEND_EXTENSIONS.md` | running |
| Mobile foundation | Mobile App Builder | `mobile/` scaffold | running |

## Blockers / external dependencies

- Bar machine access (real data, real network, print agent) — not available. Local docker backend substitutes.
- Mac for iOS — not available.
- Windows Firewall inbound TCP 8090 (Private profile) unverified for real phones; opening needs admin — documented, not changed.
- Login rate limit 10/min shared bucket — tests must reuse tokens.

## Test status

None yet.

## Next executable tasks

See Workstreams table.
