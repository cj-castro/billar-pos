# Mobile POS Companion — Project State

Source of truth for progress. Recoverable without chat history.

- **Worktree:** `D:/Projects/Code/billar-pos-worktrees/mobile-pos-companion`
- **Branch:** `feature/mobile-pos-companion` (from `main` @ `4e4430ff`). Local commits only. Never push.
- **Main checkout** `D:/Projects/Code/billar-pos` is off-limits (has user's uncommitted `.planning/ e2e/ electron/ installer/`).

## Current phase

**Android v1 locally complete; awaiting bar-machine validation.**

All workstreams are finished and committed (HEAD `35ba5b3c`). Everything was verified only against the local Docker backend (`billarmobile`, :8090) and an Android 15 emulator. Nothing ran on the real bar machine, a real network, a physical phone or iOS. Full detail: [FINAL_ENGINEERING_REPORT.md](FINAL_ENGINEERING_REPORT.md).

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

## Backend extensions (worktree only, local; must be deployed to the bar machine to take effect)

| ID | Change | Status |
|---|---|---|
| B1 | `Idempotency-Key` on `POST /tickets/<id>/items` (migration 002), response adds `ticket_version` | DONE, verified locally, NOT deployed |
| B2 | Socket payloads add `ticket_id, resource_code, menu_item_name, quantity` (`opened_by` removed per SEC-05) | DONE, verified locally, NOT deployed |
| B3 | Queue PATCH rejects VOIDED items (409 `ITEM_VOIDED`) | DONE, verified locally, NOT deployed |
| B4 | Socket `join` actually joins `manager` room | DONE, verified locally, NOT deployed |
| 003 | Migration restoring reference data dropped by baseline squash 2b72b157 | DONE, verified on a clean local DB, NOT deployed |

## Workstreams (final status)

| WS | Output | Status |
|---|---|---|
| Discovery | `docs/mobile/discovery/*` | DONE |
| Env | `scripts/mobile/*`, LOCAL_DEV_ENVIRONMENT.md, emulator `billar_mobile_api35` | DONE |
| Product | `docs/mobile/product/*` | DONE |
| Architecture | `docs/mobile/architecture/*` + ADR | DONE |
| Design | `docs/mobile/design/**` (17 HTML prototypes, local; Claude Design not used) | DONE |
| Backend ext | B1-B4 + migration 003 + `backend/tests/test_mobile_extensions_live.py` | DONE (local only) |
| Mobile foundation, UI kit, shell | `mobile/` Expo SDK 58 / RN 0.88 | DONE |
| Waiter, KDS, Manager/Admin slices | `mobile/src/features/*`, `mobile/app/*` | DONE |
| Code + security review and fix pass | `testing/reviews/*` | DONE; deferred findings remain (see report section 11) |
| Release APK | `mobile/dist/bola8-staff-0.1.0-local.apk` (debug-keystore signed, gitignored) | DONE (local/emulator use only) |
| E2E + visual QA + UI fixes | `testing/TEST_RESULTS.md`, Maestro `j*.yaml` | DONE |
| iOS | `docs/mobile/ios/*` handoff only | NOT STARTED (no Mac) |

## Test status (as recorded 2026-11-05; local backend + emulator)

| Layer | Result |
|---|---|
| Unit/component (`npm test`) | 34 suites, 443/443 pass |
| `tsc --noEmit`, `expo lint` | clean |
| Contract vs real local backend (`npm run test:contract`) | 3 suites, 56/56 pass |
| Backend live (B1-B4) | ALL PASSED (31/31 per fix-pass note; QA counted 30 PASS lines) |
| Maestro E2E on release APK | Journeys J1-J8 pass; after the last UI fix round only the waiter order, kitchen login and KDS landscape flows were re-run |
| NOT verified | real bar network/data, physical phones, iOS, print agent, multi-device realtime, in-flight send failure, manager PIN success paths, TalkBack, bar-staff station |

## Blockers / external dependencies

- Bar machine access (real data, network, print agent): not available.
- Windows Firewall inbound TCP 8080 (Private profile) needs admin; not changed.
- Mac for iOS: not available.
- Venue signing keystore: not created.
- Cleartext LAN HTTP, public debug keystore, refresh token not revoked server-side, unauthenticated socket rooms: accepted residual risks (SECURITY_MODEL section 10).

## Next executable tasks (ordered)

1. **Bar-machine deployment checklist** (`integration/BAR_MACHINE_REQUIREMENTS.md`): backup, deploy backend with B1-B4 + migrations 002/003, check `SELECT count(*) FROM movement_event_types;` returns 14, firewall rule TCP 8080 Private, DHCP reservation, Wi-Fi client isolation off, per-staff accounts/PINs, ProxyFix for per-client rate limits.
2. **Real-network validation** (`integration/REAL_BACKEND_VALIDATION.md`): physical phones, repeat J1-J8, multi-device realtime, in-flight send failure, LAN without internet, manager PIN paths, bar-staff station, print.
3. **Re-sign the APK with a venue-owned keystore** kept outside the repo; do not put the current APK on staff phones.
4. **Deferred review findings**: server-side forward-only queue transitions (M7), socket authentication, server PIN rate limit, HTTPS at nginx (SEC-01), screenshot protection, AppState handling, remaining low items (report section 11).
5. **iOS on a Mac** (`ios/MAC_SETUP.md`, `ios/IOS_READINESS.md`).

Housekeeping: delete the stray empty file `d:	mp_ready.cjs` manually; `mobile/README.md` still describes placeholders and needs a refresh.
