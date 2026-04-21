# Architecture

**Analysis Date:** 2026-04-20

## Pattern Overview

**Overall:** Three-tier client-server architecture with real-time synchronization

**Key Characteristics:**
- RESTful API backend (Flask) with WebSocket event broadcasting for live updates
- React SPA frontend with Zustand for state management and React Query for server cache
- JWT authentication with role-based access control
- Event-driven resource synchronization across connected clients
- Domain-driven organization (by feature: tickets, resources, inventory, etc.)

## Layers

**API/Routes:**
- Purpose: HTTP endpoints for client requests and REST operations
- Location: `backend/app/api/*.py`
- Contains: Flask blueprints for each domain (auth, tickets, resources, menu, inventory, reports, etc.)
- Depends on: Models, services, extensions (db, jwt, socketio)
- Used by: Frontend via axios client

**Models/Domain:**
- Purpose: Database schema and business entity definitions
- Location: `backend/app/models/*.py`
- Contains: SQLAlchemy ORM models (User, Ticket, Resource, PoolTableConfig, MenuItem, InventoryItem, etc.)
- Depends on: Database extensions (db, UUID generation)
- Used by: API routes and services

**Services/Business Logic:**
- Purpose: Stateless business operations and calculations
- Location: `backend/app/services/*.py`
- Contains: Billing calculations (`billing.py`), inventory rules (`inventory_svc.py`), promotions (`promotion_svc.py`), audit logging (`audit_svc.py`)
- Depends on: Models, database
- Used by: API routes

**WebSocket Events:**
- Purpose: Real-time event broadcasting to connected clients
- Location: `backend/app/sockets/events.py`
- Contains: Socket.IO event handlers (join/leave/connect/disconnect)
- Depends on: Socket.IO extension, JWT verification
- Used by: API routes (emit updates after state changes)

**Frontend Pages:**
- Purpose: Route-specific views with complex state and interactions
- Location: `frontend/src/pages/*.tsx`
- Contains: Full-page components (FloorMapPage, TicketPage, KitchenQueuePage, ManagerDashboard, etc.)
- Depends on: Components, hooks, stores, API client, React Router
- Used by: App.tsx routing

**Frontend Components:**
- Purpose: Reusable UI elements and modals
- Location: `frontend/src/components/*.tsx`
- Contains: ResourceCard, AddItemModal, TransferModal, ManagerPinDialog, NavBar, WaitingListPanel
- Depends on: Hooks, stores, client, tailwindcss
- Used by: Pages

**Frontend Stores:**
- Purpose: Client-side application state (persisted or ephemeral)
- Location: `frontend/src/stores/*.ts`
- Contains: `authStore` (user/token), `floorStore` (resources list and updates)
- Depends on: Zustand with persistence middleware
- Used by: Pages and components

**Frontend Hooks:**
- Purpose: Reusable stateful logic and integrations
- Location: `frontend/src/hooks/*.ts`
- Contains: `useSocket` (WebSocket context), `useTimer` (elapsed time for pool timers), `useEscKey` (modal closing), `useLanguage` (i18n)
- Depends on: React hooks, Socket.IO client, i18next
- Used by: Pages and components

**API Client:**
- Purpose: HTTP request abstraction with authentication
- Location: `frontend/src/api/client.ts`
- Contains: Axios instance with JWT interceptors and error handling
- Depends on: Axios, authStore
- Used by: Pages and components (via `client.get/post/patch/delete`)

## Data Flow

**Opening a Ticket (Resource/Table):**

1. User clicks "Open" on a resource card in `FloorMapPage` → triggers `handleOpenNew`
2. Modal prompts for customer name → `confirmOpen` posts to `POST /api/v1/tickets`
3. Backend `tickets_bp.open_ticket()` creates Ticket record, marks Resource as `IN_USE`, starts PoolTimerSession if pool table
4. Backend emits `floor:update` WebSocket event to all clients in "floor" room
5. Frontend `useSocket` hook receives event, invalidates React Query cache for resources
6. `FloorMapPage` re-fetches resources and updates `floorStore.setResources()`
7. All open browser tabs see updated floor state immediately

**Adding Item to Ticket:**

1. User in TicketPage clicks "Add Item" → shows AddItemModal
2. Modal selection posts to `POST /api/v1/tickets/{id}/items`
3. Backend `add_line_item()` creates TicketLineItem, recalculates ticket totals
4. Backend emits `floor:update` event (triggers resource refresh on all clients)
5. Frontend `useQuery(['ticket', id])` with refetchInterval:10s picks up changes
6. TicketPage re-renders with updated items and totals

**Closing/Paying a Ticket:**

1. User in TicketPage selects payment method and tendered amount
2. POST to `POST /api/v1/tickets/{id}/close` with payment details
3. Backend `close_ticket()` stops active pool timer, calculates final charges, records payment
4. Backend emits `floor:update` event + invalidates ticket cache
5. Resource transitions to `AVAILABLE` status
6. Frontend redirects to FloorMapPage with refreshed resource list

**Real-time Floor Updates:**

- Backend uses `socketio.emit('floor:update', {}, room='floor')` after resource/ticket state changes
- Frontend hook listens: `socket.on('floor:update', () => client.get('/resources')...)`
- All clients in "floor" room receive update within milliseconds
- Cache updates via `qc.setQueryData(['resources'], r.data)` for immediate UI update
- Subsequent queries see fresh data without waiting for polling interval

## Key Abstractions

**Ticket Lifecycle:**

- Purpose: Represents a customer session at a resource (table, bar seat, pool table)
- Examples: `backend/app/models/ticket.py`, API routes in `backend/app/api/tickets.py`
- Pattern: Status-based (OPEN, CLOSED, VOID); line items added via `TicketLineItem`; totals recalculated on each change
- Key methods: `recalculate_totals()` (sums items + modifiers - discounts + pool time)

**Resource (Table/Seat/Pool):**

- Purpose: Physical location where service is provided (billing unit)
- Examples: `backend/app/models/resource.py`, `frontend/src/stores/floorStore.ts`
- Pattern: Status-based (AVAILABLE, IN_USE, MAINTENANCE); type-based (POOL_TABLE, BAR_SEAT, REGULAR_TABLE); typed config for pool tables
- Key methods: Linked to active Ticket; timer session tracked in PoolTimerSession

**Menu/MenuItem/Modifier System:**

- Purpose: Flexible menu structure with customizable modifiers
- Examples: `backend/app/models/menu.py`
- Pattern: MenuCategory → MenuItem → ModifierGroup (with Modifier choices); ModifierInventoryRule ties modifiers to inventory consumption
- Key constraint: ModifierGroup.allow_multiple determines if multiple modifiers from same group can be selected

**Pool Timer Session:**

- Purpose: Tracks elapsed time and billing for pool table usage
- Examples: `backend/app/models/ticket.py` (PoolTimerSession relationship)
- Pattern: Starts when ticket opened on pool table; runs until explicitly stopped or ticket closed
- Billing modes: PER_MINUTE, ROUND_15 (round to nearest 15 min), PER_HOUR
- Key calculation: Deducts promo_free_seconds before charging (see `backend/app/services/billing.py`)

**Promotion/Discount System:**

- Purpose: Apply fixed or percentage discounts to tickets
- Examples: `backend/app/models/promotion.py`, `backend/app/services/promotion_svc.py`
- Pattern: LineItemPromotion joins Ticket and Promotion; manager PIN required for manual discounts
- Key constraint: Happy hour automatic if in time range; manual discount requires manager verification

**Audit Trail:**

- Purpose: Comprehensive logging of state changes for accountability
- Examples: `backend/app/models/audit.py`, `backend/app/services/audit_svc.py`
- Pattern: Every operation logged with before/after state, user_id, operation type, ip_address
- Key usage: Track sensitive operations (voids, discounts, manager actions, logins)

## Entry Points

**Backend Application:**

- Location: `backend/app/__init__.py`
- Triggers: Flask app factory called from `backend/wsgi.py` (gunicorn entry point)
- Responsibilities: Initialize extensions (db, jwt, socketio, cors, limiter), register blueprints, define CLI commands (init-db, seed-beer)
- Key initialization: `db.init_app()`, `jwt.init_app()`, `socketio.init_app()`

**Frontend Application:**

- Location: `frontend/src/main.tsx`
- Triggers: Browser loads `index.html`, runs `<script>` tag pointing to main.tsx
- Responsibilities: Create React root, wrap App with providers (QueryClientProvider, BrowserRouter, SocketProvider), attach to DOM
- Key providers: QueryClient with 30s staleTime, Toaster for notifications

**Frontend Router:**

- Location: `frontend/src/App.tsx`
- Triggers: BrowserRouter initialization
- Responsibilities: Define all routes and role-based access guards via `RequireAuth` component
- Key routes: `/login`, `/floor` (main), `/ticket/:id`, `/queue/kitchen`, `/queue/bar`, `/manager/*` (dashboard, reports, inventory, menu, users, pool-config, tables, cash, settings)

**Authentication Flow:**

- Entry: `frontend/src/pages/LoginPage` → posts to `POST /api/v1/auth/login`
- Backend: `backend/app/api/auth.py::login()` validates credentials, returns access_token + user
- Storage: `useAuthStore.login()` persists user/token to localStorage
- Interception: `frontend/src/api/client.ts` adds `Authorization: Bearer <token>` to all requests
- Guard: `RequireAuth` component checks `useAuthStore.user`; 401 responses trigger logout + redirect to `/login`

**WebSocket Connection:**

- Entry: `frontend/src/hooks/useSocket.ts` creates `SocketProvider` wrapper
- Initialization: On mount (and user login), creates `io('/', { transports: ['websocket', 'polling'] })`
- Room Joining: Client emits `join` events for `floor`, `kitchen` (if staff), `bar` (if staff)
- Lifecycle: Connects on mount, subscribes to events, disconnects on unmount
- Usage: Consumed via `useSocket()` hook or automatic React Query invalidation from `useSocket` effect

## Error Handling

**Strategy:** Layered error responses with specific error codes and HTTP status codes

**Patterns:**

- **Authentication Errors (401):** `INVALID_CREDENTIALS`, `UNAUTHORIZED` → redirect to login
- **Authorization Errors (403):** `FORBIDDEN` → redirect to allowed page based on role
- **Validation Errors (400):** `BAR_CLOSED`, `TABLE_HAS_OPEN_TICKET`, `POOL_TABLE_OCCUPIED` → user-facing toast messages
- **Not Found (404):** SQLAlchemy `.get_or_404()` used across API routes
- **Conflict (409):** Resource state conflicts (e.g., table already in use) → prevent race conditions
- **Client-side:** Axios interceptor catches 401, calls `useAuthStore.logout()`, redirects to `/login`
- **UI Feedback:** React Hot Toast displays error messages from API response `data.message` or generic fallback

## Cross-Cutting Concerns

**Logging:** 

- Backend: Python `logging` module configured in app factory; logs to console with timestamp, level, module, message
- Audit: Centralized `audit_svc.log()` function tracks entity changes (tickets, resources, users) with before/after state

**Validation:**

- Backend: Marshmallow schemas in `backend/app/schemas/*.py` validate request payloads
- Frontend: Client-side form validation in modal components (e.g., TicketPage payment form)
- Database: SQLAlchemy model constraints (unique, nullable, foreign keys)

**Authentication:**

- Backend: Flask-JWT-Extended with `@jwt_required()` decorator on all protected routes
- Claims: JWT includes role and name for client-side authorization checks
- Refresh: Refresh token endpoint for obtaining new access tokens without re-login
- Manager PIN: Special verification via `verify-pin` endpoint for sensitive operations

**Authorization:**

- Role-based: Routes check `get_jwt()` claims for role membership
- Helper: `require_manager()` in `resources.py` standardizes manager/admin checks
- Frontend: `RequireAuth` component enforces role restrictions on routes and buttons disabled for non-managers

**Real-time Sync:**

- WebSocket rooms: floor, kitchen, bar, ticket:{ticket_id}, waiting
- Event flow: API changes → emit WebSocket event → client cache invalidation → React Query refetch
- Polling fallback: Client uses polling transport if WebSocket unavailable
- Frontend polling: React Query refetchInterval as fallback (10-30s depending on query)

---

*Architecture analysis: 2026-04-20*
