# Coding Conventions

**Analysis Date:** 2026-08-08

## Naming Patterns

**Files (backend, `backend/app/`):**
- `snake_case.py` throughout — `promotion_svc.py`, `cash_session.py`, `waiting_list.py`.
- Blueprints live in `api/` and are named after the resource: `api/tickets.py`, `api/inventory.py`, `api/waiting_list.py`.
- Services live in `services/` and are suffixed `_svc.py` when they wrap business logic invoked from multiple routes: `services/promotion_svc.py`, `services/audit_svc.py`, `services/inventory_svc.py`. Non-suffixed service modules (`services/billing.py`, `services/printer_service.py`) exist too — no strict rule, but new cross-cutting logic should default to the `_svc.py` suffix to match the majority.
- Models live in `models/`, one file per aggregate: `models/ticket.py`, `models/promotion.py`, `models/user.py`.

**Files (frontend, `frontend/src/`):**
- Components: `PascalCase.tsx` — `AddItemModal.tsx`, `ResourceCard.tsx`, `ManagerPinDialog.tsx`.
- Pages: `PascalCase.tsx`, suffixed `Page` — `TicketPage.tsx`, `FloorMapPage.tsx`. Manager-only pages live under `pages/manager/`.
- Hooks: `camelCase.ts`, prefixed `use` — `hooks/useSocket.ts`, `hooks/useTimer.ts`, `hooks/useEscKey.ts`.
- Stores (Zustand): `camelCase.ts`, suffixed `Store` — `stores/authStore.ts`, `stores/floorStore.ts`.
- Utilities: `camelCase.ts` under `utils/` — `utils/money.ts`, `utils/printReceipt.ts`, `utils/a11y.ts`.

**Functions:**
- Backend: `snake_case` — `compute_quantity_promo_discounts`, `recompute_quantity_promos`, `_stop_active_timer`. Leading underscore marks module-private helpers (`_parse_time`, `_ticket_units`, `_emit_floor_update`).
- Frontend: `camelCase` — `groupModifiers`, `formatMXN`, `refreshAll`. Local helper functions defined at module scope inside a page file (e.g. `cents()`, `groupLineItemsUI()` in `TicketPage.tsx`) are common — colocate small pure helpers above the component rather than extracting to `utils/` unless reused across files.

**Variables:**
- Money is always stored and passed as **integer cents** (`price_cents`, `total_cents`, `discount_cents`) — never floats. Convert to display currency only at the render/format boundary (`formatMXN` in `utils/money.ts`).
- IDs are UUID strings (`db.String(36)`, `default=lambda: str(uuid.uuid4())`), never auto-increment integers.
- Enum-like state fields are UPPER_SNAKE string columns, not real DB enums: `status = 'OPEN' | 'CLOSED' | 'CANCELLED'`, `ticket_type = 'TABLE' | 'EXPRESS' | 'DELIVERY'`, `promo_type = 'BOGO' | 'QTY_PERCENT_DISCOUNT'`. Valid values are documented in an inline comment next to the column, e.g. `status = db.Column(db.String(10), default='OPEN')  # OPEN, CLOSED, VOID`.
- React component local state uses `useState` extensively with descriptive names reflecting UI intent, not just data shape: `showPinForVoid`, `voidQtyPicker`, `pendingDiscountPct`, `decidingPromo`. Boolean flags are prefixed `show`/`is`/`voiding`/`closing` + verb.

**Types (TypeScript):**
- Interfaces are `PascalCase` (`User`, `AuthState`, `Props`, `State`).
- Inline object/array types are used liberally instead of dedicated interfaces for local component state (`useState<{ ids: string[]; name: string } | null>(null)`), and `any` is used pragmatically for API response payloads (`const [closedTicket, setClosedTicket] = useState<any>(null)`) rather than modeling every backend response as a TS type. Do not treat `any` usage as a bug to fix opportunistically — it is the established pattern for loosely-typed API payloads in this codebase.

## Code Style

**Formatting:**
- No Prettier/ESLint config present in `frontend/` (no `.eslintrc*`, `.prettierrc*`, or `eslint.config.*`). Style is enforced by convention/review, not tooling. Match surrounding code exactly rather than reformatting.
- No `black`/`flake8`/`ruff` config in `backend/`. Same rule: match existing style in the file being edited.
- Indentation: 2 spaces (TS/TSX), 4 spaces (Python).
- No semicolons omitted consistently in TS — code uses no trailing semicolons in most files (ASI style), e.g. `const client = axios.create({...})` with no `;`.
- Single quotes preferred in both TS and Python (`'OPEN'`, `'/api/v1'`).

**Linting:**
- Not configured. `tsconfig.json` has `strict: true` but `noUnusedLocals: false` and `noUnusedParameters: false` — unused locals/params are tolerated, do not add stricter lint rules unilaterally.

## Import Organization

**Backend (Python) order (observed in `api/tickets.py`, `app/__init__.py`):**
1. Standard library (`os`, `json`, `datetime`)
2. Third-party (`flask`, `flask_jwt_extended`, `sqlalchemy`)
3. Local app imports (`app.extensions`, `app.models.*`, `app.services.*`)

Local imports inside function bodies are common and intentional — used to avoid circular imports between blueprints/models (e.g. `from app.models.cash_session import CashSession` inside `open_ticket()`, `from app.api.auth import verify_manager_pin` inside `edit_payment()`). Follow this pattern when adding a new cross-module dependency that would otherwise create a circular import at module load time.

**Frontend (TS) order (observed in `TicketPage.tsx`):**
1. React / third-party libs (`react`, `react-router-dom`, `@tanstack/react-query`, `react-i18next`)
2. Local components (`../components/...`)
3. Local stores/hooks (`../stores/...`, `../hooks/...`)
4. `../api/client`
5. Other third-party (`react-hot-toast`)
6. Local utils (`../utils/...`)
7. Icon imports last

**Path Aliases:**
- `@/*` → `src/*` is configured in `tsconfig.json` but source files in practice use relative imports (`../components/...`, `../stores/...`) rather than the alias. Prefer relative imports to match existing files unless the alias is already used in the file you're editing.

## Error Handling

**Backend:**
- API routes return `jsonify({'error': 'CODE', 'message': '...'})` with an explicit HTTP status code (422, 403, 404, 409, etc.) — never raise unhandled exceptions for expected validation failures. Error codes are UPPER_SNAKE strings meant to be matched by the frontend (`'TICKET_CLOSED'`, `'OUT_OF_STOCK'`, `'RESOURCE_OCCUPIED'`, `'VERSION_CONFLICT'`).
- `message` is often user-facing Spanish text shown directly in a toast (e.g. `f'{resource.code} ya está en uso'`), while `error` is the machine-readable code. Both are commonly present but `message` is optional for purely internal codes.
- Optimistic concurrency: mutating routes read `X-Ticket-Version` header and compare against `ticket.version`, returning `{'error': 'VERSION_CONFLICT'}, 409` on mismatch (see `add_item` in `backend/app/api/tickets.py`).
- Row locking: `Model.query.with_for_update().get_or_404(id)` is the standard pattern before mutating a row that could race (tickets, resources, waiting list entries, timer sessions).
- Background/best-effort work (auto-print) is wrapped so failures never fail the parent request: `_spawn_auto_print_chit` catches all exceptions inside the greenlet, sets `needs_reprint=True`/`PrintJob.status='FAILED'`, and emits a socket event — comment explicitly states "Print failure NEVER blocks or fails the order."
- Domain validation errors inside services are raised as `ValueError` with a prefixed code string (e.g. `'OUT_OF_STOCK:...'`) and caught at the API layer to translate into the right JSON error (see `update_item_quantity`).
- Idempotent/one-off migration SQL in `flask init-db` swallows known-benign DB errors (`already exists`, `does not exist`) but logs unexpected `ProgrammingError`/`OperationalError` as warnings without crashing startup (`backend/app/__init__.py`).

**Frontend:**
- Axios response interceptor in `frontend/src/api/client.ts` centrally handles 401s: queues concurrent requests during a token refresh, retries once (`originalRequest._retry` guard), and force-logs-out + redirects to `/login` on refresh failure. New API calls do not need their own 401 handling.
- Mutation error handling at the call site typically shows `react-hot-toast` with the backend's `message` or a fallback Spanish string, e.g. `toast.error(err.response?.data?.message || 'Error al ...')`.
- `ErrorBoundary` (`frontend/src/components/ErrorBoundary.tsx`) is a class component wrapping the app (see `App.tsx`), rendering a full-screen Spanish "Algo salió mal" fallback with a reload button. `componentDidCatch` logs to `console.error` with a `[ErrorBoundary]` prefix.
- Some catch blocks intentionally swallow errors with no user feedback (noted as a known gap in `.impeccable/critique/2026-08-07T16-32-50Z__frontend-src.md` — heuristic #9). Do not assume every empty `catch {}` is dead code; check whether user feedback should be added when touching that flow.

## Logging

**Backend:** Python's `logging` module, configured once in `create_app()` (`backend/app/__init__.py`) with level from `Config.LOG_LEVEL` and a fixed format `'%(asctime)s %(levelname)s %(name)s %(message)s'`. Ad-hoc `print()` is also used for CLI/migration output (`flask init-db`) with emoji-free status markers (`'✓ Already applied'`, `'⚠️  Migration WARNING'`) — this is intentional for `flask init-db` console output, not a violation of the emoji-removal pass mentioned in git history (that pass targeted UI copy, not ops/CLI output).

**Frontend:** No structured logging library. `console.error` is used sparingly for genuine unexpected failures (e.g. `ErrorBoundary`). User-facing errors go through `react-hot-toast`, not the console.

## Comments

**When to Comment:**
- Comments are used heavily to explain **why**, especially for non-obvious business rules, past bugs, and regression-prevention: e.g. in `tickets.py`, `_close_linked_waiting_entry` explains why `'ASSIGNED'` must not be included in the active-status filter, referencing a historical bug. `transfer_ticket` explains why occupancy checks were widened beyond `POOL_TABLE`.
- Multi-line docstrings at the top of complex functions describe intent, edge cases, and invariants (see `update_item_quantity`, `edit_payment`, `_spawn_auto_print_chit` in `backend/app/api/tickets.py`).
- Test files carry an explicit docstring at the top summarizing the numbered scenarios being covered and the exact command to run them (see all three files in `backend/tests/`).
- Frontend components use inline comments to explain UI-state coupling to backend semantics, e.g. `groupModifiers()` in `TicketPage.tsx` explains that modifier rows are stored once per line item regardless of quantity.

**JSDoc/TSDoc:**
- Sparse but present for shared utilities meant to be reused, using `/** ... */` block comments with `@`-free prose (see `frontend/src/utils/money.ts`). Not required for page-local helper functions.

## Function Design

**Size:** Flask route handlers are long and do the full request lifecycle inline (validate → lock rows → mutate → recompute totals → audit log → commit → emit sockets → respond) rather than being decomposed into many tiny functions — see `close_ticket`, `add_item`, `transfer_ticket` in `backend/app/api/tickets.py` (each 60–150 lines). This is the established style for route handlers; do not force extraction into smaller functions purely for line-count reasons, but do extract genuinely reusable logic (as `_stop_active_timer`, `_close_linked_waiting_entry` already are).

**Parameters:** Service functions take explicit typed-ish parameters with defaults for optional context, e.g. `apply_promos_to_line_item(line_item, ticket, now: datetime = None)`. Route handlers pull everything from `request.get_json()` / `request.args` at the top of the function rather than accepting a schema-bound object (marshmallow schemas exist in `app/schemas/` but are not universally applied to every endpoint).

**Return Values:** Routes always return `jsonify(...)` plus an explicit status code tuple; 200 is implicit only for the default success case. Services return domain objects/dicts, not Flask responses, so they remain callable from tests without an app/request context (see `compute_quantity_promo_discounts` returning a plain `dict`).

## Module Design

**Exports:**
- Backend: modules export functions/classes directly (no `__all__` lists observed); blueprints export a single `<name>_bp` object per file, imported and registered in `app/__init__.py`.
- Frontend: components use `export default function ComponentName()`; hooks/stores/utils use named exports (`export function useSocket()`, `export const useAuthStore = ...`, `export function formatMXN(...)`).

**Barrel Files:** Not used. `i18n/index.ts` aggregates `en.ts`/`es.ts` into the i18next config (the one exception), but components/hooks/utils/stores are each imported directly from their own file path — there is no `index.ts` re-export layer for `components/`, `hooks/`, `stores/`, or `utils/`. Do not add one; follow the direct-import pattern already established.

---

*Convention analysis: 2026-08-08*
