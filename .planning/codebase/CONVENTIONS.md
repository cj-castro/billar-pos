# Coding Conventions

**Analysis Date:** 2026-04-20

## Naming Patterns

**Files:**
- React/TSX components: PascalCase (e.g., `LoginPage.tsx`, `NavBar.tsx`, `ResourceCard.tsx`)
- Non-component TypeScript: camelCase (e.g., `authStore.ts`, `useSocket.ts`, `client.ts`)
- Python modules/files: snake_case (e.g., `audit_svc.py`, `inventory_svc.py`, `billing.py`)
- API endpoints: snake_case with hyphens in URLs (e.g., `/waiting-list`, `/cash-session`)

**Functions:**
- TypeScript/JavaScript: camelCase (e.g., `handleSubmit`, `setLanguage`, `confirmOpen`)
- Python functions: snake_case (e.g., `set_password`, `check_password`, `recalculate_totals`)
- React hooks: `use` prefix in camelCase (e.g., `useSocket`, `useLanguage`, `useAuthStore`)
- Python service functions: descriptive snake_case (e.g., `create_access_token`, `filter_by`, `get_or_404`)

**Variables:**
- TypeScript: camelCase (e.g., `username`, `isManager`, `refetchInterval`, `livePoolCents`)
- Python: snake_case (e.g., `user_id`, `resource_id`, `payment_type`, `tendered_cents`)
- Constants: UPPER_SNAKE_CASE (e.g., `BILLING_MODE`, `LOG_LEVEL`, `POOL_RATE_CENTS`)
- React state: camelCase (e.g., `openingResource`, `showAddTable`, `pendingName`)

**Types:**
- TypeScript interfaces: PascalCase (e.g., `AuthState`, `FloorStore`, `User`)
- Python model classes: PascalCase (e.g., `Ticket`, `TicketLineItem`, `PoolTableConfig`)
- Database table names: snake_case (e.g., `tickets`, `users`, `ticket_line_items`)

## Code Style

**Formatting:**
- No explicit formatter configured (no .prettierrc, .eslintrc, or biome.json found)
- TypeScript compiled with strict mode enabled (`strict: true` in tsconfig.json)
- Line length appears to be around 100-120 characters based on code samples
- Indentation: 2 spaces consistently used in TypeScript/React, 4 spaces in Python

**Linting:**
- No formal linter detected in package.json
- Unused variables and parameters allowed (`noUnusedLocals: false`, `noUnusedParameters: false` in tsconfig.json)
- TypeScript compiler set to strict type checking with:
  - JSX transformed to `react-jsx` (automatic imports)
  - `noFallthroughCasesInSwitch: true` enforced
  - Module resolution set to `bundler`

## Import Organization

**Order:**
1. External library imports (React, routing, utilities)
2. Internal API/service imports (`client`, `api` folder)
3. Store imports (Zustand stores like `authStore`, `floorStore`)
4. Hook imports (custom hooks like `useSocket`, `useLanguage`)
5. Component imports
6. Utility/helper imports
7. CSS imports (last in TypeScript files)

**Examples from codebase:**
```typescript
// From App.tsx - correct import order
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import LoginPage from './pages/LoginPage'
import FloorMapPage from './pages/FloorMapPage'
import { SocketProvider } from './hooks/useSocket'
```

```python
# From auth.py - correct import order
from datetime import timedelta
from flask import Blueprint, request, jsonify
from flask_jwt_extended import create_access_token, create_refresh_token, jwt_required, get_jwt_identity
from app.extensions import db, limiter
from app.models.user import User
from app.services import audit_svc
```

**Path Aliases:**
- TypeScript: `@/*` aliases to `src/*` (used consistently in imports)
- Python: Absolute imports from `app.*` namespace (no relative imports)

## Error Handling

**Frontend Patterns:**
- Try-catch blocks wrapping async API calls (see `LoginPage.tsx`)
- Error responses accessed via `err.response?.data?.message` with fallback to generic message
- Success/error notifications via `react-hot-toast` (see `toast.error()`, `toast.success()`)
- Empty catches allowed for non-critical operations: `try { await client.post(...) } catch {}`

**Backend Patterns:**
- Flask route handlers return `jsonify()` responses with status codes
- 404 errors using `get_or_404()` method
- HTTP status codes: 401 for auth failures, 403 for forbidden access, 409 for conflicts
- Error responses include `error` and `message` keys: `{'error': 'BAR_CLOSED', 'message': '...'}`
- Database transactions committed explicitly with `db.session.commit()`

**Example from backend (`tickets.py`):**
```python
if not open_session:
    return jsonify({'error': 'BAR_CLOSED', 'message': 'Bar is not open...'}), 403
```

## Logging

**Framework:** 
- Backend: Python standard `logging` module configured in `app/__init__.py`
- Log level: Read from `LOG_LEVEL` environment variable (default: `INFO`)
- Format: `%(asctime)s %(levelname)s %(name)s %(message)s`
- Frontend: No explicit logging framework (only audit logs via API)

**Patterns:**
- Audit logging via `audit_svc.log()` for all significant actions (LOGIN, TICKET_OPEN, PAYMENT, etc.)
- Audit logs capture: user_id, action type, entity_type, entity_id, before/after state, IP address, reason
- Example from `auth.py`:
  ```python
  audit_svc.log(user_id, 'MANAGER_PIN_USED', 'user', manager.id,
                after={'manager_id': manager.id},
                ip_address=request.remote_addr)
  ```

## Comments

**When to Comment:**
- No comments found in typical code paths
- Docstrings not observed in Python methods
- Code is self-documenting through naming conventions
- Comments appear only for complex business logic (e.g., pool billing calculations)

**JSDoc/TSDoc:**
- Not used - TypeScript types serve as documentation
- Interface definitions provide clear contracts (see `User`, `AuthState` in stores)

## Function Design

**Size:**
- Typical backend route handlers: 20-50 lines
- Helper functions: 10-30 lines
- Complex logic extracted to service modules (see `billing.py`, `inventory_svc.py`)

**Parameters:**
- Destructuring used for options: `{ children, roles }` in React components
- Keyword arguments in Python: `log(user_id, action, entity_type=None, entity_id=None, ...)`
- Request data accessed via `request.get_json()` pattern

**Return Values:**
- Frontend functions typically return JSX or void
- Backend routes return `jsonify()` responses with status codes
- Service functions return computed values or modified objects
- Async operations wrapped in promises/callbacks with try-catch

**Example function from `useLanguage.ts`:**
```typescript
export function useLanguage() {
  const { i18n } = useTranslation()
  const setLanguage = (lang: 'es' | 'en') => {
    i18n.changeLanguage(lang)
    localStorage.setItem('lang', lang)
  }
  return {
    lang: i18n.language as 'es' | 'en',
    setLanguage,
    isSpanish: i18n.language === 'es',
    isEnglish: i18n.language === 'en',
  }
}
```

## Module Design

**Exports:**
- React components: `export default` for page/route components, named exports for reusable components
- TypeScript utilities: Named exports for functions and interfaces
- Python: Functions exported directly from modules without explicit `__all__`

**Barrel Files:**
- No index.ts or __init__.py re-exports detected
- Imports use direct file paths (e.g., `import { useAuthStore } from './stores/authStore'`)
- Python services imported with full namespace: `from app.services import audit_svc, billing`

**Module Responsibilities:**
- `stores/`: Zustand stores for global state (auth, floor resources)
- `hooks/`: Custom React hooks (useSocket, useLanguage, useEscKey, useTimer)
- `components/`: Reusable React components
- `pages/`: Full-page route components
- `api/`: HTTP client configuration and interceptors
- `utils/`: Utility functions (print receipt, formatting)
- `models/`: SQLAlchemy ORM models
- `api/`: Flask blueprints for route handlers
- `services/`: Business logic (audit, billing, inventory, promotions)
- `schemas/`: Marshmallow schemas for validation

---

*Convention analysis: 2026-04-20*
