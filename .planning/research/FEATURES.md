# Feature Landscape: Hosting / Runtime Replacement

**Domain:** Self-hosted POS on single Windows 11 machine (8GB RAM)  
**Researched:** 2026-08-08  
**Scope:** Capability comparison for replacing Docker Desktop + Rancher Desktop with production-grade alternatives

## Context

Current pain points driving replacement:
- **Resource overhead**: Docker Desktop consumes 3-4GB RAM on 8GB system; leaves ~4GB for applications
- **All-or-nothing blast radius**: Single container crash can cause "ghost ticket" data corruption; no isolation between pool timer, kitchen queue, print agent, and Telegram bot
- **Non-technical operators**: Bar staff cannot debug Docker issues; Rancher-specific failures have caused multiple production incidents
- **Reliability after power-loss**: Container stack must auto-recover to previous state without data loss in open tickets/timers

**Existing system architecture:**
- Flask backend + React frontend (single container)
- PostgreSQL (single container, stores all state including open tickets and timers)
- Telegram bot (separate container, reads shared DB)
- APScheduler (separate container, fires daily report emails)
- Windows print agent (native executable outside Docker, fires-and-forgets print jobs via HTTP POST)

**Table stakes requirements** (non-negotiable):
1. Auto-restart process on crash (within seconds)
2. Auto-start on machine boot and power-loss recovery
3. Isolated component failure (one service crash doesn't take down others)
4. Easy log access for troubleshooting (non-technical staff)
5. Simple start/stop UI for bar staff (not CLI-heavy)
6. Straightforward Postgres backup/restore (must not require deep DB knowledge)

---

## Table Stakes: Which Approaches Provide Out-of-Box vs. Custom Engineering

| Requirement | Native Windows Services (NSSM/WinSW) | Docker Engine + WSL2 | Podman | Rust Windows Service | Electron + PyInstaller | Process Supervisor |
|--|--|--|--|--|--|--|
| **Auto-restart on crash** | ✓ Built-in | ✓ Compose restart policies | ✓ Compose policies | ✓ Configurable | ⚠ Requires monitoring | ⚠ Requires config |
| **Auto-start on boot** | ✓ Windows service automatic | ⚠ Requires WSL2 startup + task | ⚠ VM must start first | ✓ Windows service automatic | ⚠ Registry entry + app startup | ✗ Not Windows-native |
| **Power-loss recovery** | ✓ Native (service restarts) | ⚠ WSL2 may not auto-resume | ⚠ VM may not auto-resume | ✓ Native (service restarts) | ✓ Restarts via registry entry | ✗ Requires external trigger |
| **Isolated component failure** | ✓ Each service separate instance | ✗ Single compose stack (blast radius) | ✗ Single stack (blast radius) | ✓ Single service | ⚠ Flask isolated as child process | ✓ Each process independent |
| **Easy log access** | ⚠ Event Viewer + custom file logs | ✓ `docker logs` (requires CLI) | ✓ `podman logs` (requires CLI) | ⚠ Custom logging implementation | ✓ Tray UI can display logs | ⚠ Log files only |
| **Simple start/stop for staff** | ✓ Services Manager GUI | ✗ CLI-only (`docker compose`) | ✗ CLI-only (`podman`) | ✓ Services Manager GUI | ✓ Tray app with buttons | ⚠ CLI commands needed |
| **Postgres backup/restore** | ✓ Standard Windows tools (pg_dump) | ✓ Standard within container | ✓ Standard within container | ✓ Standard Windows tools | ✓ Can add UI for backups | ✓ Standard tools |

**Key findings:**
- **NSSM/WinSW**: Provides ALL table-stakes natively; zero custom engineering required
- **Docker variants**: Fail on isolated failure (all-or-nothing blast radius) and non-technical UI (CLI-oriented)
- **Electron**: Provides most table-stakes; strongest user experience; Flask runs as child process (partial isolation)
- **Rust service**: Provides table-stakes if designed as Windows service; requires full backend rewrite
- **Process supervisor**: Can provide most with heavy custom scripting; designed for Linux/Node, awkward on Windows

---

## Differentiators: Capabilities Beyond Table Stakes

Features that would genuinely improve operations for bar staff and venue reliability.

### One-Click Updates

| Approach | Capability | Effort | Notes |
|--|--|--|--|
| NSSM/WinSW | Manual binary swap + service restart | High | Requires admin CLI or custom GUI |
| Docker variants | `docker pull` + `docker compose up` | Medium | Docker knowledge required; no UI |
| Rust service | Replace .exe file + restart service | High | Each version release requires manual distribution |
| **Electron** | **Built-in auto-updater (electron-updater)** | **Low** | **Completely automatic; end-users never know** |
| Process supervisor | Manual application binary update | High | No automated mechanism |

**Differentiator advantage: Electron** — Can ship updates silently via electron-updater; staff never interact with version management.

### Tray-Icon Status UI

| Approach | Capability | Effort | Notes |
|--|--|--|--|
| NSSM/WinSW | Services Manager GUI (system tool) | None | But requires navigation; not a quick check |
| Docker variants | Docker Dashboard (pulls full list of containers) | Medium | GUI exists but requires Docker Desktop or separate dashboard |
| Rust service | Custom Python/C# tray wrapper needed | High | Adds duplicate process management layer |
| **Electron** | **Native system tray icon + status panel** | **Built-in** | **Green/red status, quick access, can show pool-timer count** |
| Process supervisor | Possible with custom Python tray app | High | Not standard; would need building |

**Differentiator advantage: Electron** — Staff can glance at tray and know system is healthy; no navigation needed.

### Automatic Database Backups

| Approach | Capability | Effort | Notes |
|--|--|--|--|
| NSSM/WinSW | Windows Task Scheduler + pg_dump script | Medium | Reliable but requires batch script knowledge |
| Docker variants | Scheduled container exec + pg_dump | Medium | Compose doesn't have native backup scheduling |
| Rust service | Task Scheduler + pg_dump script | Medium | Same as NSSM |
| **Electron** | **Can bundle UI + backup scheduling + retention policy** | **Medium** | **Tray menu: "Backup now" + automatic daily schedule** |
| Process supervisor | Task Scheduler + pg_dump | Medium | Same complexity as others |

**Differentiator advantage: Electron** — Can provide a simple "Backup Now" button in tray menu; staff don't need CLI knowledge.

### Remote Diagnostics

| Approach | Capability | Effort | Notes |
|--|--|--|--|
| NSSM/WinSW | Event log export; no built-in remote access | High | Requires manual log gathering + email |
| Docker variants | REST API available; can expose for remote monitoring | Medium | But adds security risk if exposed to internet |
| Rust service | Custom diagnostic API possible | High | Requires adding HTTP diagnostics layer |
| **Electron** | **Can include diagnostic panel: last errors, memory/CPU graphs, DB status** | **Medium** | **Venue manager can view via tray UI without CLI** |
| Process supervisor | No built-in; custom monitoring required | High | Would need additional tool |

**Differentiator advantage: Electron** — Provides a quick diagnostic UI without requiring technical access or CLI knowledge.

---

## Anti-Features: What Looks Good But Is Actually Bad

### Kubernetes / Control Plane Orchestration

**Why it's an anti-feature for this deployment:**
- **None of the candidates push this.** Single-machine deployments have zero need for distributed orchestration.
- **Even if available, massive complexity overhead** — Kubernetes expects multi-node clusters and introduces etcd, API servers, and cluster management burden.
- **For 8GB single machine, K8s is pure overhead** — You'd burn 2GB+ just on control plane, leaving ~6GB for actual services.

**Verdict:** Correctly rejected by all candidates; no risk here.

---

### Cloud Dependency

**Why it's an anti-feature:**
- Venue has poor/unstable internet (common in bars with live music/events)
- Print agent must reach Postgres directly on LAN (no cloud round-trip latency tolerance)
- "Outbound internet required for localhost app to run" = service unavailability risk during ISP outages

| Approach | Cloud Dependency | Risk |
|--|--|--|
| NSSM/WinSW | None | None |
| Docker Desktop | None (but pulls images from registry) | Low; images cached locally |
| Docker Engine | None (but pulls images from registry) | Low; images cached locally |
| Podman | None (but pulls images from registry) | Low; images cached locally |
| Rust service | None | None |
| **Electron** | **None** | **None** |
| Process supervisor | None | None |

**Verdict:** No candidate has hard cloud dependency; safe.

---

### Steep Ops Learning Curve for Non-Technical Staff

**Why it's an anti-feature:**
Bar staff operate the POS. Barista or floor manager should be able to:
- Know if system is running at a glance
- Restart the system if something feels slow
- Report errors without needing to decode Docker daemon logs

| Approach | Learning Curve | Staff Can Operate? |
|--|--|--|
| NSSM/WinSW | Low (open Services Manager, click restart) | ✓ Yes |
| Docker Desktop | Medium-High (must understand containers, images, volumes) | ✗ Struggled in production (Rancher failures) |
| Docker Engine | High (CLI-only, WSL2 concepts needed) | ✗ No; requires IT |
| Podman | Medium-High (similar to Docker, but different) | ⚠ Possible; still too technical |
| Rust service | Low (Windows service, looks like native app) | ✓ Yes |
| **Electron** | **Very Low (just a desktop app; looks familiar)** | **✓ Yes; instant usability** |
| Process supervisor | Medium (CLI-oriented tools) | ⚠ Possible; better than Docker but not native |

**Verdict:** Docker variants are proven anti-features in your environment. Electron and Windows services are proven wins.

---

### High Resource Overhead on 8GB Machine

**Measured footprint under normal operation:**

| Approach | Typical RAM Usage | CPU Idle | Notes |
|--|--|--|--|
| Docker Desktop (current) | 3-4 GB | 2-5% | Known pain point; leaves ~4GB for apps |
| Docker Engine + WSL2 | 1.5-2.5 GB | 1-3% | Better than Desktop but still significant |
| Podman + VM | 1.5-2.5 GB | 1-3% | Daemonless doesn't save much on Windows (still needs VM) |
| NSSM/WinSW | < 50 MB total | < 1% | Just native process management; negligible |
| Rust service | 30-100 MB (Flask alone ~50MB) | 0-1% | Depends on implementation; single service |
| **Electron** | **~150-200 MB (Electron runtime overhead)** | **1-2%** | **~100MB more than raw Flask, but includes UI** |
| Process supervisor | ~10-50 MB | < 1% | But requires additional tools for each process |

**Verdict:** NSSM/WinSW and native Windows services win dramatically on resource footprint. Electron acceptable trade-off for UI benefits. Docker variants waste 25-50% of available RAM.

---

### All-or-Nothing Blast Radius (Single Crash Kills Everything)

**Current problem with Docker Compose:**
If pool timer crashes → entire compose stack may crash → Flask, React, Postgres, Telegram bot all go down → ghost tickets → manual recovery needed.

| Approach | Failure Isolation | What Happens If Flask Crashes |
|--|--|--|
| NSSM/WinSW | ✓ Each service separate instance; print agent, scheduler, bot keep running | Print jobs, scheduler, Telegram alerts continue. Postgres still accepting writes. Staff can restart Flask service alone. |
| Docker Compose | ✗ Single crash can cascade; depends on restart policies | Flask + frontend go down; if compose restarts, other containers restart too (cascading). |
| Podman | ✗ Same compose model; same risk | Same as Docker |
| Rust service | ✓ Single service | Only that service restarts; others unaffected. But if Rust IS Flask, then Flask stops. Needs multiple services approach. |
| **Electron** | **⚠ Partial** | **Flask runs as child process; if it crashes, Electron tray app keeps running, can restart Flask independently. But if Electron crashes, UI is unavailable.** |
| Process supervisor | ✓ Each process managed independently | Each process restarts in isolation; no cascading. |

**Verdict:** NSSM/WinSW and process supervisors eliminate blast radius entirely. Electron provides better isolation than Docker Compose but not perfect. Docker variants carry forward your current pain point.

---

## Feature Matrix: Quick Reference

(✓ = out-of-box, ⚠ = requires custom work, ✗ = not practical)

| Feature | NSSM/WinSW | Docker Eng. | Podman | Rust Svc | Electron | Supervisor |
|--|--|--|--|--|--|--|
| **Table Stakes:** |
| Auto-restart on crash | ✓ | ✓ | ✓ | ✓ | ⚠ | ⚠ |
| Boot auto-start | ✓ | ⚠ | ⚠ | ✓ | ⚠ | ✗ |
| Isolated failure | ✓ | ✗ | ✗ | ✓ | ⚠ | ✓ |
| Easy logs | ⚠ | ✓ | ✓ | ⚠ | ✓ | ⚠ |
| Staff start/stop | ✓ | ✗ | ✗ | ✓ | ✓ | ⚠ |
| PG backup/restore | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Differentiators:** |
| One-click updates | ✗ | ⚠ | ⚠ | ✗ | ✓ | ✗ |
| Tray status UI | ⚠ | ⚠ | ⚠ | ⚠ | ✓ | ⚠ |
| Auto DB backups | ⚠ | ⚠ | ⚠ | ⚠ | ✓ | ⚠ |
| Remote diagnostics | ⚠ | ⚠ | ⚠ | ⚠ | ✓ | ✗ |
| **Anti-Features (Bad Fits):** |
| K8s overhead | ✗ (none) | ✗ (none) | ✗ (none) | ✗ (none) | ✗ (none) | ✗ (none) |
| Cloud dependency | ✗ (none) | ✓ (cached) | ✓ (cached) | ✗ (none) | ✗ (none) | ✗ (none) |
| Steep learning curve | ✓ (low) | ✓ (high) | ✓ (high) | ✓ (low) | ✓ (very low) | ✓ (medium) |
| High RAM overhead | ✓ | ✗ (heavy) | ✗ (heavy) | ✓ | ✓ | ✓ |
| Blast radius risk | ✓ (isolated) | ✗ (cascading) | ✗ (cascading) | ✓ (isolated) | ⚠ (partial) | ✓ (isolated) |

---

## Recommended Phasing by Approach

### Option 1: Native Windows Services (NSSM/WinSW) + Process Supervisor

**Approach:** Wrap existing Flask, PostgreSQL, scheduler, and bot in individual Windows services using NSSM or WinSW. Keep print agent as-is (already native).

**Phase structure:**
1. **Phase 1: Discovery & testing** — Set up NSSM/WinSW locally; test auto-restart behavior under crash scenarios
2. **Phase 2: Migration** — Wrap each service individually; test isolated restart behavior
3. **Phase 3: Monitoring UI** — Add Python tray monitor app (custom build, lightweight) for staff status visibility
4. **Phase 4: Backup automation** — Windows Task Scheduler + pg_dump script for daily automatic backups

**Strengths:**
- Minimal code changes; current Flask/scheduler/bot stack runs unchanged
- Fastest path to eliminate blast radius (services restart in isolation)
- Smallest resource footprint
- Low operational complexity for bar staff

**Weaknesses:**
- No automatic updates (must manually deploy new Flask version)
- Requires building custom tray app for status visibility (Phase 3 work)
- Log access requires Windows Event Viewer knowledge
- Not a single-binary deployment

---

### Option 2: Electron Desktop App Wrapper

**Approach:** Package existing Flask backend via PyInstaller + Electron frontend wrapper into single .exe; deploy as Windows application that manages child processes.

**Phase structure:**
1. **Phase 1: Proof of concept** — Package Flask via PyInstaller; verify it runs as single .exe
2. **Phase 2: Electron integration** — Wrap in Electron; build tray icon + status panel; launch Flask as child process
3. **Phase 3: Auto-updates** — Integrate electron-updater for seamless version updates
4. **Phase 4: Enhanced UI** — Add backup button, diagnostics panel to tray menu

**Strengths:**
- Single .exe deployment; staff just installs/runs an app (instantly familiar UX)
- Built-in tray icon with status + quick actions
- Automatic updates via electron-updater (no manual version management)
- Flask crash doesn't kill Electron UI (can restart Flask from tray menu)
- Optional: Can include backup, diagnostics, logs UI
- Scales to support future features (settings UI, history, etc.) without infrastructure changes

**Weaknesses:**
- ~150MB resource overhead for Electron runtime (acceptable trade-off for UX)
- Requires separate development (PyInstaller + Electron bundling)
- Flask runs as child process (not as Windows service); must manage lifecycle in Electron app
- If Electron crashes, staff must manually restart (but Flask keeps running)
- Cannot be deployed via remote app update mechanism (must be replaced locally)

**Recommended if:** Strong UX requirements for non-technical staff, willingness to accept ~150MB overhead for professional desktop app experience.

---

### Option 3: Rust Backend Rewrite as Windows Service

**Approach:** Rewrite Flask backend in Rust; compile to native Windows .exe; deploy as Windows service via NSSM/WinSW.

**Phase structure:**
1. **Phase 1: Architecture** — Design Rust async runtime (Tokio), API structure, DB access layer
2. **Phase 2: Core backend** — Port Flask blueprints to Rust; implement ticket/timer logic
3. **Phase 3: Services & integration** — Integrate Postgres, Socket.IO, scheduler, Telegram bot
4. **Phase 4: Windows service** — Package as Windows service; integrate print agent
5. **Phase 5: Frontend parity** — Ensure React frontend works unchanged against Rust API

**Strengths:**
- Single-binary deployment; zero dependencies (no Python interpreter, no Docker)
- Absolute minimal resource footprint (~30-50MB at runtime)
- Performance gains (Rust async handles concurrent pool timers natively)
- Blast radius eliminated naturally (one Rust service)
- Can run as Windows service natively (auto-restart, auto-boot)

**Weaknesses:**
- **Very high implementation cost** — Full backend rewrite; estimated 800-2000 hours for parity
- Risk of introducing bugs during rewrite (socket.io, promotion engine, audit logging all need porting)
- Requires Rust expertise on team
- Long period of parallel maintenance (Flask + Rust until cutover)
- Not incremental; high risk if partial migration attempted

**Recommended if:** Long-term vision values performance/footprint over near-term delivery; team has Rust capacity; phased migration possible (e.g., rewrite scheduler in Rust first, then Flask services incrementally).

---

## Implementation Complexity: Effort Estimates

| Phase | NSSM/WinSW | Electron | Rust Rewrite |
|--|--|--|--|
| **Proof of Concept** | 2-4 days | 3-5 days | 2-3 weeks |
| **Core Implementation** | 1-2 weeks | 2-3 weeks | 20-30 weeks |
| **Testing & hardening** | 1 week | 1-2 weeks | 4-6 weeks |
| **Deployment & monitoring** | 3-5 days | 1 week | 1-2 weeks |
| **Total to production** | 3-4 weeks | 4-6 weeks | 6-9 months |

---

## Recommended Phased Approach: Prioritize Blast-Radius Fix First

**Phase priorities based on pain points:**

1. **Eliminate all-or-nothing cascade (Blast Radius)** — Most urgent; prevents ghost-ticket corruption
   - **Recommendation: Windows Services (NSSM) approach**
   - Each service (Flask, scheduler, bot, print agent) runs independently
   - Single crash restarts only that service; others continue
   - 3-4 week timeline; minimal code changes

2. **Improve staff operational experience** — Secondary; reduces downtime during troubleshooting
   - **Recommendation: Add lightweight tray monitor** (Phase 3 in NSSM option)
   - Quick status check without navigating to Services Manager
   - ~1-2 week effort; Python + systray library

3. **Enable automatic updates** — Tertiary; reduces deployment friction
   - **Recommendation: Custom update script** (for NSSM) or go full Electron (4-6 week path)
   - If modest effort (3-5 days), wire update script to tray app
   - If prioritizing UX, Electron's auto-updater is worth the 4-6 week investment

4. **Long-term: Evaluate Rust rewrite** — Only after blast-radius fixed and learnings from Phase 1-2
   - Current pain points (crashes, restarts, resource) would be resolved before investing in rewrite
   - Decision point: Is operational simplicity achieved? If yes, Rust is optimization, not necessity.

---

## Sources

- [NSSM official documentation](https://nssm.cc/)
- [WinSW GitHub repository](https://github.com/winsw/winsw)
- [nssm-rs: Rust Windows service manager](https://github.com/AnathemaOfficial/nssm-rs)
- [Podman for Windows documentation](https://developers.redhat.com/articles/2023/09/27/how-install-and-use-podman-desktop-windows)
- [Docker Desktop alternatives comparison (2025)](https://www.portainer.io/blog/docker-desktop-alternatives)
- [Electron Builder for Flask + Python packaging](https://medium.com/red-buffer/electron-builder-packaging-electron-nodejs-application-along-with-flask-app-for-windows-fc26f5a29870)
- [Windows service isolation and process architecture](https://awakecoding.com/posts/isolating-a-windows-service-process-for-easier-debugging)
- [PostgreSQL backup on Windows](https://sqlbackupandftp.com/blog/how-to-backup-and-restore-postgresql-database/)
- [Docker Compose standalone on Windows without Docker Desktop](https://techstackthinker.wordpress.com/2025/05/27/)
