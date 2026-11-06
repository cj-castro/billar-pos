# v2 polish backlog (collected during build)

- [x] `api/client.ts` `toApiError`: keep response body (`details`) so 422 `AMOUNT_MISMATCH` / `INSUFFICIENT_PAYMENT` totals can be shown without refetch.
- [x] Pay success: manager should return to `/(manager)/tickets` not `/floor`.
- [x] Cobrar tap budget: 5 today (Cobrar · Efectivo · exacto · Cobrar · Confirmar). Target 4: pre-select Efectivo, or merge bottom Cobrar + Confirmar into one confirm sheet.
- [x] Descuento: server needs no PIN for MANAGER/ADMIN; drop PIN sheet (keep test update).
- [x] Merge `queryKeysV2.ts` → `queryKeys.ts`, `i18n/mobileV2.ts` → `mobile.ts` once Phase 1B/2 land.
- [x] `kds-me`: real profile sheet (mute, station switch) instead of route.
- [ ] Release build: run `expo prebuild --clean` + `assembleRelease` once with a real keystore.
- [ ] Socket handshake session dict is per-process on backend; document single-worker requirement.
- [ ] Verify `GET /settings/<key>` allows KITCHEN_STAFF/BAR_STAFF (KDS reads kds_sound_enabled, kds_warn_min, kds_late_min); if 403, add public read or default fallback is acceptable.
- [x] Remove `app/(kitchen)/kds-me.tsx` route once KdsMeSheet confirmed on device.
- [ ] Reportes: Rango preset uses text date fields; add `@react-native-community/datetimepicker` if owner wants pickers. CSV export is text share; add `expo-sharing` for file attachment.
- [x] Move `listCashSessions`/`getCashSessionSummary` from `endpoints/reports.ts` into `endpoints/cash.ts`.
- [x] Sistema `min_mobile_version` field: show server default 1.0.0 when unset.
- [ ] `/reports/payments`: split tickets report tendered (tip + overpayment inclusive) in `total_cents` and tip twice; mobile Reportes "por método" inflated for Mixto. Fix server SQL (use allocated share of total) — web affected too, so do it in a web-safe way.
- [ ] Web frontend: handle 403 `PIN_REQUIRED` on close if `waiter_can_close_ticket` ever enforced for web.
- [ ] Pool estimate: confirm `rate_cents` unit (billing.py comment says $86/hr while value 8600).

## iOS open items

- [ ] Truncated headers on iPhone: "Lista d…" on Waiting, and the floor subtitle "Alice Waiter · Mes…". The header layout is shared across platforms, so this needs a cross-platform decision.
- [ ] iOS "Save Password?" sheet appears after every login on shared staff phones. Product decision needed (keep, or suppress the save prompt).
- [ ] "Bar cerrado" banner does not refresh when a cash session is opened through the API (no socket push). Pull-to-refresh is needed.
- [ ] Local-network permission prompt not yet verified. Needs a physical iPhone on the LAN.
- [ ] Keep-awake, haptics and the silent-mode chime cannot be verified on the simulator. Needs a device.
- [ ] Maestro j12 touch-target audit uses a host-side `uiautomator dump`, which has no iOS equivalent. Not replaced.
- [ ] Maestro j16 keypad steps changed for Android too (the keypad became a text field: `fund-pad` / `count-pad`). Re-verify on the Android emulator.
- [ ] Physical iPhone build is pending (simulator only so far).
