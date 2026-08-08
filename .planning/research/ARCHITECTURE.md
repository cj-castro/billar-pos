# Hosting Architecture Research

**Project:** Billar POS — hosting/runtime replacement  
**Date researched:** 2026-08-08  
**Scope:** How to replace Docker+Rancher while preserving domain logic and existing constraints  
**Overall confidence:** MEDIUM (most patterns are proven; Podman networking on Windows is LOW confidence)

## Executive Summary

The POS system is a **layered monolith with three satellite worker processes** sharing a PostgreSQL database, plus an external print agent. The key constraint is a **single eventlet gunicorn worker** (cooperative scheduling, no raw OS threads). Replacing Docker+Rancher does not require rewriting the backend — the codebase is platform-agnostic Python/JavaScript/SQL.

We evaluated **six major hosting directions**. Two are **immediately viable** (Docker-without-Rancher, native Windows Services), one is **very low-friction** (Supervisor), one is **proven but risky** (Podman), and two are **major undertakings with unclear payoff** (Rust rewrite, Electron wrapping).

**Recommendation without committing:** Start with **Docker-engine-without-Rancher** as the lowest-risk migration path, prove process isolation works reliably, *then* decide whether to move to native services if containerization overhead matters. Supervisor is the most straightforward alternative if you want zero Docker dependency.

---

## Architecture Mapping: Each Hosting Direction

### 1. Native Windows Services (NSSM/WinSW wrapper pattern)

**Current state removed:**
- `docker-compose.yml` (no longer orchestrates services)
- Rancher Desktop / Docker daemon + container networking layer
- `host.docker.internal` name resolution

**New components added:**
- **Reverse proxy** (nginx or Caddy, lightweight native executable): serves static frontend from `/` and proxies API requests to `/api/*` → backend:5000; handles HTTPS
- **NSSM/WinSW wrappers** for:
  - Flask backend → `gunicorn --worker-class eventlet -w 1 backend:app`
  - Scheduler → `python backend/scheduler.py`
  - Telegram bot → `python telegram-bot/bot.py`
- **Process monitoring** (built into NSSM/WinSW via auto-restart policy, or add a separate watchdog script)
- **PostgreSQL** (unchanged, already runs as native Windows service on port 5432)

**Components unchanged:**
- Python Flask backend code (no modification needed)
- Python scheduler, Telegram bot code
- Frontend React code, built static files
- Print agent (already native Windows service at `scripts/print_agent/print_agent.py`)
- PostgreSQL database and schema

**Print-agent networking:**
- **Simplified significantly**: Backend now directly calls `http://localhost:9191` (or 127.0.0.1) instead of `host.docker.internal:9191`
- No virtualization layers in between
- LAN-reachable print agent on the same Windows machine

**Eventlet single-worker constraint:**
- **Unchanged**: Flask backend runs exactly as before: `gunicorn --worker-class eventlet -w 1`, cooperative scheduling via eventlet
- Background greenlets via `socketio.start_background_task` work identically (no raw OS threads)
- Socket.IO real-time updates unaffected

**Suggested build/migration sequence:**
1. **Step 1: Reverse proxy setup** (low risk)
   - Install nginx or Caddy as a Windows executable
   - Write config to serve frontend static files and reverse-proxy `/api/*` → `http://localhost:5000`, `/socket.io/*` → `http://localhost:5000`
   - Test with Flask dev server running on localhost:5000
   - Validate CORS/Socket.IO cross-origin setup is not needed (single proxy origin eliminates CORS)

2. **Step 2: PostgreSQL setup** (already done, verify)
   - Verify PostgreSQL 15 is installed as a Windows service, listening on localhost:5432
   - Test connection: `psql -U postgres -h localhost -d billar_pos`

3. **Step 3: Create NSSM wrappers** (medium risk)
   - Download NSSM executable
   - Create service wrapper for Flask: `nssm install billar-backend "python" "backend/wsgi.py"`
   - Create service wrapper for scheduler: `nssm install billar-scheduler "python" "backend/scheduler.py"`
   - Create service wrapper for telegram bot: `nssm install billar-bot "python" "telegram-bot/bot.py"`
   - Set restart policy and env vars (DATABASE_URL, etc.) per service

4. **Step 4: Update config and env vars**
   - `.env` or `config.py`: PostgreSQL connection string from `postgresql://postgres:password@db:5432/billar_pos` → `postgresql://postgres:password@localhost:5432/billar_pos`
   - Print agent URL from `http://host.docker.internal:9191` → `http://localhost:9191`
   - Any other `localhost` → `127.0.0.1` or leave as-is

5. **Step 5: Integration testing**
   - Start all NSSM services via Windows Services UI or `nssm start billar-backend`
   - Verify Flask backend is responding: `GET http://localhost:5000/api/v1/health`
   - Open frontend in browser: `http://localhost` (reverse proxy)
   - Test table operations, kitchen queue, print dispatch
   - Test scheduler fires at 08:00 next day (or run `flask daily-report` manually)
   - Test Telegram bot reads DB independently

6. **Step 6: Autostart and monitoring**
   - Set all NSSM services to autostart via Windows Services properties
   - Optional: Write PowerShell monitoring script to check service health and alert

**Pros:**
- Direct process isolation without virtualization overhead
- Straightforward to debug (native Windows processes, standard Windows tooling)
- Print agent connectivity is simpler (no `host.docker.internal`)
- Eventlet/Socket.IO constraints remain unchanged

**Cons:**
- No container image portability (Windows-specific)
- Must maintain Python/Node runtime installations on Windows machine
- More manual service management than docker-compose orchestration
- NSSM/WinSW are not active projects (stable but minimal maintenance)

---

### 2. Docker Engine Standalone (or docker-compose CLI only)

**Current state removed:**
- Rancher Desktop UI/integration (though Docker daemon still runs)
- Or: optionally remove docker-compose tooling if using raw `docker run` commands

**New components added:**
- None (if keeping docker-compose.yml as-is)
- Or: manual orchestration scripts if replacing docker-compose with raw docker commands

**Components unchanged:**
- `docker-compose.yml` (can stay exactly as-is)
- Container images and Dockerfiles
- PostgreSQL, Flask, Frontend, Scheduler, Telegram bot containers
- Print agent (native Windows service, unchanged)

**Print-agent networking:**
- **Unchanged**: Backend containers still call `http://host.docker.internal:9191`
- Windows Docker Desktop provides `host.docker.internal` alias for host access

**Eventlet single-worker constraint:**
- **Unchanged**: Single eventlet worker in Flask container runs identically

**Suggested build/migration sequence:**
1. **Step 1: Install Docker Desktop or Docker Engine** (not Rancher)
   - Download Docker Desktop for Windows (includes Docker daemon + CLI)
   - Configure to start on boot

2. **Step 2: Keep `docker-compose.yml` unchanged**
   - Existing docker-compose.yml should work identically with Docker CLI
   - Or manually migrate to `docker run` commands if desired (not necessary)

3. **Step 3: Test startup**
   - `docker-compose up --build` from the repo root
   - Verify all containers start and communicate
   - Test print agent connectivity via `host.docker.internal:9191`

4. **Step 4: Autostart setup**
   - Docker Desktop > Settings > General > "Start Docker Desktop when you log in"
   - Or create a Windows Task Scheduler entry to run `docker-compose up -d`

**Pros:**
- Minimal change from current state (nearly zero migration effort)
- Docker ecosystem is mature and widely understood
- Container isolation and reproducibility without Rancher overhead
- `docker-compose` tooling is powerful and proven
- Eventlet/Socket.IO constraints unchanged

**Cons:**
- Still depends on Docker (if avoiding Docker is a goal, this doesn't help)
- Docker Desktop has a resource footprint (WSL2 VM overhead on Windows)
- Rancher was the pain point, not Docker itself — this may not address that concern

**Risk assessment:** Very low — you're already running this, just removing the Rancher UI layer.

---

### 3. Podman (Container runtime as Docker alternative)

**Current state removed:**
- Docker daemon and CLI
- Rancher Desktop
- `host.docker.internal` alias

**New components added:**
- **Podman daemon and CLI** (OCI-compatible runtime)
- **Podman Desktop** (optional GUI, similar to Rancher)
- **podman-compose** (if keeping compose orchestration) or manual `podman run` commands
- **WSL2 networking configuration** (if Windows-based Podman; this is the complexity)
- Possibly **netsh portproxy rules** to forward Windows host ports to WSL2 VM

**Components unchanged:**
- Container images (OCI-compatible, work with Podman)
- Python/database logic

**Print-agent networking:**
- **COMPLEX AND PROBLEMATIC**: Podman on Windows uses WSL2 virtualization
  - Container ports are accessible from Windows host via localhost
  - But services are NOT accessible from the Windows LAN by default (WSL2 NAT network isolation)
  - To access from LAN, you must configure `netsh interface portproxy` rules to forward host IP → WSL2 IP
  - WSL2 IP is dynamic (changes on reboot), so this requires scripted setup on every boot
  - Workaround: Use Podman v4.6+ `--user-mode-networking` flag (experimental, not production-ready)
  - **Result:** Print agent at `http://host-ip:9191` becomes significantly more complex to set up and maintain

**Eventlet single-worker constraint:**
- **Unchanged**: Container runs Flask identically

**Suggested build/migration sequence:**

1. **Step 1: Install Podman** (with strong caution)
   - Install Podman Desktop or Podman CLI on Windows
   - Creates WSL2 VM for container runtime

2. **Step 2: Assess LAN networking** (THIS IS THE CRITICAL BLOCKER)
   - Test if containers can be accessed from Windows host IP address
   - If not accessible, either:
     - Use netsh portproxy workaround (complex, fragile)
     - Evaluate Podman v4.6+ `--user-mode-networking` (experimental, not recommended for production)
     - Abandon this option and pick a different hosting direction

3. **Step 3: If LAN access is solved, migrate compose**
   - Install `podman-compose`
   - Convert `docker-compose.yml` to podman-compose (mostly compatible)
   - Test container startup

4. **Step 4: Validate print agent reachability**
   - Backend must reach print agent on host Windows machine
   - If using netsh portproxy, this must work consistently across reboots

**Pros:**
- Podman is more modular and rootless than Docker (philosophical advantage)
- OCI-compatible images are portable
- No Docker licensing concerns (open source)

**Cons:**
- **Print agent networking is a major blocker** on Windows
- Podman on Windows is WSL2-based, not as mature as Docker Desktop
- Networking configuration is fragile and not well-documented
- WSL2 IP churn (changes on reboot) breaks static configuration
- Not worth the complexity for this use case

**Risk assessment:** HIGH — the networking problem is not elegantly solved, and it's a core requirement.

**Recommendation:** DO NOT use Podman on Windows for this application. The print agent reachability problem is a showstopper.

---

### 4. Rust Rewrite as Native Windows Service

**Scope clarification:** Complete or partial rewrite of Flask backend in Rust, compiled to native .exe, running via WinSW/Shawl wrapper or raw Windows service API.

**Current state removed:**
- Python Flask backend (1000+ lines across blueprints, services, models)
- `app/wsgi.py` and `backend/entrypoint.sh`
- Python 3.11 runtime (if no other Python code remains)
- Docker layer (if no longer containerizing)

**New components added (massive undertaking):**
- **Rust backend rewrite** (~2000-5000 lines estimated)
  - Axum or Actix-web framework for REST API routing
  - tokio-tungstenite or similar for Socket.IO server (or wrapper around Rust Socket.IO crate if it exists)
  - SQLx or sqlx for async PostgreSQL queries
  - Serde for JSON serialization
  - All business logic ported from `backend/app/services/*` (promotion engine, billing, inventory, audit)
  
- **Async runtime** (Tokio-based, replaces eventlet cooperative scheduling with Rust async/await)
  
- **Service wrapper** (WinSW or Shawl) to run Rust .exe as Windows service
  
- **Remaining Python services** (decision to make):
  - Keep `backend/scheduler.py` as-is (Python-based, can run separately via NSSM)
  - Keep `telegram-bot/bot.py` as-is (can run separately via NSSM)
  - Or rewrite these in Rust as well (additional scope)

**Components unchanged (theoretically):**
- PostgreSQL database, schema, migrations
- Frontend React code (still communicates via REST/Socket.IO)
- Print agent (native Windows service)

**Print-agent networking:**
- Same as native Windows Services: `http://localhost:9191`
- Rust backend can call print agent via native HTTP client (e.g., `reqwest` crate)

**Eventlet single-worker constraint:**
- **MAJOR CHANGE**: Rust doesn't have eventlet's cooperative green threading
- Must replace with **async/await model** using Tokio
- `socketio.start_background_task` greenlets → Tokio `tokio::spawn()`
- Background print dispatch becomes an async task, not a greenlet
- All database queries must be async (SQLx with `#[tokio::main]`)
- Socket.IO server must be async-native (need Rust Socket.IO crate that supports async, or use HTTP polling as fallback)
- **This is not a mechanical port — it's a fundamental architectural change**

**Scope assessment:**

| Component | Lines (Python) | Rust Effort | Notes |
|-----------|--------------|------------|-------|
| API blueprints | ~1200 | 1000-1500 lines | Route definitions, HTTP parsing, auth |
| Service layer (billing, inventory, promo, audit) | ~800 | 1200-1800 lines | Core logic, mostly algorithmic; porting is straightforward |
| Models (ORM, to_dict serialization) | ~500 | 700-1000 lines | Serde derive macros help; still manual |
| Socket.IO event emission | ~100 | 500-800 lines | Depends on Socket.IO crate maturity; could be complex |
| Flask/extensions setup | ~100 | 200-300 lines | Axum or Actix setup, middleware, CORS |
| **Total estimated** | **~2700** | **~4000-6000 lines** | Plus testing, debugging, stabilization |

**Timeline estimate:** 6-12 months of dedicated engineering (conservative).

**Suggested build/migration sequence:**

1. **Step 1: Scope decision** (MANDATORY FIRST STEP)
   - Decide: Backend only, or include scheduler + telegram bot?
   - Decide: Greenfield Rust crate, or use a framework template?
   - Decide: Socket.IO required, or can you live with HTTP polling? (Socket.IO Rust support is limited)

2. **Step 2: Prototype async/await pattern**
   - Build a minimal Rust web server that:
     - Exposes `GET /api/v1/health`
     - Connects to Postgres via SQLx async driver
     - Spawns a background task via `tokio::spawn()`
     - Logs to stdout
   - Deploy as Windows service via WinSW
   - Verify restart/crash recovery works

3. **Step 3: Port core business logic** (iterative)
   - Start with simplest service: audit logging (`audit_svc`)
   - Then: billing calculation (pure functions, no I/O)
   - Then: promotion engine (complex logic, reuse test suite)
   - Then: inventory deduction (database-heavy)
   - Each port gets a test suite ported from `backend/tests/`

4. **Step 4: Port REST API blueprints** (largest task)
   - Start with read-only endpoints (resources, analytics)
   - Then: mutating endpoints (tickets, queue, inventory)
   - Auth/JWT handling via middleware
   - Test against existing frontend

5. **Step 5: Socket.IO migration** (highest risk)
   - Evaluate Rust Socket.IO crates for maturity
   - If Socket.IO crate is mature: port room subscriptions and event emission
   - If Socket.IO crate is immature: consider HTTP polling as fallback (higher frontend latency, but works)

6. **Step 6: Integration and stabilization**
   - Run full test suite (HTTP-level integration tests ported from `backend/verify_api2.py`, `verify_confirm.py`)
   - Load test: simulate 10 concurrent users, measure latency
   - Crash recovery: kill -9 the process, verify auto-restart via WinSW

7. **Step 7: Scheduler and Telegram bot decisions**
   - If keeping Python: wrap them via NSSM, update DB connection strings
   - If rewriting: significant additional effort; prioritize based on criticality

**Pros:**
- Eliminates Python runtime requirement (smaller footprint)
- Rust performance is excellent; response times likely improve
- Compiled binary is immutable, harder to accidentally modify
- Direct Windows service API integration (if using native Rust crate)

**Cons:**
- **Massive undertaking** (~1-2 year project for a single engineer)
- Rust is not Python; steep learning curve for Python team
- Socket.IO support in Rust is less mature than Python
- Risk of bugs during port; existing system is proven
- No clear payoff for a working system (not a "must have" rewrite)
- Async/await model is a different mental model from eventlet greenlets

**Risk assessment:** VERY HIGH — large scope, long timeline, unproven migration path, and no compelling business reason.

**Recommendation:** DO NOT pursue this unless:
- You hit severe Python performance bottlenecks in production (you haven't)
- Your team has Rust expertise (they likely don't)
- You have dedicated time (6-12 months) to dedicate to a non-revenue feature (you probably don't)

---

### 5. Electron-Wrapped Desktop App

**Current state removed:**
- Docker Compose / Rancher Desktop
- Separate Flask web server (no longer server/client model)
- Browser-based frontend

**New components added:**
- **Electron main process** (Node.js, TypeScript)
  - Spawns child processes: Python Flask backend, scheduler, telegram bot
  - Manages window lifecycle and IPC messaging
  - Serves frontend via Electron's built-in HTTP server or embedded BrowserWindow
  
- **IPC bridge** between Electron renderer (React frontend) and Python child processes
  - Electron's `ipcMain` / `ipcRenderer` for main ↔ renderer communication
  - Child process communication via Node's `child_process.spawn()` with `stdio: 'pipe'` for IPC
  
- **Python runtime bundled** with the app (or assume system Python)
  - Flask backend runs as spawned child process, communicates via HTTP/Socket.IO over localhost
  - Scheduler runs as separate child process
  - Telegram bot runs as separate child process
  
- **PostgreSQL** (decision to make):
  - Bundle PostgreSQL with the app (complex, not recommended per research)
  - Or assume PostgreSQL is already installed on the machine
  
- **Windows installer** (NSIS/electron-builder)
  - Packages Electron app + Python runtimes + assets

**Components unchanged:**
- Python Flask code (still runs in subprocess)
- Python scheduler, telegram bot
- Frontend React code (now embedded in Electron, not separate web app)
- Print agent (native Windows service)

**Print-agent networking:**
- Same as native Windows Services: `http://localhost:9191`
- Electron main or Python child process calls print agent directly

**Eventlet single-worker constraint:**
- **Unchanged**: Python Flask backend still runs with `gunicorn --worker-class eventlet -w 1`
- Eventlet/Socket.IO constraints preserved because backend is Python subprocess
- But: Electron main process must handle child process lifecycle (spawning, monitoring, restarts)

**Suggested build/migration sequence:**

1. **Step 1: Electron main.js scaffold**
   - Create new `electron/main.ts` file
   - Use Electron Forge or electron-builder template
   - Window creation and event handling boilerplate

2. **Step 2: Python child process spawning**
   - In `main.ts`: spawn Python Flask backend via `child_process.spawn('python', ['backend/wsgi.py'])`
   - Spawn scheduler, telegram bot similarly
   - Capture `stdout`/`stderr` for logging
   - Handle process exit and implement auto-restart logic

3. **Step 3: Frontend embedding**
   - Load frontend React build (from `frontend/dist/`) into Electron BrowserWindow
   - Or: run dev server in production for debugging
   - Frontend communicates with backend via localhost:5000, same as browser-based app

4. **Step 4: IPC setup** (if needed)
   - If frontend needs to control backend lifecycle (stop/restart): set up `ipcMain` handlers
   - Most likely: frontend doesn't need this (just communicates via REST/Socket.IO)
   - IPC would only be needed for custom Electron features (menu items, system tray, etc.)

5. **Step 5: PostgreSQL decision**
   - If bundling: research electron-postgres or portapps.exe approach (complex, fragile)
   - Recommended: assume PostgreSQL is pre-installed, document setup
   - Connection string still localhost:5432

6. **Step 6: Packaging and installer**
   - Use `electron-builder` to create Windows .exe installer
   - Configure NSIS to set up start menu shortcuts, autostart (if desired)
   - Code signing (optional, but recommended for Windows)

7. **Step 7: Auto-update mechanism** (if desired)
   - electron-updater for in-app updates
   - Publish builds to update server or GitHub releases

**Pros:**
- Unified single-application experience (like a native desktop app)
- Electron handles many cross-platform concerns automatically
- Windows installer is user-friendly (click to install)
- Auto-update capability
- Familiar tech stack (JavaScript/TypeScript for main, Python backend unchanged)

**Cons:**
- **PostgreSQL bundling is not straightforward** and not recommended (adds 100+ MB)
- **IPC adds complexity** without clear benefit (backend communicates fine over HTTP)
- **Electron app has larger footprint** than native services (300+ MB vs <50 MB)
- **Child process management** is complex (spawn, monitor, restart, graceful shutdown)
- **Debugging is harder** (embedded processes, no direct service manager access)
- **Desktop app paradigm** (always running in background) is different from web app (stateless, can restart anytime)

**Key risk:** PostgreSQL bundling is the major blocker. Assuming pre-installed PostgreSQL means this is still a complex deployment for end users (they must install PostgreSQL separately).

**Recommendation:** Only pursue if:
- PostgreSQL can be assumed pre-installed (document it as system requirement)
- You want a self-contained desktop experience (not web-based)
- Your team is comfortable with Electron (JavaScript-heavy)
- You can manage auto-update and installer complexity

Otherwise, one of the simpler options (Docker, NSSM, Supervisor) is better.

---

### 6. Lightweight Process Supervisor (Supervisor)

**Current state removed:**
- Docker Compose / Rancher Desktop / Docker daemon
- Container layer and orchestration

**New components added:**
- **Supervisor daemon** (supervisord.exe, Python-based process monitor)
  - Runs as Windows service itself
  - Manages child processes: Flask backend, scheduler, telegram bot
  
- **Supervisor config file** (`supervisord.conf`)
  - Defines programs: backend, scheduler, telegram bot
  - Autostart, autorestart, logging per program
  - Environment variables, working directory
  
- **Optional: Supervisor web UI** (built-in, http://localhost:9001)
  - Monitor and restart programs via web dashboard
  
- **Reverse proxy** (nginx or Caddy) to serve frontend
  
- **PostgreSQL** (native Windows service, unchanged)

**Components unchanged:**
- Python Flask backend code (runs as supervised program)
- Python scheduler, telegram bot (run as supervised programs)
- Frontend React code (served by reverse proxy)
- Print agent (native Windows service)

**Print-agent networking:**
- Simple: Backend calls `http://localhost:9191` directly
- No containerization, no `host.docker.internal` needed

**Eventlet single-worker constraint:**
- **Unchanged**: Flask backend runs with `gunicorn --worker-class eventlet -w 1`
- Supervisor just manages process restarts, doesn't affect constraints

**Suggested build/migration sequence:**

1. **Step 1: Install Supervisor**
   ```bash
   pip install supervisor
   # or via chocolatey: choco install supervisor
   ```

2. **Step 2: Create supervisord.conf**
   ```ini
   [supervisord]
   nodaemon=false
   logfile=C:\logs\supervisord.log

   [program:backend]
   command=python backend/wsgi.py
   autostart=true
   autorestart=true
   redirect_stderr=true
   stdout_logfile=C:\logs\backend.log
   environment=DATABASE_URL="postgresql://postgres:password@localhost:5432/billar_pos",FLASK_ENV="production"

   [program:scheduler]
   command=python backend/scheduler.py
   autostart=true
   autorestart=true
   redirect_stderr=true
   stdout_logfile=C:\logs\scheduler.log
   environment=DATABASE_URL="postgresql://postgres:password@localhost:5432/billar_pos"

   [program:telegram_bot]
   command=python telegram-bot/bot.py
   autostart=true
   autorestart=true
   redirect_stderr=true
   stdout_logfile=C:\logs\bot.log
   environment=DATABASE_URL="postgresql://postgres:password@localhost:5432/billar_pos",TELEGRAM_TOKEN="..."
   ```

3. **Step 3: Install supervisord as Windows service**
   ```powershell
   python -m supervisor.skel.win32.ntsvc_install.py
   # or register manually via nssm/WinSW
   ```

4. **Step 4: Set up reverse proxy**
   - Same as native Windows Services option
   - nginx or Caddy serves frontend, proxies `/api/*` to localhost:5000

5. **Step 5: Start supervisord**
   ```bash
   supervisord -c supervisord.conf
   # Or start via Windows Services
   ```

6. **Step 6: Verify**
   - Open Supervisor web UI (if enabled): `http://localhost:9001`
   - Check program status and logs
   - Test frontend via `http://localhost`

7. **Step 7: Autostart**
   - Register supervisord as Windows service to start on boot
   - Supervisor automatically starts all configured programs on startup

**Pros:**
- **Simplest solution** for non-containerized process management
- Lightweight (Python-based, but small footprint)
- Web UI for monitoring and restarts (optional, but useful)
- Centralized logging
- No container overhead
- Process restarts are automatic and configurable

**Cons:**
- Supervisor is Python-based, adds Python runtime dependency
- No image isolation (all processes on shared Windows kernel)
- Requires manual configuration per program
- Less elegant than Docker orchestration (more `.conf` file tweaking)
- Not designed for cloud/multi-host deployments (fine for single machine)

**Risk assessment:** VERY LOW — straightforward, proven, minimal new components.

**Recommendation:** Strong candidate for lowest-complexity, highest-reliability path. Supervisor is a mature, battle-tested tool; Docker overhead may not be necessary for a single-machine deployment.

---

## Comparison Matrix

| Attribute | Native Services | Docker-less | Podman | Rust Rewrite | Electron | Supervisor |
|-----------|-----------------|-------------|--------|--------------|----------|------------|
| **Setup complexity** | Medium | Very Low | High | Very High | Medium-High | Low |
| **Runtime overhead** | None | WSL2 VM | WSL2 VM | None | Electron VM | None |
| **Print agent networking** | Simple | Same as now | Problematic | Simple | Simple | Simple |
| **Eventlet changes needed** | None | None | None | Major | None | None |
| **New components** | Reverse proxy, NSSM | None/minimal | podman, netsh | Entire Rust backend | Electron main, installer | Supervisor, reverse proxy |
| **Components removed** | Docker Compose | Rancher only | Docker, host.docker | Python Flask | Docker Compose | Docker Compose |
| **Learning curve** | Windows services | Docker CLI only | Podman, WSL2 | Rust, async/await | Electron/IPC | Supervisor conf |
| **Debugging ease** | Native processes | Container logs | WSL2 debugging | Compiled binary | Electron DevTools | Native + web UI |
| **Portability** | Windows-only | Container images | Container images | Rust-only | Electron app | Python/Windows-only |
| **Maturity** | Stable | Mature | Maturing | High (language) | Stable | Mature |
| **Risk** | Low | Very Low | High | Very High | Medium | Very Low |
| **Timeline to production** | 1-2 weeks | 1 day | 1-2 weeks* | 6-12 months | 2-4 weeks | 3-5 days |
| **Maintenance burden** | Medium | Low | Medium-High | Medium | Medium-High | Low |

*Podman timeline assumes print agent networking is solved; if not, it's a blocker.

---

## Recommended Build Order (for the strongest option)

**Recommendation: Docker-without-Rancher as minimum viable proof, then decide between native services and Supervisor based on operational preferences.**

### Phase 1: Prove Docker-less deployment works (Docker engine only)
**Duration:** 1 day  
**Goal:** Confirm existing docker-compose.yml works with Docker CLI, no Rancher UI

1. Install Docker Desktop (or Docker Engine) on Windows
2. Run `docker-compose up --build`
3. Test complete flow: floor map, kitchen queue, ticket operations, print dispatch
4. Verify scheduler fires at 08:00 (or run `flask daily-report` manually)
5. Verify Telegram bot is operational

**Success criteria:**
- All services start and communicate
- Print agent is reachable at `host.docker.internal:9191`
- No Rancher-specific errors
- If successful, you've proven Docker Compose is sufficient; Rancher was the complexity.

### Phase 2: Parallel evaluation of Native Services vs Supervisor
**Duration:** 1 week each  
**Goal:** Assess operational preferences for each team

#### Option 2a: Native Windows Services (NSSM)
1. Set up reverse proxy (nginx or Caddy)
2. Create NSSM wrappers for backend, scheduler, telegram bot
3. Test startup, restart, crash recovery
4. Test print agent connectivity via localhost:9191
5. Measure resource usage vs Docker

**Evaluate:** Is native process debugging easier? Is overhead difference material?

#### Option 2b: Supervisor
1. Install Supervisor
2. Create supervisord.conf for all three Python processes
3. Set up reverse proxy (same as NSSM option)
4. Register supervisord as Windows service
5. Test Supervisor web UI, program restarts, logging

**Evaluate:** Is centralized Supervisor logging valuable? Is web UI useful for ops?

### Phase 3: Commit to one path (Phase 1 + 2a OR Phase 1 + 2b)
**Duration:** 1 week  
**Goal:** Migrate fully from Rancher+Docker to chosen platform

Based on Phase 2 results, choose either:
- **Native Services path:** All three processes via NSSM, no Docker (maximum transparency, maximum manual management)
- **Supervisor path:** Supervisor manages all three, reverse proxy handles frontend (best of both, lightweight)

**Either choice is superior to Docker+Rancher for a single-machine on-site deployment.**

---

## Technology Stack Per Option

### Native Windows Services
- PostgreSQL 15 (Windows native service)
- Python 3.11 (system-installed)
- Node 20 (for frontend build, CLI only)
- nginx or Caddy (reverse proxy)
- NSSM or WinSW (service wrappers)

### Docker-without-Rancher
- Docker Desktop (daemon)
- docker-compose CLI
- All other stacks as container images

### Podman
- Podman Desktop or Podman CLI
- WSL2 (Linux VM layer)
- podman-compose
- netsh (network configuration)

### Rust Rewrite
- Rust 1.x (compiler)
- Tokio async runtime
- Axum or Actix-web framework
- SQLx for async database
- Windows service crate or WinSW wrapper
- Python (still needed for scheduler/bot if not rewritten)

### Electron
- Electron 22+
- Node.js (for main process)
- electron-builder (packaging)
- Python 3.11 (subprocess)
- (Optionally: bundled PostgreSQL binary, not recommended)

### Supervisor
- Python 3.11
- Supervisor package (via pip)
- nginx or Caddy (reverse proxy)
- PostgreSQL 15 (Windows native)

---

## Security and Reliability Notes

**All options preserve the existing architecture's security model:**
- JWT auth (no changes)
- Socket.IO room auth (no changes)
- Print agent trust boundary (all options: HTTP over localhost/LAN, no auth)
- Audit logging (no changes)

**All options require:**
- Environment variable configuration (DATABASE_URL, PRINT_AGENT_URL, TELEGRAM_TOKEN, SECRET_KEY)
- `.env` file management or Windows environment setup
- Auto-restart on crash (built into NSSM, Supervisor, or Docker healthchecks)
- Graceful shutdown handling (let services finish requests before killing)

**Recommended reliability setup for any option:**
1. Automatic process restart on crash (built into all options)
2. Automated backup of PostgreSQL database (new responsibility if moving off Docker)
3. Logging to a central location (Windows Event Log for NSSM, Supervisor logs, or Docker logs)
4. Monitoring/alerting for dead services (Supervisor web UI, Windows Services GUI, or custom script)

---

## Gaps and Phase-Specific Research

**For Phase roadmap planning, these areas need deeper research once a direction is chosen:**

| Hosting Direction | Phase-Specific Research Needed |
|-------------------|--------------------------------|
| Native Services (NSSM) | Service start/stop order dependencies; graceful shutdown handling for eventlet greenlets; log aggregation strategy |
| Docker-less | None (proven to work currently) |
| Podman | **Print agent LAN reachability solution** (critical path blocker); WSL2 IP churn mitigation |
| Rust Rewrite | Socket.IO Rust crate maturity and async compatibility; async database pool management; error handling translation from Python |
| Electron | PostgreSQL bundling approach (if pursuing); IPC design for common interactions; app update distribution strategy |
| Supervisor | Supervisor Windows service registration; process ordering/dependencies; centralized log rotation |

---

## Confidence Levels

| Area | Confidence | Notes |
|------|------------|-------|
| Docker-without-Rancher | **HIGH** | Already proven to work; only difference is removing UI layer |
| Native Windows Services | **MEDIUM-HIGH** | NSSM/WinSW are stable; reverse proxy setup is straightforward; eventlet interaction untested |
| Supervisor | **HIGH** | Supervisor is mature and Python-native; setup is proven; low risk |
| Podman on Windows | **LOW** | Print agent networking issue is not elegantly solved; WSL2 limitations are documented but complex |
| Rust Rewrite | **MEDIUM** (for Rust viability, but **VERY HIGH RISK** for this project) | Rust is proven for systems programming; porting Flask is feasible; but scope is massive and payoff is unclear |
| Electron Wrapped | **MEDIUM** | Electron child process management is proven; PostgreSQL bundling is problematic; IPC adds complexity without clear benefit |

---

## Verdict and Next Steps

**Without forcing a decision (user chooses after all researchers report):**

1. **Immediate viable option:** Docker-without-Rancher (1 day to migrate, zero risk, keeps status quo)

2. **Best operational simplicity:** Supervisor (3-5 days to migrate, transparent native processes, centralized monitoring)

3. **Best native isolation:** Native Windows Services (NSSM) (1-2 weeks, no Docker dependency, straightforward debugging)

4. **Avoid:**
   - Podman on Windows (print agent networking is a showstopper)
   - Rust rewrite (massive scope, unproven benefit, team expertise gap)
   - Electron wrapping (PostgreSQL bundling is complex, adds app size, no clear win)

**Recommended decision criteria for the user:**

- **If "remove Docker entirely" is a hard requirement:** Native Windows Services or Supervisor
- **If "minimal disruption to current workflow" is priority:** Docker-without-Rancher (just remove Rancher)
- **If "best observability and log management" matters:** Supervisor (web UI, centralized logs)
- **If "simplest single-machine operations" is the goal:** Supervisor

All three viable options (Docker-less, Native, Supervisor) are proven and low-risk. The difference is operational preference, not technical capability.

---

**Research date:** 2026-08-08  
**Sources:** Web research on Windows services, Docker alternatives, Podman networking, Electron child processes, Supervisor configuration, Rust web frameworks and Windows service integration. All external sources cited inline in findings above.
