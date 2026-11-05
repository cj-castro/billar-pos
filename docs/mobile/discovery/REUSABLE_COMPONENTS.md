# Reusable Components — web frontend → mobile

`$SRC` = `frontend/src`.

## A. Logic (framework-agnostic TS)

| Piece | File | What | Mobile notes |
|---|---|---|---|
| API client | `$SRC/api/client.ts` | axios, `baseURL '/api/v1'`, Bearer, single-flight refresh, logout on refresh 401/422 | Mirror; absolute configurable base URL; navigation instead of `window.location` |
| Auth store | `$SRC/stores/authStore.ts` | zustand + persist, `User` interface | Tokens → SecureStore (Keystore) |
| Floor store | `$SRC/stores/floorStore.ts` | `ResourceState`, `setResources` | Reusable |
| Socket provider | `$SRC/hooks/useSocket.ts` | role-based `joinRooms`, resync on `connect`, event→query invalidation | Reuse mapping; fix `waiting_list:update` mismatch |
| Query defaults | `$SRC/main.tsx` | retry 1, staleTime 30s, gcTime 1h, keepPreviousData, refetchOnReconnect 'always', networkMode 'offlineFirst' | Copy |
| Money | `$SRC/utils/money.ts` | `formatMXN(cents)`, `formatMXNFromPesos`, `Intl.NumberFormat('es-MX','MXN')` | Verify Intl on Hermes |
| Timer | `$SRC/hooks/useTimer.ts` | ISO start → `mm:ss`/`h:mm:ss` | Reusable |
| Language | `$SRC/hooks/useLanguage.ts` | `i18n.changeLanguage` + localStorage `lang` | AsyncStorage |
| Role routes | `$SRC/App.tsx` | `RequireAuth roles=[...]` | Reuse role lists for nav gating |
| Login redirect | `$SRC/pages/LoginPage.tsx` | KITCHEN_STAFF→`/queue/kitchen`, BAR_STAFF→`/queue/bar`, else `/floor` | Same mapping |
| Print DTOs | `$SRC/utils/printReceipt.ts`, `printJobStorage.ts`, `printCashReconciliation.ts` | print payloads, localStorage queue | Not needed on phone (host print agent) |

## B. Types / DTOs

No shared types package. Inline interfaces only (`User` authStore.ts:4, `ResourceState` floorStore.ts:3, `UnitEntry` useUnitCatalog.ts:5, etc.). ~384 `any` usages under `$SRC`; 178 `client.*` calls across 28 files. Source of truth = backend `to_dict()` (e.g. `backend/app/models/ticket.py:84`). No OpenAPI/codegen → mobile DTOs hand-written from `to_dict()`.

## C. Design tokens

| Token | Source | Value |
|---|---|---|
| Brand | `frontend/tailwind.config.js` | brand-50 `#f0f9ff`, 500 `#0ea5e9`, 600 `#0284c7`, 700 `#0369a1`, 900 `#0c4a6e` |
| Surface | `$SRC/index.css` | body bg `#0f172a`, text `#f1f5f9` |
| In-use palette | LoginPage, NavBar | slate-950/900/800/700 surfaces; sky-400/500/600 accent; red-500 badges; slate-400 secondary |
| Alert | `index.css` `.pulse-red` | red pulse border |
| Theme | observed | dark only |
| Logo | `frontend/public/logo.jpg` | used in Login, NavBar |

Bottom tab pattern: `$SRC/components/NavBar.tsx` (Floor, Kitchen, Bar, Manager, menu).

## D. Icons

`lucide-react` installed but unused; UI uses emoji/text. Mobile: `lucide-react-native` or `@expo/vector-icons`.

## E. Charts / dates

`recharts` in `pages/manager/AnalyticsPage.tsx`, `ReportsPage.tsx` (web only). `date-fns` `formatDistanceToNow` in `KitchenQueuePage.tsx`, `BarQueuePage.tsx`.

## F. Screens to mirror

| Mobile | Web source | Notes |
|---|---|---|
| Login | `pages/LoginPage.tsx` | username+password only |
| Floor | `pages/FloorMapPage.tsx`, `components/ResourceCard.tsx` | `floor:update` + `/resources` |
| Ticket | `pages/TicketPage.tsx`, `components/AddItemModal.tsx`, `TransferModal.tsx`, `EditPaymentModal.tsx` | joins `ticket:<id>` (TicketPage.tsx:149) |
| Kitchen/Bar queue | `pages/KitchenQueuePage.tsx`, `BarQueuePage.tsx` | `kitchen:update`/`bar:update` |
| Manager PIN | `components/ManagerPinDialog.tsx` | `POST /auth/verify-pin` |
| Waiting list | `components/WaitingListPanel.tsx` | `waiting:update` |
| Print failure | `components/PrintRetryBanner.tsx` | `print:failed` |
| Manager | `pages/manager/*.tsx` (13) | low mobile priority |

## G. i18n

i18next 26 + react-i18next 17 (`$SRC/i18n/index.ts`). **Spanish (`es`) default, English (`en`) second**, `fallbackLng 'es'`. Resources `$SRC/i18n/es.ts`, `en.ts` (plain object literals, 366 lines each) — directly importable. Some hardcoded strings remain (e.g. "Bola 8 Pool Club").

## H. Locale

Money = integer cents on wire. TZ `America/Mexico_City` (`backend/app/config.py`). Locale `es-MX`.

## I. Not transferable

`ErrorBoundary.tsx`, DOM root/`BrowserRouter`, `react-router-dom`, `react-hot-toast`, localStorage print queue.
