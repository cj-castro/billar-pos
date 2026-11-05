# Screen to Code Mapping

Owner of this file: shell/UI-kit agent creates it; **feature agents update their own rows** (status, tests) when they implement a screen. Screen IDs: [SCREEN_INVENTORY.md](../design/SCREEN_INVENTORY.md). State names: [SCREEN_STATE_MATRIX.md](../design/SCREEN_STATE_MATRIX.md). All paths relative to `mobile/`.

## Decisions recorded here

| # | Decision | Why |
|---|---|---|
| R1 | **ADMIN lives in the `(manager)` group; there is no `(admin)` group.** `routeForRole('ADMIN')` = `{ group: '(manager)', href: '/overview' }`; `canAccess('ADMIN', *)` is true for every group. The `system` tab (SCR-A-01) is shown only to ADMIN, the `kds` tab only to MANAGER (`href: null` by role in `app/(manager)/(tabs)/_layout.tsx`). | NAVIGATION_ARCHITECTURE.md / SCREEN_INVENTORY.md: "Admin = Gerencia + Sistema", one tab tree fewer. The foundation's `(admin)/diagnostics` placeholder was deleted; `roleRouting.test.ts` updated. |
| R2 | Route group folders do not appear in URLs, so route names must be **unique across groups**: waiter `floor`, `ready`, `me`; kitchen `queue`, `kds-me`; manager `overview`, `tickets`, `floor-view`, `kds`, `system`, `profile`. Do not add a second `index`/`me`/`floor`. | expo-router resolves `/floor` to the first match. |
| R3 | Each tabbed group is `(group)/_layout.tsx` = `GroupGuard` + `Stack`, and `(group)/(tabs)/_layout.tsx` = `Tabs`. Pushed flows (waiter ticket flow, manager ticket detail) sit **beside** `(tabs)` so the tab bar is hidden inside them (design: BottomActionBar owns the bottom edge). | NAVIGATION_ARCHITECTURE section 2. |
| R4 | Auth routes keep the foundation names `/setup`, `/login`, `/denied` (design says `(auth)/server`, `(auth)/login`, `/access-denied`). Not worth a rename: only role guards and `boot.ts` reference them. | Churn vs. zero user value. |
| R5 | SCR-X-02 is the root `ErrorBoundary` export in `app/_layout.tsx` (renders `ErrorState`), plus inline `ErrorState` on every data screen; no `/error` route. | expo-router idiom. |
| R6 | Modal routes (`configure/[itemId]`, `open-table/[resourceId]`) are `transparentModal` in `app/(waiter)/_layout.tsx`. The feature agent renders its own scrim/sheet. | NAVIGATION_ARCHITECTURE section 2. |
| R7 | "Yo" (SCR-X-03) is one component, `src/features/common/ProfileScreen.tsx`, mounted by `(waiter)/(tabs)/me.tsx`, `(manager)/(tabs)/profile.tsx`, `(kitchen)/kds-me.tsx`. | One screen, three mounts. |

## Route tree (current)

```
app/
  _layout.tsx                      providers (QueryClient, SafeArea, ToastProvider), socket session, ErrorBoundary (X-02)
  index.tsx                        AUTH-00 splash / boot gate
  setup.tsx  login.tsx  denied.tsx AUTH-01, AUTH-02, X-01
  (waiter)/_layout.tsx             GroupGuard + Stack (modals)
    (tabs)/_layout.tsx             Tabs: floor, ready, me
    (tabs)/floor.tsx ready.tsx me.tsx
    ticket/[ticketId]/index.tsx menu.tsx draft.tsx configure/[itemId].tsx
    open-table/[resourceId].tsx
  (kitchen)/_layout.tsx            GroupGuard + Stack (no tabs)
    queue.tsx  kds-me.tsx
  (manager)/_layout.tsx            GroupGuard + Stack
    (tabs)/_layout.tsx             Tabs: overview, tickets, floor-view, kds (MANAGER), system (ADMIN), profile
    (tabs)/overview.tsx tickets.tsx floor-view.tsx kds.tsx system.tsx profile.tsx
    tickets/[ticketId].tsx
```

## Mapping

Status: **DONE** = implemented in the shell phase; **TODO (owner)** = placeholder `PendingScreen` ("Pendiente"), fill in the file, keep the default export, update this row.
Shared kit: all components in `src/components/`, `ScreenScaffold` + `ScreenHeader` + `OfflineBanner` are the standard frame.

### Cross-cutting

| Role | Journey | Screen ID | Route file | Components | States | API | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| all | Start app | SCR-AUTH-00 | `app/index.tsx` | Logo, ScreenScaffold, AppButton | restoring, slow (> 3 s: Reintentar / Cambiar) | `boot()` -> SecureStore, `GET /auth/me`, `GET /health` | `src/auth` boot logic | DONE |
| all | First launch | SCR-AUTH-01 | `app/setup.tsx` | AppTextField, AppButton, LanguageToggle, Logo | default, testing, ok (ms), error (invalid/timeout/unreachable/not_pos) | `GET /api/v1/health` | `config/serverConfig.test.ts` | DONE |
| all | Login | SCR-AUTH-02 | `app/login.tsx` | AppTextField(password), AppButton, LanguageToggle, error banner | default, loading, error (401/429/network/server), validation | `POST /auth/login` | `test/__tests__/login.test.tsx` | DONE |
| any signed-in | Wrong role | SCR-X-01 | `app/denied.tsx` | EmptyState(warning), AppButton | default | JWT role | - | DONE |
| all | Fatal error | SCR-X-02 | `ErrorBoundary` in `app/_layout.tsx` | ErrorState | default (retry) | - | - | DONE |
| all signed-in | Profile | SCR-X-03 | `src/features/common/ProfileScreen.tsx` | ConfirmDialog, LanguageToggle, ConnectionPill, OfflineBanner | default, logout confirm, logging out | `POST /auth/logout`, local | - | DONE (sound/vibration toggles TODO kds-manager agent) |

### Waiter

| Role | Journey | Screen ID | Route file | Components | States | API | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| WAITER (M/A read) | Floor | SCR-W-01 | `app/(waiter)/(tabs)/floor.tsx` | TableCard, SectionHeader, LoadingSkeleton(floor), EmptyState, ErrorState, OfflineBanner, Toast | default, loading, empty, error, offline(stale), bar closed | `GET /resources`, `GET /cash/status`, socket `floor` | TODO | TODO (waiter agent) |
| WAITER | Open table | SCR-W-07 | `app/(waiter)/open-table/[resourceId].tsx` (modal) | AppTextField, AppButton | default, loading, BAR_CLOSED, RESOURCE_OCCUPIED | `POST /tickets` | TODO | TODO (waiter agent) |
| WAITER (M/A read) | Ticket | SCR-W-02 | `app/(waiter)/ticket/[ticketId]/index.tsx` | TicketLine, StatusChip, BottomActionBar, ConfirmDialog, PinPad, ScreenHeader | default, loading, error, offline, pending draft, bill requested, voided | `GET /tickets/{id}`, `POST .../request-payment`, `DELETE .../items/{id}` (pin) | TODO | TODO (waiter agent) |
| WAITER | Menu | SCR-W-03 | `.../ticket/[ticketId]/menu.tsx` | MenuItemTile, category chips, search, BottomActionBar | default, loading, empty search, sold out | `GET /menu/*`, `GET /inventory/stock-check` | TODO | TODO (waiter agent) |
| WAITER | Configure item | SCR-W-04 | `.../ticket/[ticketId]/configure/[itemId].tsx` (modal) | ModifierGroup, QuantityStepper, `validateModifierSelection`, BottomActionBar | default, validation error, sold-out modifier | cached menu | `utils/__tests__/modifiers.test.ts` (rules) | TODO (waiter agent) |
| WAITER | Draft / send | SCR-W-05 | `.../ticket/[ticketId]/draft.tsx` | DraftLineRow (**to build**), StatusChip(draft), BottomActionBar, ConfirmDialog | pending, sending, sent, failed(retry), offline | `POST /tickets/{id}/items` + `Idempotency-Key` + `X-Ticket-Version` | TODO | TODO (waiter agent) |
| WAITER | Ready list | SCR-W-06 | `app/(waiter)/(tabs)/ready.tsx` | StatusChip, AppButton(success), EmptyState, tab badge (`tabBarBadge` in `(tabs)/_layout.tsx`) | default, empty, loading, error, offline | `GET /queue/*`, `PATCH /queue/{item}/status`, sockets | TODO | TODO (waiter agent) |
| WAITER | Manager PIN | OV-01 | overlay (no route) | PinPad, ConfirmDialog/Modal | default, wrong, locked (429) | `POST /auth/verify-pin` | `components/__tests__/PinPad.test.tsx` (component) | TODO (waiter agent: wiring) |
| WAITER | Ready toast | OV-02 | overlay | `useToast()` | success w/ action "Ver" | socket `kitchen`/`bar` | `components/__tests__/components.test.tsx` (Toast) | TODO (waiter agent: wiring) |

### Kitchen / Bar

| Role | Journey | Screen ID | Route file | Components | States | API | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| KITCHEN_STAFF, BAR_STAFF (M/A view) | KDS queue | SCR-K-01 | `app/(kitchen)/queue.tsx` | KdsTicketCard, KdsItemRow, KdsAgeBadge, ConnectionPill, OfflineBanner, EmptyState | default, loading, empty, error, offline (advance disabled), advancing | `GET /queue/{station}`, `PATCH /queue/{item}/status`, sockets | TODO | TODO (kds-manager agent) |
| K, B | KDS hidden menu | SCR-X-03 | `app/(kitchen)/kds-me.tsx` -> `ProfileScreen` | (shell) | default | - | - | DONE (open gesture: TODO kds-manager agent) |

### Manager / Admin

| Role | Journey | Screen ID | Route file | Components | States | API | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| MANAGER, ADMIN | Ops overview | SCR-M-01 | `app/(manager)/(tabs)/overview.tsx` | StatTile, KdsAgeBadge, SectionHeader, LoadingSkeleton(stats) | default, loading, error (tile "—"), offline | `GET /cash/status`, `/tickets/open-all`, `/queue/counts` | TODO | TODO (kds-manager agent) |
| M, A | Open tickets | SCR-M-02 | `app/(manager)/(tabs)/tickets.tsx` (+ `tickets/[ticketId].tsx`) | list rows, StatusChip, EmptyState | default, empty, filter | `GET /tickets/open-all` | TODO | TODO (kds-manager agent); detail reuses waiter ticket in read mode (coordinate with waiter agent) |
| M, A | Floor (read-only) | SCR-M-03 | `app/(manager)/(tabs)/floor-view.tsx` | TableCard (same as W-01, no "Abrir mesa") | as W-01 | as W-01 | TODO | TODO (kds-manager agent) |
| MANAGER | KDS view | SCR-M-04 | `app/(manager)/(tabs)/kds.tsx` | as K-01 + station switch | as K-01 | as K-01 | TODO | TODO (kds-manager agent, **P1**) |
| ADMIN | System | SCR-A-01 | `app/(manager)/(tabs)/system.tsx` | StatTile/rows, ConnectionPill, AppButton | default, error | `GET /health`, socket status, `GET /auth/me` | TODO | TODO (kds-manager agent) |
| M, A | Profile | SCR-X-03 | `app/(manager)/(tabs)/profile.tsx` -> `ProfileScreen` | (shell) | default | - | - | DONE |

## Component kit index (`src/components/`)

AppText, AppButton, IconButton, StatusChip, TableCard, TicketLine, MenuItemTile, ModifierGroup (+ `utils/modifiers.ts`: `validateModifierSelection`, `toggleModifier`), QuantityStepper, BottomActionBar, ConnectionPill + OfflineBanner (+ `connection.ts`: `connectionLevel`, `useConnectionLevel`, `useLastUpdated`), EmptyState, ErrorState (+ `utils/errorMessage.ts`), LoadingSkeleton, PinPad, ConfirmDialog, Toast (`ToastProvider`, `useToast`), KdsTicketCard (+ `KdsItemRow`), KdsAgeBadge, StatTile, SectionHeader, ScreenHeader, ScreenScaffold, AppTextField, LanguageToggle, Logo, PendingScreen, GroupGuard, `tabBar.tsx` (`tabScreenOptions`, `tabIcon`).
Not built (feature-owned, add to `src/components/` as new files): **DraftLineRow** (W-05).
