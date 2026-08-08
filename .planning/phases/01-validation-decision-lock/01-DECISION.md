# Phase 1 Decision: Hosting Replacement — Go/No-Go

**Date:** 2026-08-08
**Decision:** GO — proceed with native Windows Services (NSSM/WinSW) as the hosting replacement for Docker Desktop + Rancher Desktop on the bar's on-site Windows 11 (8GB RAM) machine.

## Basis for the decision

This decision is based on the existing hosting-alternatives research (`.planning/research/SUMMARY.md`, `.planning/research/STACK.md`), not on a fresh empirical measurement:

- Docker Desktop + Rancher Desktop currently consumes an estimated **3–4 GB idle RAM** on the 8GB bar machine, per prior research and known production behavior.
- Native Windows Services (NSSM/WinSW) is estimated at **<500 MB idle RAM** — full process isolation, no container runtime overhead.
- All 8 researched alternatives were ranked in `.planning/research/SUMMARY.md`; native Windows Services was selected over the alternatives (Docker Engine in WSL2, Supervisor, Podman, PM2, Rust rewrite, Electron) primarily to eliminate Docker/Rancher entirely and gain independent per-service crash isolation — see `.planning/research/SUMMARY.md` for the full comparison and rationale.

## What this decision explicitly does NOT include

- **No live RAM/CPU measurement was performed** on the bar machine, a spare/equivalent machine, or a VM. This is a documented judgment call by the project owner, made with direct operational knowledge of the current system, not a benchmarked result.
- No NSSM/WinSW service was installed or tested as part of reaching this decision.

## Requirements satisfied

- **HOST-01** (ranked comparison of 5+ hosting alternatives) — satisfied by `.planning/research/SUMMARY.md`, `STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md`.
- **HOST-02** (go/no-go decision recorded) — satisfied by this document. Note: ROADMAP.md's original wording for this criterion described a *measured* comparison; this criterion is instead satisfied by a documented decision based on existing research, per the project owner's explicit choice (see `01-CONTEXT.md` D-05).

## Next step

Phase 2 (Core Service Migration) proceeds on the basis of this decision.
