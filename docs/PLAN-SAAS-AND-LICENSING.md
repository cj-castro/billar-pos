# Plan: selling the POS to other pool halls — cloud, licensing, code protection

**Status:** draft for discussion, 2026-11-26. No code yet.
**Owner:** CJ. Bola 8 is customer #1, not the spec.
**Builds on:** `docs/PLAN-SAAS-AWS-MIGRATION.md` (August, all bars in one cloud
system) and `docs/POSPackaging_n_DistributionPlan.md` (per-bar Windows install,
license file, code protection). This document chooses between them and orders
the work.

---

## 1. Goal

- Sell the POS to other pool halls as a monthly subscription.
- Control who may use it (licensing) and stop copies running without paying.
- Let the sales team show a live demo now.
- Keep Bola 8 running without interruption during all of it.

**Not goals (for now):** a public sign-up website, many bars under one owner
login, an offline-capable cloud POS.

**Failure even if it works:** a bar loses sales on a Friday night because of
our licensing, our cloud, or an update.

**Still open:** what is driving this now — bars waiting to buy, monthly income,
or less deploy pain. The answer can change the order in section 7.

---

## 2. Where the code stands today (2026-11-26)

| Area | Today | Matters because |
|---|---|---|
| Tenancy | One bar per install. 33 tables, no "which bar" column. Settings, venue name, closing hour are global. | Option A needs all of this changed. B and C do not. |
| Live updates | Socket.IO and the login rate limit live in one process's memory. | One server per bar is fine; a shared cloud system needs Redis. |
| Scheduler, Telegram bot | Each serves one bar. | Same as above. |
| Printing | Receipts print from the browser, not the server. | A cloud server can still print at the bar. Not a blocker. |
| Internet | Bola 8 runs on its own PC and works with no internet. | Any cloud-hosted POS stops when the bar's internet stops. |
| What ships to a bar | The whole repository as a zip; the bar's PC builds the images itself. | Every `.py`, `.tsx`, test, runbook and plan is on the bar's PC. |
| Secrets | `docker-compose.yml` falls back to public defaults (`dev-secret-key-change-in-production`, `admin123`, `manager123`) when `.env` lacks them. The repo is on GitHub. | Any install without its own `.env` values can be logged into or have sessions forged. |
| SQL logic | 70 SQL functions (costing, ledger, business day) live in the database. | They can be read by anyone with database access; they cannot be compiled. |
| Backups | Girish's `backup` service: nightly `pg_dump` to S3. | Ready to become a cloud service per bar. |

---

## 3. The three ways to run it

### A. One shared cloud system for all bars

Every bar logs into the same servers. Each row carries a "which bar" tag.

**For:**
- One deploy updates every bar at once. No USB bundles.
- Cheapest per bar once there are many bars.
- All data in one place: comparisons across bars, one login for owners of several bars.
- A new bar can sign up and start the same day, nothing to install.
- Licensing is a switch in the cloud — no license files.

**Against:**
- Largest rebuild: every table, query, screen, socket room, scheduler job, bot command and report must filter by bar. Estimate 6–10 weeks before a second bar is safe.
- One missed filter shows one bar's sales to another. Permanent tests needed for every future feature.
- No internet at the bar = no tickets, timers or checkout. Offline mode later is another large project.
- One outage stops every bar at once.
- Fixed hosting cost from day one (August plan: ~$270/month staging, ~$1,750/month high-availability production).
- Bola 8's data must be migrated into the shared system.

**Verdict:** right end state at dozens of bars; wrong first step with one customer.

### B. Each bar runs locally, controlled from our cloud (hybrid)

The POS stays on the bar's PC, as at Bola 8. Our cloud runs: licenses,
billing, customer portal, updates, off-site backups, health monitoring, and
later the owner's phone reports.

**For:** works with no internet; the POS code barely changes; ships soonest.
**Against:** each bar needs a Windows PC with Docker; many machines to support;
the code sits on hardware we do not control (section 5).

### C. One private cloud copy per bar

Same POS, but each bar gets its own small server and database in the cloud,
created automatically.

**For:** no core rebuild; each bar's data is fully separate; suits bars without a PC.
**Against:** ~$15–30 per bar per month hosting; needs internet.

### Recommendation

**B first, C offered to bars that do not want a PC, A only at scale.**
B and C share the same cloud side (licensing, billing, portal, updates,
backups), so nothing built for B is thrown away. Move to A only when the number
of bars makes per-bar hosting cost hurt.

**Decision: open.** CJ to choose A, B, C, or B-then-C.

---

## 4. Phase 0 — Sales demo on AWS (any option)

The current POS can run as-is on one small cloud server for demos. No
multi-bar work needed.

**Shape:** one Lightsail or EC2 instance (~$15–25/month) running the same
`docker-compose.yml`, plus a domain name.

**Must have before salespeople get the link:**

1. **Real secrets** in `.env`: `SECRET_KEY`, `JWT_REFRESH_SECRET`,
   `POSTGRES_PASSWORD`, and every seed user password. Never the defaults.
2. **HTTPS only.** A small web server (e.g. Caddy with a free certificate) in
   front; only port 443 open to the world; SSH limited to CJ's IP.
3. **Fake data, never Bola 8's database.** A made-up venue ("Billar Demo"), a
   full demo menu (bottles, shots, food, pool tables), demo staff, and several
   weeks of fake sales so the reports look real. `seed.py` today has 17 menu
   items and no sales — not enough.
4. **Nightly reset** to the clean demo state.
5. **No outside messages:** `SCHEDULED_REPORTS=off`, no Telegram bot, no S3
   backup service, no real email addresses.
6. **One shared demo** at first — every salesperson sees the others' clicks. A
   copy per salesperson is the first step of option C.

**Carries over:** the demo data set and the "create a fresh copy" steps are
reused by B (first-install data) and C (new bar setup).

**Who does what:** CJ creates the AWS account and server and runs the deploy.
Claude writes the files and the runbook.

---

## 5. Licensing and code protection (option B; mostly reused by C)

**Honest limit:** on a PC the bar owns, code cannot be made impossible to copy.
The aim is: copying is expensive, a copied install stops working, and the
valuable parts depend on our cloud.

### The locks, in order

| # | Lock | Stops | Effort |
|---|---|---|---|
| 1 | **Ship built images, not source.** Build in GitHub Actions, push to a private registry (AWS ECR). The bar's `docker-compose.yml` names images only — no `build:`, no source folder. | Casual copying; "IT guy zips the folder". Also ends USB bundles: an update becomes pull and restart. | ~1 week |
| 2 | **License check in the backend** (details below). | Unpaid use; copying an install to a second bar. | ~1–2 weeks |
| 3 | **Tie the database to the machine.** First activation stores the machine fingerprint in the database; a copied database on another PC refuses to start. | Copying the data folder to another bar. | a few days |
| 4 | **Compile the Python.** Cython for business logic (pricing, costs, licensing), PyArmor for the Flask glue. No `.py` files in the image. | Reading or editing the code, and deleting the license check. | ~2–3 weeks; all tests must run against the compiled build |
| 5 | **Valuable services live in our cloud** and need a valid license: updates, off-site backups, owner phone reports, purchase forecast email, Telegram bot, later Rappi. | The real reason to keep paying: a pirated copy freezes and gets nothing new. | grows over time |
| 6 | **Contract and watermark.** License agreement; each bar's build carries a hidden ID. | Legal action if a copy appears elsewhere. | small |

**First month:** locks 1, 2, 3, 5. **Later:** lock 4, once there is a second
paying bar — it slows every build and test.

**Cannot be locked:** the owner is administrator on their PC; the 70 SQL
functions are readable in the database; the frontend can be obfuscated, not
hidden. This is why lock 5 matters most.

### The license

- **Contents**, signed with our private key (Ed25519): bar ID, plan, features,
  machine fingerprint, number of terminals, issued date, expiry date.
- **The public key is built into the backend** (compiled once lock 4 exists),
  not in a config file.
- **Checked** at backend start and once a day, from the stored file. No
  internet needed for the check.
- **Expiry behaviour:** banner 14 days before; after expiry a 14-day grace
  period; then **read-only** — open tickets can be finished and paid, no new
  tickets. **Never stops mid-shift.**
- **Activation:** online by a code, or offline by an emailed request file and
  an emailed license file (many bars have weak internet).
- **Renewal:** a new license file with a later expiry, pushed by the daily
  check-in or emailed. No reinstall.
- **Daily check-in** (when internet exists): license ID, version, terminal
  count. Lets us see active installs. Failure only logs.

---

## 6. Our cloud side (shared by B and C)

| Part | Does | Notes |
|---|---|---|
| License server | Issues, renews, revokes licenses; receives check-ins. | Small service; can start on the demo server. |
| Customer portal | Owner sees plan, invoices, license, update status. | Later: phone reports. |
| Billing | Monthly subscription in MXN. | **Open:** Mexican bars will want a CFDI invoice. Choose Stripe, Mercado Pago, or Stripe plus an invoicing service. |
| Image registry | Holds built images per version (AWS ECR). | Access per license. |
| Update channel | "Update available — apply tonight" in the owner's screen; backup first; automatic rollback if the health check fails. | Never auto-applied during opening hours. |
| Off-site backups | Girish's S3 backup service, one folder per bar. | Needs per-bar credentials issued by us, not typed by the owner. |
| Health monitoring | Last check-in, version, disk, last backup per bar. | Alerts to CJ. |

---

## 7. Order of work (proposed)

| Step | What | Rough time |
|---|---|---|
| 0 | Demo server on AWS with fake data (section 4) | 1 week |
| 1 | Secret hygiene: remove every public default from `docker-compose.yml`; each install generates its own | 2–3 days |
| 2 | Lock 1: built images in a private registry; Bola 8 moves to "pull and restart" updates | 1 week |
| 3 | Locks 2 and 3: license file, check, grace and read-only behaviour, machine tie | 2 weeks |
| 4 | License server + first version of the portal; billing provider chosen (CFDI) | 2–3 weeks |
| 5 | Installer for a new bar's PC (Docker, images, secrets, activation, first users) — see `POSPackaging_n_DistributionPlan.md` section 3 | 2 weeks |
| 6 | Second bar, friendly, on option B; Bola 8 on the same release channel | — |
| 7 | Lock 4 (compiled Python); option C for bars without a PC | later |
| 8 | Option A, only if the number of bars justifies it | later |

---

## 8. Decisions CJ needs to make

1. **A, B, C, or B-then-C** (section 3).
2. **Why now** — bars waiting, monthly income, or deploy pain (changes step order).
3. **Billing provider and CFDI invoicing.**
4. **Pricing** per bar per month (August plan suggested $29 / $79 USD tiers as a starting point).
5. **Demo data:** invented, or based on Bola 8's menu with fake prices and names.
6. **Who supports the bars** (calls, remote access) once there are more than two.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Licensing locks a bar during service | Read-only only after a 14-day grace period; never mid-shift; offline check from the stored file. |
| A bad update breaks a bar | Backup before every update; automatic rollback on failed health check; owner chooses when to apply. |
| Copied install at a second bar | Machine-tied license and database; cloud services refuse unknown installs. |
| Demo leaks real data | Demo uses invented data only; never a copy of Bola 8's database. |
| Public default secrets | Removed in step 1; installer generates per-install secrets. |
| Cloud cost before revenue | B and C cost little until bars pay; A deferred. |
| PC at the bar fails | Off-site backups to S3; restore runbook (`docs/RECOVERY.md`). |
