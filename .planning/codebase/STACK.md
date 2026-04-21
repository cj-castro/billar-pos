# Technology Stack

**Analysis Date:** 2026-04-20

## Languages

**Primary:**
- **Python** 3.11 - Backend API server and services (`D:/Projects/Code/billar-pos/backend`)
- **TypeScript** 5.4.5 - Frontend React application (`D:/Projects/Code/billar-pos/frontend/src`)
- **JavaScript** - Build and configuration tools

**Secondary:**
- **Shell** - Docker entrypoint and deployment scripts (`D:/Projects/Code/billar-pos/backend/entrypoint.sh`)

## Runtime

**Environment:**
- **Node.js** 20 (Alpine) - Frontend development and build
- **Python** 3.11-slim - Backend runtime (official Docker image)

**Package Managers:**
- **npm** - Frontend dependencies (lockfile present: `package-lock.json`)
- **pip** - Backend dependencies (requirements.txt)

## Frameworks

**Backend:**
- **Flask** 3.0.3 - Core web framework
- **Flask-SQLAlchemy** 3.1.1 - ORM for database interactions
- **Flask-SocketIO** 5.3.6 - WebSocket support for real-time updates
- **Flask-JWT-Extended** 4.6.0 - JWT authentication and authorization
- **Flask-Migrate** 4.0.7 - Database schema migration management
- **Flask-CORS** 4.0.1 - Cross-origin resource sharing
- **Flask-Limiter** 3.7.0 - Rate limiting for API endpoints

**Frontend:**
- **React** 18.3.1 - UI library with hooks
- **React Router DOM** 6.23.1 - Client-side routing
- **Zustand** 4.5.2 - State management (auth, floor, resources)
- **TanStack React Query** 5.40.0 - Data fetching and caching
- **Socket.IO Client** 4.7.5 - Real-time WebSocket client

**Styling:**
- **Tailwind CSS** 3.4.4 - Utility-first CSS framework
- **PostCSS** 8.4.38 - CSS processing
- **Autoprefixer** 10.4.19 - Vendor prefix automation

**Build/Dev:**
- **Vite** 5.3.1 - Frontend build tool and dev server
- **@vitejs/plugin-react** 4.3.1 - React Fast Refresh support
- **TypeScript** 5.4.5 - Type checking
- **Gunicorn** 22.0.0 - WSGI application server for production

## Key Dependencies

**Backend - Database & ORM:**
- **psycopg2-binary** 2.9.9 - PostgreSQL adapter
- **SQLAlchemy** (via Flask-SQLAlchemy) - ORM and query builder

**Backend - Authentication:**
- **bcrypt** 4.1.3 - Password hashing and PIN encryption
- **PyJWT** (via Flask-JWT-Extended) - JWT token generation and validation

**Backend - WebSocket & Async:**
- **python-socketio** (via Flask-SocketIO) - Socket.IO server
- **eventlet** 0.36.1 - Green threading for concurrent connections
- **greenlet** 3.0.3 - Lightweight concurrency primitives

**Backend - Utilities:**
- **marshmallow** 3.21.3 - Data validation and serialization
- **python-dotenv** 1.0.1 - Environment variable loading
- **python-dateutil** 2.9.0 - Date/time utilities

**Frontend - Utilities:**
- **axios** 1.7.2 - HTTP client with interceptors
- **react-hot-toast** 2.4.1 - Toast notifications
- **lucide-react** 0.395.0 - Icon library
- **date-fns** 3.6.0 - Date manipulation
- **clsx** 2.1.1 - Dynamic className utility
- **i18next** 26.0.6 - Internationalization framework
- **react-i18next** 17.0.4 - React i18n bindings

## Configuration

**Environment Variables:**

*Backend (from `docker-compose.yml`)* - Set via environment:
- `DATABASE_URL` - PostgreSQL connection string
- `SECRET_KEY` - Session and JWT signing key
- `JWT_REFRESH_SECRET` - Refresh token signing key
- `JWT_ACCESS_HOURS` - JWT access token expiration (default: 8 hours)
- `BILLING_MODE` - Pool billing model (default: PER_MINUTE)
- `POOL_RATE_CENTS` - Billing rate per minute/hour (default: 150 cents)
- `HAPPY_HOUR_START` - Start time for happy hour pricing (default: 17:00)
- `HAPPY_HOUR_END` - End time for happy hour pricing (default: 20:00)
- `HAPPY_HOUR_DISCOUNT_PCT` - Discount percentage during happy hours (default: 20%)
- `CURRENCY` - Display currency code (default: USD)
- `TZ` - Server timezone (default: America/Chicago)
- `LOG_LEVEL` - Logging verbosity (default: INFO)
- `FLASK_ENV` - Flask environment (default: production)
- `RATELIMIT_STORAGE_URI` - Rate limiter storage backend (default: memory://)

*Frontend (from `Dockerfile`)* - Build-time arguments:
- `VITE_API_URL` - Backend API base URL (default: /api/v1)
- `VITE_SOCKET_URL` - WebSocket server URL (default: /)

**Build Configuration:**
- `D:/Projects/Code/billar-pos/frontend/tsconfig.json` - TypeScript compiler options
- `D:/Projects/Code/billar-pos/frontend/vite.config.ts` - Vite bundler config with path aliases and proxy
- `D:/Projects/Code/billar-pos/frontend/tailwind.config.js` - Tailwind CSS custom theme
- `D:/Projects/Code/billar-pos/frontend/postcss.config.js` - PostCSS plugins
- `D:/Projects/Code/billar-pos/frontend/tsconfig.node.json` - TypeScript config for Vite config file
- `D:/Projects/Code/billar-pos/backend/app/config.py` - Flask configuration class
- `D:/Projects/Code/billar-pos/backend/.flaskenv` - Flask app entry point (wsgi.py)

## Platform Requirements

**Development:**
- Node.js 20+
- Python 3.11+
- PostgreSQL 15+ (can run via Docker)
- npm or yarn

**Production:**
- Docker and Docker Compose
- PostgreSQL 15+ database
- Reverse proxy (nginx recommended)

**Deployment:**
- Docker containers for backend and frontend
- Gunicorn WSGI server (eventlet worker)
- Nginx reverse proxy for frontend static files
- PostgreSQL database container

---

*Stack analysis: 2026-04-20*
