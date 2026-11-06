# Feature-agent contract

Two feature agents work in parallel after the shell phase. Stay inside your folders; the shared layers are append-only.

## Ownership

| Owner | Writes (create / edit / delete) |
|---|---|
| **waiter agent** | `src/features/waiter/**`, `app/(waiter)/**` (screens, `_layout.tsx`, `(tabs)/_layout.tsx` badge) |
| **kds-manager agent** | `src/features/kitchen/**`, `src/features/manager/**`, `src/features/admin/**`, `app/(kitchen)/**`, `app/(manager)/**` |
| **shell (done)** | `src/features/common/**` (ProfileScreen), `app/_layout.tsx`, `app/{index,setup,login,denied}.tsx`, `src/auth/**`, `src/state/**`, `src/config/**`, `src/i18n/index.ts` |

## Shared files: ADD ONLY

`src/api/**`, `src/realtime/**`, `src/components/**`, `src/theme/**`, `src/utils/**`, `src/i18n/mobile.ts` (and `web/*`), `src/domain/types.ts`:

- You may **add** new files and new exports (a new endpoint module, `DraftLineRow.tsx`, a new `useXxx` hook, new i18n keys under a **new top-level key** named after your feature, e.g. `waiter: {...}`, `kds: {...}` already exists for the kit).
- You must **not** rename, move, delete, or change the signature/behaviour of existing exports. If a kit component is missing a prop you need, add an optional prop in a backwards-compatible way, keep the change minimal, and mention it in your final report. If it needs a redesign, stop and report instead.
- i18n: every string goes in **both** `mobileEs` and `mobileEn` (the type `typeof mobileEs` enforces parity). Two agents editing `mobile.ts` concurrently: add your block as one contiguous new top-level key to keep merges trivial.
- Design tokens come from `src/theme/tokens.ts` only (never hard-code a colour, size or radius; the JSON source of truth is `docs/mobile/design/tokens.json`, synced with `node scripts/sync-tokens.mjs`).

## Rules of the road

1. **One design system.** Build screens from `src/components/`: `ScreenScaffold` + `ScreenHeader` + `OfflineBanner`, `AppText` (never raw `Text`), `AppButton` (never a raw `Pressable` for actions), `AppTextField`, `EmptyState` / `ErrorState` / `LoadingSkeleton` for every data state, `useToast()` for feedback, `ConfirmDialog` for confirmations, `PinPad` for manager PIN. Errors: `errorMessage(err)` / `<ErrorState error={err} onRetry=... />` (maps `ApiError` to Spanish).
2. **Keep route files thin.** Data hooks and logic live in `src/features/<role>/`; route files only compose.
3. **Route names are globally unique** (groups are not part of URLs): never add a second `floor`, `me`, `index`, ... See `docs/mobile/implementation/SCREEN_TO_CODE_MAPPING.md` (R2).
4. **Tabs / modals**: edit only your own group's `_layout.tsx`. Tab screens use `<ScreenScaffold edges={['top']}>` (the tab bar owns the bottom inset); pushed screens with a `BottomActionBar` pass it as `footer`.
5. **Server is the authority** (D3): never compute totals/charges; label estimates. Offline (D7): reads from cache + `OfflineBanner`, **disable** mutating buttons with a `helper` explaining why; never queue mutations. Mutations inherit the global `networkMode: 'always'` (fail fast, no hidden queue; never override it).
6. **Realtime**: use `useRealtimeEvent`, `useTicketRoom`, `onRealtimeEvent` from `src/realtime/socket.ts`; add event invalidations to `invalidationsFor` only by appending `case`s.
7. **Accessibility**: `accessibilityRole` + `accessibilityLabel` incl. state, 48 dp minimum targets (56 dp for primary waiter actions), status = colour + icon + word, font scale honoured (KDS passes `fixedScale`). The kit already does this; do not bypass it.
8. **Tests**: add `__tests__/` next to your feature code. Use `renderWithProviders` from `src/test/utils.tsx` (SafeAreaProvider + QueryClient + i18n es). When asserting that a press is *ignored*, use `userEvent.setup().press(...)` (`fireEvent.press` walks up to composite `onPress` props and can false-positive).
9. **Quality gate before reporting**: `npm test`, `npm run typecheck`, `npm run lint` all clean (the React Compiler lint rules are on: no ref reads / `Date.now()` in render, no synchronous `setState` in effects; use `useNow()`, `Animated.useAnimatedValue`).
10. Update your rows in `docs/mobile/implementation/SCREEN_TO_CODE_MAPPING.md` (status, tests) when a screen is done.

## Useful entry points

| Need | Use |
|---|---|
| Role/guard | `src/auth/roleRouting.ts` (`routeForRole`, `canAccess`), `GroupGuard` |
| Current user | `useAuthStore((s) => s.user)` |
| API client / endpoints / query keys | `src/api/client.ts`, `src/api/endpoints/*`, `src/api/queryKeys.ts` |
| Connection state | `useConnectionLevel()`, `useLastUpdated()` (`src/components/connection.ts`) |
| Money / time | `formatMXN` (`utils/money`), `useElapsed`, `formatClock` (`utils/time`), `useNow` |
| Haptics | `haptic.selection() / light() / success() / error()` (`utils/haptics`) |
| Modifier rules | `validateModifierSelection`, `toggleModifier` (`utils/modifiers`) |
| Status colours | `tableStatusStyle`, `lineStatusStyle`, `draftStatusStyle`, `kdsAgeLevel`, `ageStyle` (`theme/tokens`) |
