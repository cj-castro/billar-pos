# Hosting Replacement Research Summary — Billar POS v1.0

**Project:** Billar POS (Flask + PostgreSQL + React + Socket.IO + Telegram bot + Windows print agent)  
**Domain:** On-premise single-machine POS hosting replacement (Docker Desktop + Rancher → alternative)  
**Researched:** 2026-08-08  
**Confidence:** HIGH (based on production fragilities and 8 concrete alternatives evaluated)

---

## Executive Summary

The Billar POS system currently runs on Docker Desktop + Rancher Desktop on a single Windows 11 machine (8GB RAM), consuming 3–4 GB idle just for the hosting layer. The core application (Flask, React, Postgres, scheduler, Telegram bot, print agent) is platform-agnostic and does not require Docker to function. Researchers evaluated 8 concrete hosting alternatives and converged on 3 viable paths, ranked by implementation effort and operational fit:

1. **Remove Rancher, keep Docker** (immediate 1-day proof) — lowest-friction validation that Rancher was the pain point, not Docker itself
2. **Native Windows Services (NSSM/WinSW)** OR **Supervisor** (1–2 week full migration) — eliminate Docker entirely, achieve 50%+ RAM savings, native process isolation
3. **Docker Engine in WSL2** (1–2 week migration, if Docker stays) — 50% RAM savings while keeping docker-compose familiarity

All researchers agree to **avoid Podman on Windows** (print-agent networking is a showstopper), **reject Rust rewrite** (massive scope, unproven benefit), and **reject Electron** (PostgreSQL bundling is complex without clear win). The decision hinges on operational preference (GUI vs CLI, Docker familiarity vs Windows-native), not technical capability — all three viable paths are proven and low-risk for this single-machine deployment.

**Key risks apply regardless of path chosen:** Postgres data loss during migration, loss of process isolation (cascade failures), print-agent reachability, secrets management, auto-start/boot recovery, and eventlet single-worker constraint violations. Roadmap must address these explicitly in Phase 1–3 before cutover.

---

## Key Findings

### Hosting Alternatives: Ranked & Verdicted

All 8 candidates researched; summarized below with one-line verdict:

| Rank | Option | Idle RAM | Migration | Verdict |
|------|--------|----------|-----------|---------|
| **1** | **Docker Engine in WSL2** | 1.0–1.5 GB | 1–2 weeks | **RECOMMENDED: 50% RAM savings + familiar docker-compose** |
| **2** | **Remove Rancher (Docker only)** | 2.5–3.0 GB | 1 day | **Quick proof; minimal savings; proves Rancher was blocker** |
| **3a** | **Native Windows Services (NSSM/WinSW)** | <500 MB | 1–2 weeks | **Recommended if no Docker desired; full process isolation; manual mgmt** |
| **3b** | **Supervisor (process manager)** | <500 MB | 1–2 weeks | **Recommended if simplicity valued; web UI; best balance** |
| 4 | Podman Desktop on Windows | 1.0–1.5 GB | 1–2 weeks | **AVOID: Print-agent networking blocker; WSL2 complexity** |
| 5 | PM2 (Node.js process manager) | 600–800 MB | 1–2 weeks | **Viable if team Node.js-comfortable; otherwise prefer NSSM/Supervisor** |
| 6 | Rust Backend Rewrite | 30–100 MB | 6–12 months | **REJECT: Massive scope (3–4 months); unproven benefit; team expertise gap** |
| 7 | Electron Desktop Wrapper | 150–200 MB | 4–6 weeks | **REJECT unless multi-bar expansion planned; Postgres bundling unsolved** |
| 8 | Custom Supervisor (Rust/Go) | 500–700 MB | 2–3 weeks | **Not recommended; maintenance burden; no ecosystem support** |

**User Decision Point:** Choose from Tier 1–3 based on operational preference, not capability. All are proven.

---

### Critical Pitfalls All Options Must Address

Regardless of choice, these 8 pitfalls apply universally and MUST be prevented:

1. **Postgres data loss during migration** — Backup before decomissioning Docker; verify restore in test environment
2. **Cascade failures (loss of process isolation)** — Implement independent service restart policies; Docker Compose fails here
3. **Print-agent unreachable** — Update PRINT_AGENT_URL from host.docker.internal:9191 → localhost:9191; add health check
4. **Secrets leak** — Never hardcode secrets; use Windows Credential Manager or encrypted env file; audit startup logs
5. **Auto-start fails after reboot** — Configure explicit service dependencies; implement health checks; test reboot manually
6. **Eventlet single-worker constraint violated** — Enforce gunicorn --worker-class eventlet -w 1; audit code for threading/asyncio
7. **Ghost-ticket recurrence** — Clean all ghosts before migration; implement root-cause fix; test crash recovery in staging
8. **Incomplete rewrite (Rust/Electron)** — Make all-or-nothing decision; no partial rewrites

---

## Implications for Roadmap

Suggested 4–5 phase structure:

### Phase 1: Research + Decision (1 week)
Prove Docker Compose works without Rancher. Uninstall Rancher; run docker-compose up --build; measure RAM; test operations. **Success:** confirm Rancher was pain point.

### Phase 2: Core Services Migration (2–3 weeks)
Migrate to chosen model: WSL2 Docker, NSSM, or Supervisor. Backup Postgres; update env vars; add health checks; integration testing. **Success:** all services running; print jobs work; data verified; secrets secure.

### Phase 3: Process Supervision & Hardening (1–2 weeks)
Configure service dependencies; implement health checks; test reboot/power-loss scenarios; graceful shutdown; monitoring. **Success:** reboot test passes; services auto-start correctly.

### Phase 4: Cutover & Validation (1 week)
Live migration during low-traffic window. Stop old system; start new; validate all functionality. Monitor 24 hours. **Success:** all services healthy; no functionality broken; no ghost tickets.

### Phase 5: Optimization & Decommission (1 week post-cutover)
After 1 week stable operation, optimize config; decommission old infrastructure; update DEPLOYMENT.md; complete operator training.

---

## Research Convergences

**All researchers agree:**
- Remove Rancher as Phase 1 immediate proof
- Process isolation is key improvement (eliminates cascade-failure blast radius)
- Eventlet single-worker is non-negotiable constraint
- Podman on Windows: REJECT (print-agent networking showstopper)
- Rust rewrite: REJECT (massive scope, unproven ROI)
- Electron: REJECT (Postgres bundling unsolved)
- Postgres backup is critical before migration

---

## Confidence Assessment

| Area | Confidence | Reasoning |
|------|-----------|-----------|
| **Stack** | **HIGH** | 8 alternatives researched with documented footprints, versions, timelines |
| **Features** | **HIGH** | Table-stakes/differentiators mapped clearly; validated against codebase constraints |
| **Architecture** | **MEDIUM-HIGH** | 6 hosting architectures evaluated; Podman networking problem well-documented |
| **Pitfalls** | **HIGH** | 8 critical pitfalls rooted in production issues and codebase analysis |

**Overall confidence: HIGH**

---

## Gaps to Address During Execution

1. **WSL2 edge-case integration** — If choosing WSL2, test on target Windows 11 machine
2. **NSSM startup order dependencies** — If choosing NSSM, verify Postgres fully initializes before backend
3. **Print-agent localhost reachability** — All non-Docker paths require PRINT_AGENT_URL update
4. **Ghost-ticket root cause** — Root-cause analysis of transaction boundaries needed
5. **Secrets rotation procedure** — Design atomic rotation process for JWT/DB secrets
6. **PostgreSQL Windows service validation** — Verify PostgreSQL 15 already installed as Windows service

---

## Sources

- **STACK.md** — 8 hosting alternatives with resource profiles, versions, migration effort
- **FEATURES.md** — Feature matrix mapping table-stakes and differentiators
- **ARCHITECTURE.md** — Integration paths with component changes per option
- **PITFALLS.md** — 8 critical pitfalls rooted in production issues and codebase analysis

---

*Research completed: 2026-08-08*  
*Overall confidence: HIGH*  
*Ready for roadmap creation: YES*
