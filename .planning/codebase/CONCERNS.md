# Codebase Concerns

**Analysis Date:** 2026-04-20

## Security Concerns

**1. Hardcoded Default Credentials in Production**
- Issue: Default credentials displayed in README and LoginPage component
- Files: `README.md` line 31-39, `frontend/src/pages/LoginPage.tsx` line 71
- Impact: Anyone reading documentation has immediate access to admin/manager accounts. Critical security vulnerability if not rotated in production.
- Fix approach: Remove default credentials from code and documentation entirely. Document credential setup process in separate secure guide. Add pre-deployment validation to ensure credentials have been changed from defaults.

**2. Weak JWT Secret Configuration**
- Issue: Default fallback secrets "dev-secret-change-me" and "dev-refresh-secret"
- Files: `backend/app/config.py` lines 5, 8-9
- Impact: If environment variables aren't set (operational error), system falls back to weak hardcoded secrets. Tokens become forgeable.
- Fix approach: Remove all fallback defaults for secrets. Force environment variables to be set. Add startup validation that fails if secrets are still default values.

**3. Overly Permissive CORS Configuration**
- Issue: Socket.IO and CORS allow all origins: `cors_allowed_origins="*"` and `{"origins": "*"}`
- Files: `backend/app/extensions.py` line 12, `backend/app/__init__.py` line 19
- Impact: Any website can make requests to the API and establish WebSocket connections. Enables CSRF attacks, cross-site data leaks, and unauthorized order manipulation.
- Fix approach: Restrict CORS to specific frontend domain via environment variable. For Socket.IO, specify allowed origins explicitly. Add CSRF token verification.

**4. PIN Verification Loops Through All Managers**
- Issue: PIN verification iterates through all active managers to find a match
- Files: `backend/app/api/auth.py` lines 71-82
- Impact: Timing attack possible - response time varies based on number of managers checked. Brute-force attempts don't clearly indicate failure until all managers checked. No rate limiting on PIN attempts per user context.
- Fix approach: Hash the PIN first, then do constant-time comparison. Use fixed response time. Add per-ticket rate limiting on PIN attempts (allow 3 failed attempts, then cooldown).

**5. Manager PIN Used Without Manager ID Verification**
- Issue: When voiding items, manager_id from client request is used without server verification that it matches the provided PIN
- Files: `backend/app/api/tickets.py` line 224-228
- Impact: Client could claim any manager_id after getting a valid PIN. No audit trail connects void action to correct manager. Authorization bypass.
- Fix approach: After PIN verification returns manager_id, re-verify that the PIN actually belongs to that manager. Store the manager_id server-side, don't accept it from client.

**6. Weak Input Validation on Discount Percentage**
- Issue: Manual discount pct accepted without clear bounds validation
- Files: `frontend/src/pages/TicketPage.tsx` line 90, `backend/app/api/tickets.py` (discount endpoint not shown but referenced)
- Impact: Manager could set 100%+ discounts, negative discounts, or invalid values. Creates accounting gaps.
- Fix approach: Add strict validation (0-100 range). Validate server-side with explicit range check. Log all discount changes with before/after values.

**7. Token Expiration Not Enforced on Frontend**
- Issue: Access token stored in Zustand persist but no automatic refresh or expiration check
- Files: `frontend/src/stores/authStore.ts`, `frontend/src/api/client.ts` line 18
- Impact: Expired tokens may continue to be used until 401 response received. Users can keep using old tokens after they expire if refresh fails silently.
- Fix approach: Decode JWT and check expiration client-side. Proactively refresh before expiration. Clear token if refresh_token also expired.

## Authentication & Authorization Gaps

**1. Insufficient Role-Based Access Control**
- Issue: Frontend routes check role but backend doesn't consistently validate role for all operations
- Files: `frontend/src/pages/LoginPage.tsx` line 22-25, `backend/app/api/cash_session.py` lines 11-15 (inconsistent pattern)
- Impact: Frontend can be bypassed with direct API calls to unauthorized endpoints. Manager operations might be callable by waiters with token manipulation.
- Fix approach: Add @requires_role('MANAGER', 'ADMIN') decorator to all sensitive endpoints. Validate on every protected endpoint, not just some. Test backend endpoints directly without frontend.

**2. No Audit Trail for Critical Operations**
- Issue: Audit logging exists in some places but not comprehensive; cash operations and PIN usage need stronger logging
- Files: `backend/app/services/audit_svc.py` (exists but incomplete usage)
- Impact: Cannot trace who made financial changes. Dispute resolution difficult. Regulatory compliance risk for POS system.
- Fix approach: Log every ticket modification, payment, void, discount, and cash session change with user_id, timestamp, before/after state. Add audit log export functionality.

## State Management & Concurrency Issues

**1. Race Condition on Ticket Updates**
- Issue: Optimistic version checking only on add_item operation, not on all modifications
- Files: `backend/app/api/tickets.py` lines 138-146 (version check only here)
- Impact: Two users modifying same ticket simultaneously can cause inconsistent state. Sent orders might be applied twice or lost.
- Fix approach: Add version field to all mutable operations (discount, transfer, payment). Use optimistic locking pattern throughout. Document version semantics.

**2. Pool Timer Not Protected from Race Conditions**
- Issue: Timer sessions created/stopped without row-level locking between read and write
- Files: `backend/app/api/tickets.py` lines 21-42, 293-349
- Impact: If multiple requests stop same timer, charge_cents could be calculated twice, duplicate charges, or missing charges.
- Fix approach: Lock pool_timer_sessions row when reading for update. Use with_for_update() before calculating charges. Add idempotency check (ensure charge only applied once).

**3. Inventory Not Truly Atomic**
- Issue: Inventory check and consume are separate operations; concurrent orders might both pass stock check
- Files: `backend/app/services/inventory_svc.py` lines 6-37 (check), lines 40-72 (consume)
- Impact: During high load, more items can be sold than exist in stock. Negative inventory possible.
- Fix approach: Implement pessimistic locking on inventory_items when checking stock. Combine check+consume in single atomic transaction. Add inventory validation before commit.

## Performance & Scalability Concerns

**1. Socket.IO Broadcasting to All Clients on Every Change**
- Issue: floor:update, kitchen:update, bar:update emitted broadly without filtering
- Files: `backend/app/api/tickets.py` lines 18, 93, 213, 286
- Impact: Every ticket change sends update to all floor clients, all kitchen staff, all bar staff. Scales poorly with hundreds of concurrent users. Unnecessary network traffic.
- Fix approach: Emit updates to specific rooms only (e.g., socket.emit(..., room=f'ticket:{ticket_id}'). Add query parameter to filter which tables/queues a user cares about.

**2. Refetch on Interval Without Debouncing**
- Issue: TicketPage refetches every 10 seconds, CashSessionPage every 15-30 seconds
- Files: `frontend/src/pages/TicketPage.tsx` line 67, `frontend/src/pages/manager/CashSessionPage.tsx` lines 42, 50
- Impact: Constant API calls even when user not actively viewing. High load on backend for idle clients. Battery drain on mobile.
- Fix approach: Implement smart refetch that adjusts interval based on page visibility. Use WebSocket subscription model instead of polling. Debounce simultaneous requests.

**3. No Query Pagination Limits**
- Issue: list_tickets() hardcoded to limit 100, list_sessions() to limit 30, but no consistent pagination strategy
- Files: `backend/app/api/tickets.py` line 130, `backend/app/api/cash_session.py` line 96
- Impact: Large result sets not explicitly handled. Frontend might fetch all records without offset parameter. Query performance degrades as data grows.
- Fix approach: Implement cursor-based or offset/limit pagination throughout. Add limit/offset parameters with validation. Return pagination metadata (hasMore, total count).

**4. Unindexed Foreign Key Queries**
- Issue: Multiple queries iterate through relationships without clear indexes (e.g., all modifiers for item, all timer sessions for ticket)
- Files: `backend/app/models/ticket.py` line 36-37, `backend/app/api/tickets.py` line 156
- Impact: As tickets/items scale, querying related objects becomes slow. Database full table scans likely.
- Fix approach: Add composite indexes on common query patterns (ticket_id + status, resource_id + status, modifier_group_id). Use eager loading (.joinedload()) where appropriate.

## Data Integrity & Business Logic Gaps

**1. Reopened Ticket Logic Incomplete**
- Issue: was_reopened flag set but handling not consistent; reopened tickets can accumulate multiple charges
- Files: `backend/app/models/ticket.py` line 22, `backend/app/api/tickets.py` line 342
- Impact: Complex edge case where ticket reopened after closure might have stale pool timer or duplicate items. Financial report accuracy compromised.
- Fix approach: Add explicit state machine (OPEN -> CLOSED -> REOPENED_PENDING -> CLOSED). Validate before reopening (no active timer exists). Audit all reopening operations.

**2. Manual Discount Not Validated Against Item Prices**
- Issue: Discount percentage applied to subtotal without checking if discount exceeds actual value
- Files: `backend/app/models/ticket.py` line 51, logic at ticket close
- Impact: Discount could exceed cost of items. Manager might accidentally apply 100% discount when intending 10%. No confirmation dialog.
- Fix approach: Validate discount amount server-side (max discount = subtotal). Require second confirmation for discounts >25%. Log discount reason in audit trail.

**3. Tip Distribution Not Validated Against Configuration**
- Issue: Tip configuration (floor/bar/kitchen split) can be edited without distributing existing tips
- Files: `backend/app/api/cash_session.py` lines 100+
- Impact: Tip distribution rules changed mid-shift, affecting tips earned before change. Staff paid incorrectly. Disputes over tip allocation.
- Fix approach: Lock tip distribution config once session opens. Store tip config snapshot at session open time. Update config only when session closed.

**4. Pool Time Billing Doesn't Account for Session Interruptions**
- Issue: Timer sessions assume continuous use; no support for pause/resume (game interrupted, table changed)
- Files: `backend/app/services/billing.py` lines 5-35
- Impact: If customer leaves table mid-game and returns later, timer continues or restarts, potentially losing time/undercharging.
- Fix approach: Add pause/resume capability to timer. Aggregate multiple timer sessions for same ticket. Allow manager to manually adjust time with audit logging.

## Frontend Architecture & Component Issues

**1. TicketPage Component Too Large**
- Issue: Single component handles 741 lines - modals, forms, socket updates, state management
- Files: `frontend/src/pages/TicketPage.tsx` (full file)
- Impact: Difficult to test, modify, or reuse logic. Multiple state update flows cause bugs. Hard to isolate concerns.
- Fix approach: Extract AddItemModal, TransferModal, PaymentForm into separate components. Create custom hooks for ticket operations (useTicketOperations, usePaymentFlow). Separate business logic from UI.

**2. No Error Boundary on Pages**
- Issue: Frontend pages have try/catch on API calls but no ErrorBoundary component for render errors
- Files: `frontend/src/pages/*.tsx` all files
- Impact: Runtime errors in render cause full page crash. User sees blank screen. No fallback UI.
- Fix approach: Wrap page components with ErrorBoundary. Add fallback UI that suggests refresh or contact support. Log errors to monitoring service.

**3. Zustand Store No Persistence Configuration**
- Issue: Auth store persists to localStorage but not validated on load
- Files: `frontend/src/stores/authStore.ts` line 26
- Impact: Corrupted auth data in localStorage could cause infinite login loops. Stale tokens persist across browser restarts.
- Fix approach: Add validation on Zustand rehydration. Check token expiration before using stored credentials. Clear storage if validation fails.

## Testing & Quality Gaps

**1. No Test Coverage Detected**
- Issue: No .test.tsx, .test.ts, .test.py files found in codebase
- Impact: Cannot safely refactor. Regressions go undetected. Business logic bugs discovered by users. Difficult to onboard new developers.
- Fix approach: Add test infrastructure (Jest for frontend, pytest for backend). Start with critical paths: authentication, payments, inventory deduction. Target 60%+ coverage for business logic.

**2. No E2E Tests**
- Issue: No Cypress/Playwright tests for complete user flows
- Impact: Cannot test multi-step operations (open session -> create ticket -> add items -> void -> close payment). Integration bugs missed.
- Fix approach: Add E2E tests for core workflows. Test role-based access. Test concurrent operations. Run on CI/CD.

**3. Input Validation Inconsistency**
- Issue: Frontend has some validation (empty fields) but backend validation sparse
- Files: Frontend uses basic checks, backend relies on try/except
- Impact: Invalid data can be persisted if frontend validation is bypassed. Database errors surface to users.
- Fix approach: Add marshmallow schemas for all POST/PATCH endpoints. Validate in middleware. Return clear validation error messages.

## Configuration & Deployment Issues

**1. Weak Default Secrets in Docker Compose**
- Issue: docker-compose.yml has default credentials that aren't strong
- Files: `docker-compose.yml` lines 9, 29-31
- Impact: Any developer running docker-compose gets weak database password. If accidentally committed to git, compromised.
- Fix approach: Use .env.example template without passwords. Add env validation script that fails if secrets still default. Document secure secret rotation.

**2. No Logging Configuration**
- Issue: Basic logging setup in Flask, no structured logging or log levels per module
- Files: `backend/app/__init__.py` lines 10-13
- Impact: Debugging production issues difficult. No correlation IDs for requests. Cannot trace multi-service calls.
- Fix approach: Add structured logging (JSON format). Use correlation IDs for request tracing. Add log level controls per module. Send logs to centralized service.

**3. No Secrets Management**
- Issue: All secrets configured via environment variables; no secret rotation mechanism
- Files: `backend/app/config.py` (reads env vars)
- Impact: Changing secrets requires redeployment. No audit of secret access. If a secret leaks, no easy rotation.
- Fix approach: Integrate with secret manager (AWS Secrets Manager, Vault, or similar). Implement automatic secret rotation. Audit all secret access.

**4. Health Check Only Checks App, Not Database**
- Issue: /api/v1/health returns 200 even if database is down
- Files: `backend/app/__init__.py` line 309
- Impact: Load balancer/orchestrator thinks service is healthy when it can't actually function. Downtime extended by false healthiness.
- Fix approach: Add database connectivity check to health endpoint. Return 503 if database unreachable. Add readiness and liveness probe distinction.

## Known Bugs & Issues

**1. Inventory Yield Logic Not Implemented**
- Issue: yields_item_id field on InventoryItem exists but never used (e.g., tequila bottle -> shot conversion)
- Files: `backend/app/__init__.py` line 74, but no consume logic for yields
- Impact: If a bottle yields 15 shots, consuming 1 shot doesn't decrement the bottle. Inventory tracking inaccurate.
- Fix approach: Implement bottle-to-shot conversion. When shot consumed, check if it has parent bottle; decrement bottle. Handle partial bottle usage.

**2. Modifier Allow Multiple Not Used**
- Issue: allow_multiple flag on ModifierGroup (line 75) but never enforced in frontend/backend
- Files: `backend/app/__init__.py` line 75, no usage detected
- Impact: If allow_multiple=True, user might select same modifier multiple times but validation doesn't enforce it.
- Fix approach: Validate min_selections/max_selections in add_item endpoint. Return clear error if user violates constraints. Test multi-selection UI.

**3. Null Pointer Risk in Resource Relationship**
- Issue: ticket.resource could be None (deleted resource, orphaned ticket)
- Files: `backend/app/models/ticket.py` line 67
- Impact: to_dict() calls self.resource.code without null check. 500 error if resource missing.
- Fix approach: Add null check before accessing resource attributes. Return resource_code as None if missing. Add database constraint to prevent orphaned tickets.

## Fragile Areas Requiring Careful Modification

**1. Billing Calculation Engine**
- Files: `backend/app/services/billing.py`
- Why fragile: Three billing modes (PER_MINUTE, ROUND_15, PER_HOUR) with complex rounding. One line change affects all revenue. Unit tests missing.
- Safe modification: Add comprehensive unit tests for all modes with edge cases (1 second, 1 minute, just under 15 min boundary). Create spec document for each billing mode. Test with financial accuracy.
- Test coverage gaps: No tests for corner cases (promo_free_seconds, fractional cent rounding, mode transitions).

**2. Inventory Consumption & Reversal**
- Files: `backend/app/services/inventory_svc.py`
- Why fragile: Consume and reverse are separate functions; if one succeeds and other fails, inventory corrupted. Modifier rules and menu item ingredients both contribute.
- Safe modification: Extract common logic. Add transaction wrapper. Test consume+void cycle. Verify final inventory state matches expected.
- Test coverage gaps: No tests for concurrent consume/reverse, modifier rules application, shortages with multiple modifiers.

**3. Socket.IO Event Flow**
- Files: `backend/app/sockets/events.py`, `frontend/src/hooks/useSocket.ts`
- Why fragile: Multiple components emit and listen to same events. Order of operations matters. Race conditions if event races with HTTP request.
- Safe modification: Document all events and their payloads. Ensure HTTP requests also update local state. Test synchronization between WebSocket and HTTP.
- Test coverage gaps: No tests for event ordering, lost messages, reconnection logic.

## Dependencies at Risk

**1. Eventlet Async Library (Low Activity)**
- Risk: eventlet used for Flask-SocketIO async mode but project has low maintenance
- Impact: Security vulnerabilities in eventlet won't be patched. Flask-SocketIO might drop eventlet support.
- Migration plan: Consider switching to python-socketio's async mode with asyncio instead of eventlet.

**2. Outdated React Query Usage Pattern**
- Risk: Frontend uses useQuery polling pattern instead of subscription model
- Impact: Not leveraging React Query's strength. Inefficient network usage.
- Migration plan: Replace polling with socket.io subscriptions for real-time data. Use React Query for non-real-time operations.

## Missing Critical Features

**1. No Backup/Disaster Recovery**
- Problem: No backup strategy for PostgreSQL data documented. Single database instance with no replication.
- Blocks: Cannot recover from data loss, disk failure, or corruption.
- Recommendation: Add automated daily backups. Test restore process monthly. Document disaster recovery procedure.

**2. No Multi-Location Support**
- Problem: System assumes single bar/location. No tenant isolation, location-specific pricing, or consolidated reporting.
- Blocks: Cannot scale to multiple venues without data model redesign.
- Recommendation: Plan multi-location architecture early. Add location_id to relevant tables. Scope credentials to location.

**3. No Mobile App or Responsive Design Verification**
- Problem: Frontend not tested on tablets/phones. Touch interactions not optimized.
- Blocks: Staff cannot work efficiently on floor with mobile devices. Waiters need portable POS.
- Recommendation: Add mobile-responsive breakpoints. Test on actual devices. Consider native mobile app.

## Test Coverage Gaps

**1. Pool Timer Calculations**
- What's not tested: All three billing modes (PER_MINUTE, ROUND_15, PER_HOUR), promo free time deduction, charge_cents accuracy
- Files: `backend/app/services/billing.py`
- Risk: Customers overbilled or underbilled without detection. Revenue impact.
- Priority: HIGH - Add parametrized tests for all mode/scenario combinations

**2. Inventory State After Void**
- What's not tested: Inventory reversal when voiding items with modifiers, multiple modifier rules, edge case with 0 qty left
- Files: `backend/app/services/inventory_svc.py`, `backend/app/api/tickets.py` void_item function
- Risk: Inventory becomes negative or stuck. Staff can't order items that should be available.
- Priority: HIGH - Test consume+void cycle, concurrent voids, modifier rule application

**3. Authentication & Authorization**
- What's not tested: PIN verification brute force, role escalation attempts, expired token handling, concurrent login/logout
- Files: `backend/app/api/auth.py`, `backend/app/api/cash_session.py`
- Risk: Unauthorized access, account takeover, admin operations by staff.
- Priority: HIGH - Add security-focused unit tests, load test PIN endpoint

**4. Payment Processing**
- What's not tested: Split payments (cash + card), tip calculations, manual discounts combined with promos, negative totals
- Files: `backend/app/api/tickets.py` close_ticket function
- Risk: Customers not charged correctly, financial reports inaccurate, tip distribution wrong.
- Priority: HIGH - Test all payment combinations, edge cases

---

*Concerns audit: 2026-04-20*
