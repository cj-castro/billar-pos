# Bar Machine Requirements (Mobile Companion)

Status: **handoff checklist. Every item is `pending bar-machine access`.** Nothing here has been executed. Commands marked **ADMIN** must be run by a Windows administrator on the bar POS host. Commands marked **NOT EXECUTED** are examples for the operator and were not run from the worktree.

Scope: what must be true on the bar Windows machine (and its router/AP) so that staff phones can reach the POS, the backend extensions B1-B4 are deployed, and the POS keeps working. Sources: `PROJECT_STATE.md`, `NETWORKING_AND_SYNC.md` section 11, `INTEGRATION_STRATEGY.md` section 5, `SECURITY_MODEL.md`, `DEPENDENCIES_AND_GAPS.md` E2/E3/E5, and the repo scripts named below.

---

## 1. Network path (phones -> POS)

| # | Requirement | Status | Verify |
|---|---|---|---|
| N1 | Compose stack running. Only nginx is published: `${FRONTEND_PORT:-8080}:80`. Backend (5000) and Postgres are **not** published and must stay that way. | pending bar-machine access | `docker compose ps` shows `frontend` on `0.0.0.0:8080->80` |
| N2 | POS host has a **DHCP reservation** on the router (preferred) or a static IP. Record the IP and the NIC MAC. | pending bar-machine access | `Get-NetIPConfiguration` and router lease table |
| N3 | Windows Firewall inbound allow for TCP 8080 on the **Private** profile. The active Wi-Fi/Ethernet profile must be Private. | pending bar-machine access | See section 2 |
| N4 | Router/AP: **AP or client isolation OFF** on the staff SSID. Phones must reach the POS host IP directly. | pending bar-machine access | Phone browser test, section 3 |
| N5 | Staff phones on the SSID/VLAN that includes the POS host. No guest SSID. | pending bar-machine access | Same as N4 |
| N6 | Private DNS / VPN apps disabled on staff phones (they break LAN reachability). | pending bar-machine access | Phone checklist |
| N7 | Wi-Fi coverage at every table and at the KDS position. Test with a phone at the farthest table. Prefer 5 GHz for coverage at the bar, 2.4 GHz is acceptable only if 5 GHz does not reach. | pending bar-machine access | Walk test; note RSSI in the validation results |
| N8 | Android "no internet" handling: staff phones keep the "stay connected" choice on the bar SSID, or mobile data is off on staff phones. The app does **not** need internet, but Android may route to mobile data if it thinks Wi-Fi is "no internet". | pending bar-machine access | Wi-Fi without internet test, `REAL_BACKEND_VALIDATION.md` T-18 |
| N9 | Do **not** use the `ngrok` option offered by `scripts/set_ip.ps1` (section 4). It would expose the POS API and unauthenticated socket rooms (gap G1) to the internet. | pending bar-machine access | Policy |

Acceptance for the network: `http://<pos-ip>:8080/api/v1/health` returns `{"status":"ok"...}` from a phone browser on the staff SSID.

## 2. Windows Firewall (ADMIN, NOT EXECUTED)

Existing state: `scripts/pos-network-setup.ps1` adds `netsh` rules named `BilliardBarPOS-App` (8080) and `BilliardBarPrintAgent` (9191) without a `profile=` argument. Check them first, do not blindly duplicate.

Check (read-only, safe):

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory
Get-NetFirewallRule -Direction Inbound -Action Allow |
  Where-Object { $_.DisplayName -like 'BilliardBarPOS*' -or $_.DisplayName -like 'Bola8*' } |
  Get-NetFirewallPortFilter | Select-Object InstanceID, Protocol, LocalPort
```

Rule to add only if no existing inbound TCP 8080 rule covers the Private profile (**ADMIN, NOT EXECUTED**):

```powershell
New-NetFirewallRule -DisplayName "Bola8 POS nginx 8080 (Private)" `
  -Name "Bola8-POS-8080-In-Private" `
  -Direction Inbound -Protocol TCP -LocalPort 8080 `
  -Action Allow -Profile Private
```

If the Wi-Fi profile is Public, set it to Private (**ADMIN, NOT EXECUTED**). Only do this on a network the owner controls:

```powershell
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
```

Do **not** open 5432 or 5000. Do not change the 9191 print-agent rule (section 7).

## 3. Reachability test (from a staff phone browser)

| Step | Expected |
|---|---|
| Open `http://<pos-ip>:8080/api/v1/health` on the staff SSID | JSON with `"status":"ok"` |
| Same URL on the **guest** SSID | Fails. Expected. Confirms isolation between SSIDs |
| Same URL with the POS host Wi-Fi off, phone on mobile data | Fails. Expected |

If the first step fails: check N3 (firewall profile), N4 (isolation), and that the POS PC is on the same subnet as the phone (`Test-Connection <pos-ip>` from a laptop on the same SSID).

## 4. Static IP (scripts, NOT RUN)

| Option | Script | Notes |
|---|---|---|
| A (recommended) | Router DHCP reservation | Use the MAC printed by `pos-network-setup.ps1` section 4 |
| B | `scripts/set_ip.ps1` (ADMIN) | Sets a static IP on the adapter. Run it only after reading the script. It is interactive and has a dry-run prompt. **Its final menu offers an ngrok tunnel or port forwarding. Decline both (N9).** |

After any IP change the staff phones must change the server URL (Cambiar servidor in the app). This is the most likely cause of a permanent outage (`NETWORKING_AND_SYNC.md` section 1 step 7).

## 5. Backend extensions B1-B4 deployment

Source: `BACKEND_EXTENSIONS.md`. Changes: migration `002_line_item_client_request_id.sql` (adds `ticket_line_items.client_request_id VARCHAR(64)` and partial unique index `uq_tli_ticket_client_request`), plus code for B1 (`tickets.py` add_item), B2 (`queue.py` payloads), B3 (`queue.py` 409 `ITEM_VOIDED`), B4 (`sockets/events.py` manager join).

Deploy path (describe; do not run from this worktree):

1. Get the commit containing B1-B4 onto the bar machine's checkout through the normal review and merge. The branch `feature/mobile-pos-companion` is local-only and must not be pushed by agents (project rule). Owner decides how it reaches the bar.
2. On the bar machine run the repo's update path: `scripts/update.sh` (or the Windows equivalent used on site). It performs, in order: backup (`scripts/backup.sh`), `git pull --ff-only`, `docker compose build`, `docker compose up -d --remove-orphans`, and a health wait on `http://localhost:8080/api/v1/health`.
3. Migrations run automatically at backend container start. `backend/entrypoint.sh` runs `flask init-db`, `python seed.py`, `flask factory-finalize`, `flask apply-migrations` in that order.

Gotchas for step 3:

| Gotcha | Mitigation |
|---|---|
| `flask apply-migrations` **exits 0 even when a migration fails** (comment in `entrypoint.sh`) | Check the log, not the exit code (below) |
| `scripts/update.sh` health check hard-codes `localhost:8080`. If `FRONTEND_PORT` is changed in `.env`, the health wait fails even though the stack is fine | Keep `FRONTEND_PORT=8080` or edit the check first |
| `update.sh` runs `git pull --ff-only`. A dirty tree or diverged branch only prints a warning and deploys the **current** code | Confirm `git status` and `git log -1` before the update |
| `seed.py` returns early once any user exists. Changing `ADMIN_PIN`, `MANAGER_PIN` or passwords in `.env` after the first boot does **not** change existing accounts | Set PINs/passwords through the app or DB before the pilot, see section 8 |

Post-deploy verification (ADMIN or operator on the bar host):

```bash
docker compose logs backend | grep -iE 'Migrations:|002 OK|failed'   # expect "1 applied" or "1 already present", 0 failed
docker compose exec backend flask migration-status                    # 002 listed as applied
docker compose exec postgres psql -U billiard -d billiardbar -c '\d ticket_line_items'
# expect client_request_id character varying(64) and index uq_tli_ticket_client_request
curl -s http://localhost:8080/api/v1/health                           # expect status ok; api_features only after proposal P2
```

Feature detection the app relies on: `ticket_version` in the add-item response means B1 is live. Without it the app does not auto-retry sends (`NETWORKING_AND_SYNC.md` section 3).

Back-compat check (required by `INTEGRATION_STRATEGY.md` section 5): after deploy, log into the **web** POS, open a ticket, add an item, check the KDS and the print. The web app must behave as before.

## 6. Backup before migration

| Item | Detail |
|---|---|
| Automatic | `scripts/update.sh` calls `scripts/backup.sh` unless `SKIP_BACKUP=1`. Do not set `SKIP_BACKUP` for the B1-B4 deploy. |
| Output | `./backups/billiardbar_<timestamp>.sql.gz`, container resolved via `docker compose ps -q postgres`, 7 days retained |
| Manual backup | `./scripts/backup.sh` (bash, on the host with Docker) |
| Windows variant | `scripts/backup-pos.ps1` has a **hard-coded** path (`C:\Users\bola8lacalma\Desktop\POS\billiards`) and container name (`billiards-postgres-1`). Edit before use or use `backup.sh` through WSL. |
| Restore (verify on a copy first, NOT EXECUTED) | `gunzip -c backups/billiardbar_<ts>.sql.gz \| docker compose exec -T postgres psql -U billiard -d billiardbar`. The dump is plain SQL without `--clean`, so restore into an empty database or drop and recreate first. |
| Rollback order | Roll back the **backend image** first, then the SQL (`BACKEND_EXTENSIONS.md` rollback block). Older code never reads the new column. |

## 7. Print agent (unchanged)

| Item | Detail |
|---|---|
| Port | 9191 on the host (`scripts/print_agent/print_agent.py`, `PRINT_PORT` default 9191) |
| Backend reference | `PRINT_AGENT_URL=http://host.docker.internal:9191` (docker-compose) |
| Firewall rule | `BilliardBarPrintAgent` from `pos-network-setup.ps1`. Leave as is. |
| Mobile impact | None in v1. Pre-bill print and reprint are out of scope (`DEPENDENCIES_AND_GAPS.md` E4). Kitchen chits print from the backend per item, so the print agent **must** be up for the kitchen to receive chits. |
| Check | `http://<pos-ip>:9191/health` from a laptop on the LAN. Not from the phone (not required). |

## 8. Accounts, PINs and secrets

| Item | Requirement | Status |
|---|---|---|
| Personal logins | One user per staff member. No shared logins (audit trail depends on it, `SECURITY_MODEL.md` section 7). | pending bar-machine access |
| Roles | WAITER, KITCHEN_STAFF, BAR_STAFF, MANAGER, ADMIN. KDS tablets get their own dedicated KITCHEN_STAFF or BAR_STAFF account. | pending bar-machine access |
| Seed credentials | Replace `admin123`, `manager123`, `waiter123`, `kitchen123`, `bar123` (compose defaults). Set via `.env` **before first boot**, or change through the app/DB afterwards. | pending bar-machine access |
| Manager/admin PINs | Compose defaults are `ADMIN_PIN=1234`, `MANAGER_PIN=5678`. Replace them. Because `seed.py` skips existing users, set them through the app or DB on an already-seeded system. | pending bar-machine access |
| Secrets | `SECRET_KEY` and `JWT_REFRESH_SECRET` default to `dev-*` values in compose. Set real values in `.env`. Changing them logs everyone out. Do it before the pilot. | pending bar-machine access |
| Deactivation | When staff leave, deactivate the user. Refresh tokens survive logout for up to 7 days (gap G3) and deactivation is the only server-side cut-off until proposal P3. | pending bar-machine access |
| Cash session | Open the cash session (`/cash/status` open) before the shift. Otherwise ticket creation returns 403 `BAR_CLOSED`. | pending bar-machine access |
| WPA password | Staff SSID password rotated when staff leave (`SECURITY_MODEL.md` section 3 step 0) | pending bar-machine access |

## 9. Rate limits (known constraint)

| Endpoint | Limit (code) | Where |
|---|---|---|
| `POST /auth/login` | 10 per minute | `backend/app/api/auth.py` |
| `POST /auth/verify-pin` | 5 per minute | `backend/app/api/auth.py` |
| `edit-payment` (manager, PIN-gated) | 5 per minute | `backend/app/api/tickets.py` |

- Key function: `get_remote_address` (`backend/app/extensions.py`). There is **no ProxyFix**, so behind nginx every phone and the web UI share one bucket keyed on the nginx container's address.
- Effect: a shift start with six waiters logging in can hit 429.
- Limits are in-memory, so a backend restart resets them.
- Mobile behaviour: 429 shows a countdown and never auto-retries (`NETWORKING_AND_SYNC.md` section 4).
- **Recommendation, not implemented here:** add `ProxyFix(x_for=1)` in `create_app` (proposal P1 / B5), which nginx's `X-Forwarded-For` already supports, then re-check limits. Until then: stagger logins at shift start, and do not loop `verify-pin` during tests.
- The void endpoint limit was not confirmed in this review (the grep found decorators on login, verify-pin and edit-payment only). Confirm before relying on it.

## 10. Time sync and clock

| Item | Requirement | Verify |
|---|---|---|
| Windows time sync | Enabled and working. KDS age colours (US-K-02) and the "Estimado" pool timer use `sent_at` and server time. Skew over 2 minutes against the phone breaks the colours. | `w32tm /query /status` (read-only); ADMIN: `w32tm /resync` |
| Timezone | Windows timezone matches compose `TZ=America/Mexico_City` default, or `.env` override | `tzutil /g` and compare with the business day |
| Phones | Automatic date and time on | Phone settings checklist |

## 11. Host availability

| Item | Requirement |
|---|---|
| Sleep | POS PC never sleeps during service (power plan), and Docker Desktop starts with Windows |
| Autostart | Repo scripts are stale for this host (see section 12). Set autostart up for the actual path on site, or use Docker's restart policy (`restart: unless-stopped` is already set in compose). |
| UPS | Recommended. A power cut mid-send is covered by the idempotency design only once B1 is live. |

## 12. Known script drift (check before running any script on site)

| Script | Problem | Action |
|---|---|---|
| `scripts/start-pos.ps1` | Hard-coded `C:\Users\bola8lacalma\Desktop\POS\billiards` and `docker compose up -d` (no project name) | Edit path or use `update.sh`-equivalent |
| `scripts/backup-pos.ps1` | Hard-coded path and container `billiards-postgres-1`. Compose names containers `<project>-postgres-1`, and the project name follows the folder (`billar-pos` in the main repo) | Run `docker compose ps` first and edit |
| `scripts/install-autostart.ps1` (contents are the WSL-based `setup-windows` task) | Points to WSL distro `Ubuntu` and `/opt/billiards`. Not for a native Docker Desktop host. | Do not run without review |
| `scripts/update.sh` health check | Hard-coded `localhost:8080` | See section 5 |
| `scripts/pos-network-setup.ps1` | Opens 8080 and 9191 without a `profile=` argument. Interactive prompts (`Read-Host`). | Run by the owner, not by an agent |
| `scripts/set_ip.ps1` | Interactive; ngrok option (N9) | Decline ngrok |

Container name check (read-only): `docker compose ps --format "{{.Name}}"`. Compose project name check: `docker compose ls`.

## 13. Sign-off list before the pilot

- [ ] N1-N9 verified and recorded in `REAL_BACKEND_VALIDATION.md` results table
- [ ] Backup taken, restore procedure rehearsed on a copy
- [ ] B1-B4 deployed, migration log checked, web back-compat smoke passed
- [ ] Seed passwords, PINs and secrets rotated; staff accounts created
- [ ] Cash session open during the pilot
- [ ] Print agent up; one kitchen chit printed
- [ ] Owner has approved the HTTPS roadmap date (`SECURITY_MODEL.md` section 3) or accepted the cleartext residual in writing

## Related

- `docs/mobile/integration/BACKEND_EXTENSIONS.md`
- `docs/mobile/architecture/NETWORKING_AND_SYNC.md`
- `docs/mobile/architecture/SECURITY_MODEL.md`
- `docs/mobile/integration/REAL_BACKEND_VALIDATION.md` (next step once this is done)
