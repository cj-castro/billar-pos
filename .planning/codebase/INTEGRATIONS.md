# External Integrations

**Analysis Date:** 2026-04-20

## APIs & External Services

**No Third-Party APIs Integrated**
- The application does not integrate with external APIs like payment processors, SMS services, or cloud services
- All functionality is self-contained within the Flask backend and React frontend

## Data Storage

**Primary Database:**
- **PostgreSQL** 15 (Alpine Docker image)
  - Connection: `DATABASE_URL` environment variable
  - Format: `postgresql://[user]:[password]@[host]:[port]/[database]`
  - Default in development: `postgresql://billiard:billiard@localhost:5432/billiardbar`
  - Default in Docker Compose: `postgresql://billiard:billiard_secret@postgres:5432/billiardbar`
  - Client: **psycopg2-binary** 2.9.9 - Native PostgreSQL adapter
  - ORM: **SQLAlchemy** via Flask-SQLAlchemy 3.1.1

**Database Migrations:**
- Tool: **Flask-Migrate** 4.0.7 (Alembic-based)
- Manual schema updates: `D:/Projects/Code/billar-pos/backend/app/__init__.py` contains ALTER TABLE migrations
- Initialization: `flask init-db` command creates tables and applies migrations
- Seeding: `D:/Projects/Code/billar-pos/backend/seed.py` provides data initialization

**File Storage:**
- **Local filesystem only** - No cloud storage configured
- Database stores all business data (resources, tickets, inventory, etc.)
- No file upload/download functionality detected

**Caching:**
- **In-memory only** - No Redis or Memcached
- Rate limiter uses in-memory storage: `RATELIMIT_STORAGE_URI=memory://`
- Query caching via React Query on frontend

## Authentication & Identity

**Auth Implementation:**
- **Custom JWT-based** authentication (no OAuth/SSO)
- **JWT Provider**: Flask-JWT-Extended 4.6.0

**Token Management:**
- Access tokens: Short-lived (default 8 hours, configurable via `JWT_ACCESS_HOURS`)
- Refresh tokens: Long-lived (7 days)
- Secret keys:
  - Access: `SECRET_KEY` environment variable
  - Refresh: `JWT_REFRESH_SECRET` environment variable
- Claims included in tokens: user ID, role, name

**Password Security:**
- **bcrypt** 4.1.3 for password hashing (automatic salt generation)
- PIN authentication also uses bcrypt

**User Roles:**
- WAITER, KITCHEN_STAFF, BAR_STAFF, MANAGER, ADMIN
- Defined in `D:/Projects/Code/billar-pos/backend/app/models/user.py`
- Role-based access control (RBAC) enforced in API endpoints

**Authentication Flow:**
1. `POST /api/v1/auth/login` - Username/password credential exchange
2. Server returns access_token + refresh_token + user object
3. Frontend stores tokens in Zustand auth store
4. Axios interceptor adds `Authorization: Bearer {token}` to all requests
5. `POST /api/v1/auth/refresh` - Token refresh endpoint
6. Invalid/expired tokens trigger logout redirect to `/login`

## Monitoring & Observability

**Error Tracking:**
- **None** - No Sentry, DataDog, or similar integration

**Logging:**
- **Python logging** to stdout
- Configured in `D:/Projects/Code/billar-pos/backend/app/__init__.py`
- Level: `LOG_LEVEL` environment variable (default: INFO)
- Format: `%(asctime)s %(levelname)s %(name)s %(message)s`

**Audit Logging:**
- **Custom audit service**: `D:/Projects/Code/billar-pos/backend/app/services/audit_svc.py`
- Tracks user actions (login, logout, data changes)
- Stored in PostgreSQL `audit_logs` table
- Captures: user ID, action type, resource type, IP address, before/after data

**Frontend Logging:**
- Console logging only (no aggregation)

## CI/CD & Deployment

**Hosting:**
- Docker Compose (local development and production)
- No cloud platform detected (AWS, GCP, Azure, Heroku)

**Containerization:**
- **Docker** (Compose orchestration)
- Backend Dockerfile: `D:/Projects/Code/billar-pos/backend/Dockerfile`
  - Base: `python:3.11-slim`
  - WSGI server: Gunicorn with eventlet worker
  - Port: 5000
  - Init script: `D:/Projects/Code/billar-pos/backend/entrypoint.sh`
- Frontend Dockerfile: `D:/Projects/Code/billar-pos/frontend/Dockerfile`
  - Base: `node:20-alpine` (build stage)
  - Runtime: `nginx:1.25-alpine`
  - Port: 80
  - Build args: `VITE_API_URL`, `VITE_SOCKET_URL`

**Docker Compose Services:**
- **postgres** - PostgreSQL 15 Alpine, port 5432
  - Health checks enabled
  - Persistent volume: `pg_data`
- **backend** - Flask app, port 5000
  - Wait condition: postgres healthcheck
  - Environment-based config
- **frontend** - Nginx, port 8080 (configurable via `FRONTEND_PORT`)
  - Depends on backend
  - Static file serving only

**Deployment:**
- Network: `billiardbar_net` (Docker bridge)
- Entrypoint: `D:/Projects/Code/billar-pos/backend/entrypoint.sh`
  - Runs `flask init-db` (idempotent)
  - Runs `seed.py` for initial data
  - Starts Gunicorn with eventlet

**CI/CD Pipeline:**
- **None detected** - No GitHub Actions, GitLab CI, Jenkins, or similar

## Real-Time Communication

**WebSocket Implementation:**
- **Socket.IO** 4.7.5 (Flask-SocketIO backend, socket.io-client frontend)
- Server: `D:/Projects/Code/billar-pos/backend/app/sockets/events.py`
- Client: `D:/Projects/Code/billar-pos/frontend/src/hooks/useSocket.ts`

**Socket Rooms:**
- `floor` - Floor management updates (all users)
- `kitchen` - Kitchen queue updates (KITCHEN_STAFF, MANAGER, ADMIN)
- `bar` - Bar queue updates (BAR_STAFF, MANAGER, ADMIN)
- `waiting` - Waiting list updates (all users)
- `ticket:{ticket_id}` - Individual ticket updates

**Emitted Events:**
- `join` - User joins a room
- `leave` - User leaves a room
- `floor:update` - Floor resources updated, fetches `/api/v1/resources`
- `waiting:update` - Waiting list changed, invalidates cached queries

**Transport Methods:**
- WebSocket (primary)
- Long polling (fallback)
- CORS: Allowed from all origins (`*`)

## API Endpoints

**Base URL:** `/api/v1` (proxied by Vite dev server to `http://localhost:5000`)

**Resource Endpoints:**
- Authentication: `/api/v1/auth` (login, refresh, logout)
- Resources (Pool Tables): `/api/v1/resources`
- Tickets (Orders): `/api/v1/tickets`
- Queue Management: `/api/v1/queue`
- Inventory: `/api/v1/inventory`
- Menu: `/api/v1/menu`
- Reports: `/api/v1/reports`
- Users: `/api/v1/users`
- Waiting List: `/api/v1/waiting-list`
- Cash Management: `/api/v1/cash`

**HTTP Client:**
- **Axios** with base URL `/api/v1`
- Request interceptor: Adds Bearer token to Authorization header
- Response interceptor: Redirects to login on 401 responses

## Environment Configuration

**Required Environment Variables:**

*Database:*
- `DATABASE_URL` (required for production) - PostgreSQL connection string
- `POSTGRES_DB` (Docker Compose) - Default: `billiardbar`
- `POSTGRES_USER` (Docker Compose) - Default: `billiard`
- `POSTGRES_PASSWORD` (Docker Compose) - Default: `billiard_secret` (INSECURE)

*Security:*
- `SECRET_KEY` (required) - For signing sessions and access tokens
- `JWT_REFRESH_SECRET` (required) - For signing refresh tokens

*Business Logic:*
- `BILLING_MODE` - Pool billing unit (default: PER_MINUTE)
- `POOL_RATE_CENTS` - Cost per billing unit (default: 150 cents)
- `HAPPY_HOUR_START` - Start time HH:MM format (default: 17:00)
- `HAPPY_HOUR_END` - End time HH:MM format (default: 20:00)
- `HAPPY_HOUR_DISCOUNT_PCT` - Discount % (default: 20)
- `CURRENCY` - ISO 4217 code (default: USD)

*Operations:*
- `TZ` - IANA timezone (default: America/Chicago)
- `LOG_LEVEL` - Python logging level (default: INFO)
- `FLASK_ENV` - Environment name (default: production)
- `JWT_ACCESS_HOURS` - Token expiry in hours (default: 8)

**Secrets Location:**
- `.env` file for development (not committed)
- Environment variables for Docker deployment
- No secret management service (Vault, AWS Secrets Manager, etc.)

## Webhooks & Callbacks

**Incoming Webhooks:**
- None detected

**Outgoing Webhooks:**
- None detected

**Event Emissions:**
- All real-time updates via Socket.IO (not webhooks)

---

*Integration audit: 2026-04-20*
