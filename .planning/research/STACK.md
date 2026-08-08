# Hosting Stack Alternatives: Research Findings

**Project:** Billar POS (Flask + PostgreSQL + React + Socket.IO + Telegram bot + APScheduler on Windows 11, 8GB RAM)

**Research Date:** 2026-08-08

**Objective:** Replace Docker Desktop + Rancher Desktop with a hosting model that reduces RAM/CPU overhead, improves reliability/crash isolation, and remains operable by non-technical bar staff.

---

## Recommended Starting Point: Docker Engine in WSL2

**Why this option first:** Lowest migration friction + measurable 50% RAM overhead reduction while preserving container isolation and docker-compose familiarity.

### What It Is

Docker Engine running natively inside Windows Subsystem for Linux 2 (WSL2), accessed via the `docker` CLI from Windows, without the Docker Desktop GUI layer. Uses the same `docker-compose` configuration you have today.

### Resource Profile & Performance

| Metric | Value | Comparison to Current |
|--------|-------|----------------------|
| **Idle RAM** | 1.0–1.5 GB | Current: 2–4 GB (Docker Desktop + Rancher). **Saves: ~50% overhead.** |
| **Container overhead (5 containers)** | ~250 MB | Unchanged from current; each container ~50 MB. |
| **Total predicted on 8GB** | ~2.5–3 GB in use | Leaves ~5 GB for Windows + POS workload (sufficient for peak load). |
| **CPU (idle)** | <1% | No daemon process consuming background cycles. |
| **Startup time** | ~45–60 seconds | Same as docker-compose today. |

### Process Supervision & Crash Isolation

- **Auto-start on boot:** WSL2 auto-starts via `.wslconfig`; Task Scheduler triggers `docker-compose up -d`.
- **Per-container restart:** Docker engine restarts failed containers (configurable `restart_policy: always`). One container crash (e.g., Flask) does NOT affect others (PostgreSQL, frontend, scheduler, bot continue).
- **Crash recovery:** If a container exits unexpectedly, Docker restarts it within ~5 seconds. PostgreSQL data integrity is preserved (separate volume).
- **Docker engine crash (rare):** Restart WSL2 VM via `wsl --restart` or system reboot. Recovery time: ~30 seconds. Containers resume from last state.

### Why It Fits Your Constraints

| Constraint | How Met |
|-----------|---------|
| 8GB RAM | Reduces idle overhead by 50% vs Docker Desktop. Leaves ~5GB for OS + workload. |
| Single Windows machine | WSL2 is built into Windows 11. No external services or cloud dependencies. |
| LAN-only / no internet required | Docker Engine is self-contained. No license/authentication calls to Docker Hub. |
| Non-technical staff | Staff use `docker-compose up/down` (same as now) via `scripts/start.sh`. No behavior change. |
| Reliability & crash isolation | Container isolation proven by years of Docker production use. |

### Migration Effort: **LOW** (1–2 weeks)

**Concrete steps:**
1. Install WSL2 (built-in Windows 11 feature; `wsl --install` + reboot).
2. Install Ubuntu 22.04 LTS inside WSL2.
3. Install Docker Engine in Ubuntu (follow official guide; ~5 minutes).
4. Copy your `docker-compose.yml` into WSL2 filesystem.
5. Run `docker-compose up -d` from WSL2 bash.
6. Test: `docker ps`, `curl http://localhost:3000`, `curl http://localhost:5000/api/health`.
7. Optionally: Configure auto-start via Windows Task Scheduler.

**No code changes to backend/frontend needed.**

---

## Alternatives Considered (7 Concrete Options)

### Quick Comparison Table

| Option | Idle RAM | Supervision | Crash Isolation | Migration Effort | Best For |
|--------|----------|------------|-----------------|------------------|----------|
| **1. Docker Engine in WSL2** | 1.0–1.5 GB | Docker restart policies | Per-container | LOW | Familiar docker-compose + ~50% RAM savings |
| **2. Native Windows Services (NSSM/WinSW)** | ~300–500 MB | Windows Service Manager + NSSM wrappers | Per-service | MEDIUM | Pure Windows; absolute lowest RAM |
| **3. Podman Desktop on Windows** | 0.5–1.0 GB | Podman machine + container restart | Per-container | LOW-MEDIUM | Daemonless containers; lower idle RAM |
| **4. Docker Desktop only (remove Rancher)** | 2.0–2.5 GB | Docker Desktop + container restart | Per-container | NONE | Quick incremental gain; minimal effort |
| **5. Rust Backend Rewrite (Axum/Actix) + native services** | ~400–600 MB | Windows Service Manager (NSSM) | Per-service | VERY HIGH (3–4 months) | Long-term efficiency if Rust team exists |
| **6. PM2 Process Supervisor** | ~600–800 MB | PM2 daemon polling/restarting children | Per-process | LOW-MEDIUM | Centralized logging; if Node.js familiar |
| **7. Electron Desktop App Wrapper** | ~750–950 MB | Electron main process orchestrating children | Electron-dependent | HIGH (6–8 weeks) | Multi-bar expansion; branded desktop app |
| **8. Lightweight Custom Supervisor (Rust/Go)** | ~500–700 MB | Custom binary polling processes | Per-process | MEDIUM-HIGH (2–3 weeks) | Minimalist; if custom logic needed |

---

### Option 2: Native Windows Services (NSSM / WinSW / Servy)

**Resource Footprint: ~500–800 MB total** (Lowest; saves ~2 GB vs Docker)

Wrapper executables registering Flask, PostgreSQL, scheduler, bot as Windows Services. Managed via `services.msc` and Windows Service recovery policies.

**Supervision:** Windows Service Manager recovery tab (auto-restart on 1st/2nd/3rd failure after 5/30/60 seconds). Each service independent; one crash doesn't cascade.

**Migration Effort: MEDIUM** (2–3 weeks)
- Code: Minimal. Replace `gunicorn --worker-class eventlet` with Waitress (pure Python WSGI; no code changes).
- Configuration: NSSM batch/PowerShell setup scripts; recovery policies.
- Operational: Staff must understand Windows Services GUI; logs in Windows Event Viewer (scattered, not centralized).

**Advantages:** Lowest RAM; no isolation layer overhead; crash isolation inherent to OS processes.

**Disadvantages:** Service management complexity; fragmented logs; Waitress different from eventlet; on-site debugging harder for non-technical staff.

**Versions:** NSSM v2.25, WinSW v2.12, Waitress v3.0.1, PostgreSQL EDB v15.7+

---

### Option 3: Podman Desktop on Windows

**Resource Footprint: ~0.8–1.5 GB total** (Light; ~500 MB lighter than Docker Desktop)

Daemonless container runtime with optional desktop GUI. Same docker-compose syntax via `podman-compose`.

**Supervision:** Podman machine auto-starts on boot; container restart policies same as Docker. Daemonless = zero idle RAM when containers stopped.

**Migration Effort: LOW-MEDIUM** (1 week)
- Code: None.
- Configuration: Minimal. `podman-compose` drops in for `docker-compose` (~95% compatible).
- Operational: CLI-centric; fewer GUI features than Docker Desktop (but you won't use it).

**Advantages:** Daemonless architecture; lower footprint than Docker Desktop; OCI-compliant; rootless by default (security).

**Disadvantages:** Smaller ecosystem than Docker; `podman-compose` compatibility ~95% (edge cases); newer/less battle-tested in production.

**Versions:** Podman Desktop v1.12+, Podman CLI v5.2+, podman-compose v1.2.0+

---

### Option 4: Docker Desktop Only (Remove Rancher)

**Resource Footprint: ~2.5–3.0 GB** (Minimal improvement; still heavy)

Uninstall Rancher Desktop GUI layer; keep Docker Desktop running.

**Migration Effort: NONE** (Zero effort; immediate savings of ~500 MB)

**Advantages:** Zero effort; incremental improvement; Docker Desktop GUI still available.

**Disadvantages:** Minimal improvement; Docker Desktop still 2–4 GB idle; doesn't solve core problem.

**Recommendation:** Only if you want a quick win. Plan medium-term migration to WSL2 or native services.

---

### Option 5: Rust Backend Rewrite (Axum / Actix-web) + Native Windows Services

**Resource Footprint: ~400–600 MB total** (Extreme savings; ~2.5 GB vs Docker)

Complete rewrite of Flask → Rust (Axum or Actix-web), Socket.IO in Rust, scheduler in Rust, bot in Rust. Compile to Windows binary; run as service via NSSM.

**This is NOT a hosting solution.** It's a long-term architectural investment. Justified only if:
- Backend team is Rust-proficient or strongly committed.
- Team has 3–4 months capacity (no active feature dev).
- Resource efficiency is strategic priority (unlikely for single-bar POS).

**Migration Effort: VERY HIGH** (3–4 months, full-time)
- Rewrite Flask endpoints to Axum: 3–4 weeks (~1000 lines of endpoints).
- Implement Socket.IO in Rust: 2–3 weeks (Rust libraries immature; v0.1–0.2; may need custom work).
- Migrate APScheduler → Rust scheduler: 1 week.
- Migrate Telegram bot to Rust: 1 week.
- Database access (SQLAlchemy → SQLx/Diesel): 2 weeks.
- Testing & integration: 2–3 weeks (thin current coverage; rebuild from scratch).
- Build & deployment: 1 week.
- **Total: 12–16 weeks (3–4 months)**

**Advantages:** Extreme resource efficiency (75%+ RAM savings); compiled performance; type safety.

**Disadvantages:** Massive effort; Socket.IO library immaturity; team ramp-up; thin test coverage; high risk to production; maintenance burden; branch management complexity.

**Versions:** Axum v0.7.9, Actix-web v4.13, tokio-socketio v0.1–0.2 (immature), Teloxide v0.27+, SQLx/Diesel v0.7.x

**Recommendation:** Reserve for separate, later milestone if Rust adoption becomes strategic goal. Do NOT pursue as hosting solution.

---

### Option 6: PM2 Process Supervisor

**Resource Footprint: ~600–800 MB total** (Similar to NSSM; requires Node.js)

Node.js-based process manager supervising Flask, scheduler, bot, frontend. Centralized logging; auto-restart on crash.

**Supervision:** PM2 daemon polls processes every ~1.5 sec; one crash → immediate restart. Crash isolation per-process (one crash doesn't affect PM2 or others).

**Migration Effort: LOW-MEDIUM** (1–2 weeks)
- Code: None to backend.
- Configuration: Write `ecosystem.config.js` (~30 lines).
- Testing: Verify each process starts, logs visible, crash-restart works.
- Operational: Staff learn `pm2 status`, `pm2 logs`, `pm2 restart app`.

**Advantages:** Low RAM; centralized logs (`pm2 logs` better UX than Windows Event Viewer); easy debugging; cross-platform (Linux/macOS compatible).

**Disadvantages:** Node.js dependency (adds ~200 MB disk); PM2 Node.js-centric (Python support secondary); on-site debugging requires PM2 CLI knowledge.

**Versions:** PM2 v5.x–6.x (600M+ downloads; actively maintained), Node.js v20 LTS or v22 LTS

**Recommendation:** Good if team already uses Node.js and comfortable with process managers. Otherwise prefer NSSM or Docker/WSL2.

---

### Option 7: Electron Desktop App Wrapper

**Resource Footprint: ~750–950 MB total** (Slightly heavier due to Electron Chromium)

Package entire stack (Flask, PostgreSQL, React frontend, scheduler, bot) inside Electron desktop app. Electron main process orchestrates children; tray icon shows status.

**Supervision:** Electron main process detects child crashes and restarts (requires custom code). Auto-updates via `electron-updater`.

**Migration Effort: HIGH** (6–8 weeks)
- Write Electron main process: 1–2 weeks (child spawning, IPC, error recovery, tray icon).
- Implement child supervision: 1 week (crash detection, exponential backoff).
- Integration testing: 2 weeks (all crash scenarios).
- Installer creation (Electron Builder): 1 week.
- Documentation: 1 week.
- **Total: 6–8 weeks**

**Advantages:** Branded desktop app; auto-update ready; unified packaging; decent crash handling.

**Disadvantages:** Heavy Electron overhead (~110 MB Chromium) wasteful for single POS running web app; complex supervision logic; Postgres bundling balloons installer; overkill for single-bar deployment.

**Best For:** Multi-location businesses needing branded app + centralized updates. **Not** single-bar POS.

**Versions:** Electron v34+ (Chromium 132, Node 22; Jan 2025), electron-builder v26+

---

### Option 8: Lightweight Custom Supervisor (Rust/Go)

**Resource Footprint: ~500–700 MB** (Same as NSSM; requires custom development)

Write small supervisor binary (~100–200 lines Rust/Go) polling process status and restarting failed processes. Deploy supervisor as Windows Service via NSSM.

**Supervision:** Supervisor polls every 5–10 sec; process dies → immediate restart (faster than Windows Service recovery). Exponential backoff prevents spam-restart.

**Migration Effort: MEDIUM-HIGH** (2–3 weeks)
- Write supervisor: 2–3 days (~100–200 lines of code).
- Test crash scenarios: 1 week.
- Logging & monitoring: 3–5 days.
- Packaging as service: 2–3 days.
- Documentation: 3–5 days.
- **Total: 2–3 weeks**

**Advantages:** Minimalist (custom binary doing exactly what you need); low overhead (~10–30 MB); fast iteration if custom logic needed.

**Disadvantages:** Maintenance burden (you own this code); no ecosystem/StackOverflow answers; Rust/Go learning curve; testing complexity; on-site debugging harder.

**Best For:** Minimalist teams wanting absolute control. Only if Rust/Go developer available.

---

## Summary: Recommendation & Decision Framework

### Primary Recommendation: Docker Engine in WSL2

**Ranked #1 because:**

1. **Balanced tradeoffs:** 50% RAM savings + familiar docker-compose + proven container isolation.
2. **Lowest migration risk:** Copy `docker-compose.yml`, run inside WSL2. Minimal code/config changes.
3. **Operational simplicity:** Staff use same `scripts/start.sh` commands. No retraining.
4. **Crash isolation proven:** Docker containers provide reliable process boundaries.
5. **Flexible off-ramps:** If WSL2 doesn't work, pivot to NSSM/Podman without major redesign.

### Quick Decision Framework

**"We need improvement NOW, low effort"** → Docker Engine in WSL2 (recommended)

**"We want to drop containers entirely"** → NSSM + Waitress (lowest RAM; most Windows-native)

**"We want lighter containers, not full rewrite"** → Podman Desktop (daemonless; OCI-compliant)

**"We like centralized logging + cross-platform"** → PM2 (if Node.js familiar; else prefer NSSM)

**"We need branded desktop app for multi-bar expansion"** → Electron (overkill for single bar, but strategic)

**"We're investing in Rust ecosystem long-term"** → Rust backend rewrite (separate milestone; not hosting fix)

---

## Sources

- [itsourcecode.com — How to Install Docker on Windows 11 (2026)](https://itsourcecode.com/docker/how-to-install-docker-on-windows-11-2026/)
- [medium.com — Installing Docker Engine on Windows 11 Without Docker Desktop](https://medium.com/@khan.ahmed.m/installing-docker-engine-on-windows-11-without-docker-desktop-c0d40a68ed63)
- [FlowFuse Docs — Docker Engine on Windows](https://flowfuse.com/docs/install/docker/windows-docker-ce/)
- [dev.to — How to Install Docker Desktop on Windows 11 (2026)](https://dev.to/interdata/how-to-install-docker-desktop-on-windows-11-step-by-step-guide-for-2026-1d26)
- [daily.dev — Docker vs Podman in 2026](https://daily.dev/blog/docker-vs-podman-container-runtime-which-to-use/)
- [Uptrace — Podman vs Docker Comparison 2025](https://uptrace.dev/comparisons/podman-vs-docker)
- [dev.to — Docker vs Podman (2025-2026)](https://dev.to/mechcloud_academy/docker-vs-podman-an-in-depth-comparison-2025-2eia)
- [nssm.cc — NSSM (Non-Sucking Service Manager)](https://nssm.cc/download)
- [dev.to — Servy vs. NSSM vs. WinSW](https://dev.to/aelassas/servy-vs-nssm-vs-winsw-2k46)
- [pypi.org — Waitress 3.0.1](https://pypi.org/project/waitress/3.0.1/)
- [podman.io — Podman Desktop Installation](https://podman.io/getting-started/installation/windows)
- [github.com — podman-compose](https://github.com/containers/podman-compose)
- [pm2.io — PM2 (Advanced Process Manager)](https://pm2.keymetrics.io/)
- [github.com — Unitech/pm2](https://github.com/Unitech/pm2)
- [electronjs.org — Electron Documentation](https://www.electronjs.org/)
- [github.com — electron-builder](https://github.com/electron-userland/electron-builder)
- [shuttle.dev — The Ultimate Guide to Axum (2025)](https://www.shuttle.dev/blog/2023/12/06/using-axum-rust)
- [sharpskill.dev — Actix Web vs Axum 2026](https://sharpskill.dev/en/blog/rust/rust-actix-web-vs-axum-comparison)
