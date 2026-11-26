# iOS Readiness - Mobile POS Companion

Status: assessment as of 2026-11-05. **Nothing has been built or run on iOS.** No Mac is available (`PROJECT_STATE.md`, `DEPENDENCIES_AND_GAPS.md` E7). Every "supported" entry below is a library-level claim to be verified on a device (`MAC_SETUP.md`). Android remains the first target (D1, D2).

Sources for code facts: grep of `mobile/app`, `mobile/src`, `mobile/app.config.ts` and `mobile/package.json` in the worktree, and reading the files named in each row. Library iOS support is from the package list and general Expo SDK 58 support; verify each claim on device.

---

## 1. Summary

| Area | Verdict | Blocking for iOS? |
|---|---|---|
| Code portability (TypeScript, RN components, zustand, TanStack, socket.io-client, i18next) | Ready in principle. Only two `Platform.OS` branches exist | No |
| Visual elevation (cards, toast, dialog) | **Gap**: Android-only `elevation` style, no iOS shadow props | Visual only |
| Cleartext LAN HTTP | **Gap**: no `ios.infoPlist` ATS config yet | **Yes** for any iOS run |
| Local-network permission | **Gap**: no `NSLocalNetworkUsageDescription`, no denied-state UX | **Yes** for device runs |
| Token storage | Keychain via SecureStore. **Gap**: Keychain survives app uninstall (section 4) | Security hygiene |
| Background behaviour | iOS suspends the app quickly. Foreground-only design already assumed (`NETWORKING_AND_SYNC.md` section 5) | No, but test |
| Screen-capture prevention | Not implemented on either platform. iOS cannot block screenshots the way Android `FLAG_SECURE` does | Policy decision |
| Keep-awake for KDS | Not installed (`expo-keep-awake` absent from `package.json`). Works on iOS when added | Feature gap on both |
| Offline and reachability logic | Shared with Android. Open defects D-1, D-2, D-10 in `REAL_BACKEND_VALIDATION.md` section 0 | Yes, on both |

Overall: **not yet buildable or verified on iOS.** Estimate in section 7.

---

## 2. Library matrix

Versions are from `mobile/package.json`. "iOS (SDK 58)" means the package is listed by Expo for iOS in the SDK 58 family. Confirm on a simulator and device.

| Library | Version | Used in code | iOS support (expected) | Notes |
|---|---|---|---|---|
| expo | ~58.0.23 | Build, Router, config | Yes | Expo SDK 58, RN 0.88.1, React 19.3.0 (`package.json`) |
| react-native | 0.88.1 | Core | Yes | |
| react / react-i18next / i18next | 19.3.0 / ^17.1.13 / ^26.7.2 | i18n, UI | Yes | `src/i18n/index.ts` |
| expo-router | ~58.0.30 | Routing, `ErrorBoundary` | Yes | Route groups `(waiter)`, `(kitchen)`, `(manager)` |
| expo-secure-store | ~58.0.2 | Tokens (`authStore.ts`) | Yes, **Keychain** | Section 4 |
| @react-native-async-storage/async-storage | 2.2.0 | Server URL, language, user profile | Yes | Non-secret only |
| @react-native-community/netinfo | 12.0.1 | `queryClient.ts`, `components/connection.ts` | Yes | Reachability not configured (D-2) |
| @tanstack/react-query | ^5.106.1 | Data layer | Yes (JS) | Persister not installed (D-9, D-10) |
| zustand | ^5.0.16 | Stores | Yes (JS) | |
| axios | ^1.21.0 | API client | Yes (JS) | |
| socket.io-client | ^4.8.4 | Realtime | Yes (JS) | `transports: websocket, polling` (`socket.ts`) |
| expo-haptics | ~58.0.7 | `utils/haptics.ts` | Yes (hardware dependent) | No-op on simulator; wrapped in `safe()` |
| expo-crypto | ~58.0.7 | Idempotency UUIDs (planned use) | Yes | |
| expo-constants / expo-linking / expo-font / expo-splash-screen / expo-status-bar / expo-system-ui | ~58 | Shell | Yes | `StatusBar style="light"` in `app/_layout.tsx` |
| expo-build-properties | ~58.0.12 | `usesCleartextTraffic` (Android only) | Plugin is cross-platform; iOS keys set separately | Section 3 |
| react-native-screens | ~4.30.1 | Navigation | Yes | |
| react-native-safe-area-context | ~5.11.1 | `SafeAreaProvider`, `ScreenScaffold`, `BottomActionBar`, `Toast` | Yes | Notch and Dynamic Island insets: verify |
| react-native-gesture-handler | ~3.3.0 | **Not imported in `src` or `app`** | Yes | Installed but unused. Remove or keep deliberately |
| react-native-reanimated | 4.7.1 | **Not imported in `src` or `app`** | Yes | Installed but unused. `TECH_STACK_DECISION.md` says "not added"; reconcile |
| react-native-worklets | 0.13.0 | Peer of reanimated | Yes | |
| @expo/vector-icons | ^15.0.2 | Icons | Yes | |
| expo-status-bar | ~58.0.4 | Status bar style | Yes | |
| Not installed but planned | expo-keep-awake, expo-screen-capture, @tanstack/query-async-storage-persister, @tanstack/react-query-persist-client | See sections 4-5 | Yes where applicable | Install when built |

---

## 3. Platform-specific code paths

Every place the code differs by platform or assumes Android. Line references are from the worktree at review time.

| # | Location | Code | iOS effect | Action |
|---|---|---|---|---|
| P-1 | `mobile/src/state/queryClient.ts:28` | `if (Platform.OS !== 'web') focusManager.setFocused(...)` | None (native branch is taken on iOS) | None |
| P-2 | `mobile/src/components/ScreenScaffold.tsx:43` | `KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}` | iOS uses padding; Android relies on window resizing. Behaviour differs | Verify PIN and setup screens on both. Keyboard covering the "Connect" button is the typical failure |
| P-3 | `mobile/src/components/ConfirmDialog.tsx:64` | `elevation: elevation.e3` | **Ignored on iOS**: no shadow. Dialogs look flat | Add iOS shadow props (`shadowColor`, `shadowOffset`, `shadowOpacity`, `shadowRadius`) from tokens |
| P-4 | `mobile/src/components/Toast.tsx:144` | `elevation: elevation.e2` | Same as P-3 | Same |
| P-5 | `mobile/src/theme/tokens.json` `"elevation": {"e0":0,"e1":2,"e2":6,"e3":12}` | Scale is Android-only as written | Needs an iOS shadow mapping in `tokens.ts` | Add `shadow` tokens alongside `elevation` |
| P-6 | `mobile/app.config.ts` `android` block | `adaptiveIcon`, `predictiveBackGestureEnabled: false` | Android-only. No iOS effect | None |
| P-7 | `mobile/app.config.ts` `plugins` `expo-build-properties` `android.usesCleartextTraffic` | Android cleartext | **No iOS equivalent yet** | Add `ios.infoPlist` ATS keys (`MAC_SETUP.md` section 6.1) |
| P-8 | `mobile/app.config.ts` `ios` block | `bundleIdentifier`, `supportsTablet: false` | iOS identifier set. No `infoPlist` | Add `NSLocalNetworkUsageDescription` and ATS (`MAC_SETUP.md`) |
| P-9 | `mobile/app/login.tsx:79-92` | `textContentType="username"/"password"`, `autoComplete` | iOS uses `textContentType` for AutoFill (Keychain password suggestions). **Password AutoFill from iCloud Keychain could fill a staff password** | Decide. Likely keep off for PIN-like staff passwords. Check it with the security owner |
| P-10 | `mobile/app/setup.tsx:83` | `keyboardType="url"` | Good on iOS. Also set `autoCapitalize="none"` and `autoCorrect={false}` | Verify |
| P-11 | `mobile/src/utils/haptics.ts` | `Haptics.selectionAsync`, `impactAsync`, `notificationAsync` wrapped in `safe()` | Works on iPhone hardware (no simulator feedback). Errors are swallowed | None. Test vibration on device for the ready banner |
| P-12 | `mobile/src/components/tabBar.tsx:17` | `tabBarHideOnKeyboard: true` | Cross-platform | None |
| P-13 | `mobile/src/utils/money.ts` | Comment: Hermes `Intl` can be degraded | Hermes engine on iOS is the same engine. Verify `Intl.NumberFormat('es-MX', MXN)` on an iPhone | Add a device check to section 6 |
| P-14 | `mobile/src/state/authStore.ts` | `SecureStore.*Async` (tokens) and AsyncStorage (user) | Keychain on iOS (section 4) | See section 4 |
| P-15 | `mobile/src/realtime/socket.ts` | `transports: ['websocket','polling']` | iOS sockets are suspended in background. Same foreground-only design | Test background > 30 s (section 6) |
| P-16 | `mobile/app/_layout.tsx` | `StatusBar style="light"` | Status bar text colour on iOS uses the same setting | Check on a notch device |

Non-finding: `grep` for `Platform.select`, `Platform.Version`, `BackHandler`, `PermissionsAndroid`, `ToastAndroid`, `Vibration`, `Linking`, `Alert.alert`, `adb`: no matches in `mobile/app` or `mobile/src` (excluding generated folders). No Android-only native module is imported directly.

---

## 4. Secure storage on iOS (Keychain)

| Item | Finding | Risk | Action |
|---|---|---|---|
| Storage | `expo-secure-store` writes to the iOS Keychain. Tokens are stored under `ACCESS_KEY` and `REFRESH_KEY` (`authStore.ts`) | Low: as designed | None |
| Survives uninstall | iOS **keeps Keychain items after the app is deleted**. AsyncStorage (the user profile and server URL) is removed with the app | **Medium**: a reinstalled app can find an old refresh token. A returning user may skip login, or a previous device holder's session may resurface | Add a first-run marker in AsyncStorage. If the marker is absent but SecureStore has tokens, clear the tokens before boot. Test it |
| Accessibility option | SecureStore has an iOS accessibility option (for example "when unlocked"). Not set in code | Medium | Choose explicitly. Confirm the default and option names in the Expo SecureStore docs (Context7 or the Expo site) before setting |
| Backup | iOS device backups may include Keychain items | Low | Accepted; document. Android uses `allowBackup=false` (`SECURITY_MODEL.md` section 4) |
| PIN handling | Same rules as Android (ref cleared, never stored) | Same | Same tests |
| Screenshots | iOS allows screenshots by default. Android `FLAG_SECURE` has no direct iOS equivalent | Medium (`SECURITY_MODEL.md` section 6) | Accept residual or add `expo-screen-capture` with iOS limits understood. Document the residual |

---

## 5. Feature parity gaps (both platforms, worse on iOS)

| Gap | Ref | iOS impact |
|---|---|---|
| Mutations use `networkMode: 'online'` (`queryClient.ts:18`) | D-1 | Same as Android: a Send tapped offline may run later. Test on iPhone (T-19) |
| Reachability uses `isInternetReachable` (`queryClient.ts:31-33`) | D-2 | Same. iOS often reports "no internet" on LAN-only Wi-Fi. Test T-18 |
| No persisted query cache | D-10 | Offline cold start shows empty screens. Same |
| No keep-awake | D-11 | KDS tablets may sleep. iOS auto-lock setting per device: set "Never" on KDS devices (Settings > Display & Brightness > Auto-Lock), or use keep-awake |
| No 30 s background disconnect | `NETWORKING_AND_SYNC.md` section 5 | iOS suspends the app quickly; the socket dies. Resync on resume is required. Test |
| No KDS poll | D-6 | Same |
| Local-network permission denial UX | MAC_SETUP 6.2 | iOS-specific. No handling yet |

---

## 6. Validation checklist (mirrors the Android journeys J1-J7)

Run on a physical iPhone against the bar-like local stack (`MAC_SETUP.md` 6.4) first, then the bar backend (`REAL_BACKEND_VALIDATION.md`). Journey definitions: `docs/mobile/testing/TEST_STRATEGY.md` section 6.

| Check | Journey | Pass condition | iOS-specific note |
|---|---|---|---|
| Install and launch from Xcode | - | App opens on iOS 16.4+ (confirm target) | Free profile expires in 7 days |
| Local-network prompt appears and is accepted | J1 | Prompt shown once; connections succeed | Denial path: see 5 |
| Setup: `http://<ip>:8080` health OK | J1 | Login reached | ATS config from `MAC_SETUP.md` 6.1 must be in place |
| Setup: `<ip>` without port | J1 | Expected to connect to 8080 (D-4 defect) | Same as Android |
| J1 waiter login and send 3 lines | J1 | 3 SENT lines; keyboard does not hide the Send button | P-2 keyboard behaviour; use the Connect and Login screens |
| J2 chef login, KDS statuses | J2 | Three advances; auto-lock disabled on the test device | Auto-lock setting |
| J3 waiter sees READY | J3 | Banner in <= 3 s with haptic; no duplicate | P-11 haptic on device |
| J4 manager ops numbers | J4 | Numbers match web | Notch and safe-area layout (P-16) |
| J5 unauthorised route | J5 | Denied screen; no extra calls | Same |
| J6 airplane mode send | J6 | Blocked; nothing sent after reconnect | Background suspension |
| J6 Wi-Fi off during send | J6 | No duplicate line in DB (`REAL_BACKEND_VALIDATION.md` section 8) | Same |
| J6 background 30 s and return | J6 | Visible screen refetches; socket reconnects | Suspension on iOS |
| J7 logout, relaunch, login | J7 | Login shown on relaunch | Keychain persistence (section 4) |
| J7 reinstall app and launch | J7 | No restored session when AsyncStorage was wiped (after the fix in section 4) | Keychain persistence |
| Elevation / shadow visuals | - | Cards and toast have shadows (after P-3 to P-5 fix) | Visual |
| Currency format | - | `$1,234.00` style per `money.ts` with es-MX | P-13 |
| Keyboard on PIN dialog | J1 | Digits only; no autofill suggestions | P-9 |
| Dark theme status bar | - | Light text on dark background, notch device | P-16 |

Pass/fail recording: same template as `REAL_BACKEND_VALIDATION.md` section 9, device model and iOS version in the notes.

---

## 7. Effort estimate (engineering estimate, not measured)

| Work | Estimate | Depends on |
|---|---|---|
| Mac access and first `prebuild` and `run:ios` | 0.5-1 day | Mac available |
| ATS and local-network config, verify on device | 0.5-1 day | Device, bar or local stack |
| Shadow tokens for iOS (P-3 to P-5) | 0.5 day | None |
| Keychain first-run clearing (section 4) | 0.5 day | None |
| Accessibility option for SecureStore | 0.25 day | Expo docs check |
| Local-network denial UX | 0.5 day | None |
| Keep-awake and screen-capture decision | 0.5-1 day | Owner decision on residual risk |
| Fixes from shared defects D-1, D-2, D-10 | Counted in the Android plan, not iOS | Shared |
| Device regression pass (checklist section 6) | 1-2 days | Device and time on shift |
| **Total additional for iOS** | **about 4-6 engineer days** plus Mac and device availability | |

This excludes App Store, TestFlight and signing for distribution (out of scope, D2).

---

## 8. Decisions needed from the owner

1. Accept iOS screenshots as an unblocked residual (no `FLAG_SECURE` equivalent), or require a mitigation.
2. Accept an iOS build for personal-device pilots only (free Apple ID, 7-day expiry), or wait for a paid program (which the project rules currently exclude).
3. Confirm whether iOS staff devices are in scope for the first bar pilot. The current plan is Android first (D1).
4. Confirm password AutoFill policy for staff login (P-9).

## Related

- `docs/mobile/ios/MAC_SETUP.md` (runbook and config to apply on the Mac)
- `docs/mobile/architecture/TECH_STACK_DECISION.md` section 8 (iOS-readiness rules)
- `docs/mobile/architecture/SECURITY_MODEL.md` sections 4 and 6
- `docs/mobile/integration/REAL_BACKEND_VALIDATION.md` section 0 (shared defects)
