# Dependencies and Gaps

Source: `API_CAPABILITY_MATRIX.md` §12 (G1-G26), `BUSINESS_RULES.md`, `REPOSITORY_AUDIT.md` §4/§12, `PROJECT_STATE.md` (B1-B4). Owners are roles, not people: **PM**, **BE** (backend extension WS), **MOB** (mobile WS), **OPS** (bar owner/venue), **ORCH** (orchestrator).

Classes: **Blocker** = P0 cannot ship safely unless resolved; **Handled-by-extension** = B1-B4 fix; **Mitigated-in-app** = mobile copes; **Accept-and-document** = no mobile impact in v1 or risk accepted.

## 1. Gaps G1-G26

| Gap | Summary | Class | Mobile impact | Resolution | Owner |
|---|---|---|---|---|---|
| G1 | Sockets unauthenticated, public rooms joinable | Accept-and-document | Any LAN device can listen to floor/kitchen/bar events (no PII beyond table codes/names) | LAN-only; document; revisit if exposed beyond LAN | ORCH |
| G2 | `manager` room never joined | Handled-by-extension (B4) | Only affects `print:failed`; not P0. Mobile P0 uses `floor`/`kitchen`/`bar` rooms | B4; mobile does not depend on it in v1 | BE |
| G3 | Refresh survives logout; deactivated user's token valid <=8h | Mitigated-in-app | Lost phone stays authorised | App wipes tokens on logout; document; no server fix in v1 | MOB |
| G4 | Reprint authorised by manager UUID only | Accept-and-document | Reprint not in v1 scope | Don't call `/reprint` | PM |
| G5 | Queue PATCH ungated, no transition check, can revive VOIDED | Handled-by-extension (B3 partial) + Mitigated-in-app | Role/order enforcement is UX-only; B3 stops VOIDED revival | B3 + client-ordered transitions (F-K-04) + client filters VOIDED | BE, MOB |
| G6 | Print endpoints ungated | Accept-and-document | P1 pre-bill/P2 reprint callable by any role | UX gating only | PM |
| G7 | close / request-payment need no manager | Mitigated-in-app | Anyone can close; D4 removes close from the app; request-payment kept with confirm | D4 + confirm dialog | PM |
| G8 | Timer edit on CLOSED tickets | Accept-and-document | Not in app | none | - |
| G9 | edit-payment amounts unvalidated | Accept-and-document | Not in app | none | - |
| G10 | Reopen CANCELLED | Accept-and-document | Not in app | none | - |
| G11 | request-payment frees pool table while ticket OPEN | Mitigated-in-app | Floor shows AVAILABLE with pending ticket; another waiter could open "same" table | Confirm dialog; floor merges `pending-payment` to show chip; open question for design | PM, MOB |
| G12 | Void doesn't notify kitchen | Mitigated-in-app | KDS may show voided food | 15 s poll on KDS; warning in void UX (P1) | MOB |
| G13 | No idempotency (items POST double-applies) | **Blocker** until B1 deployed; Handled-by-extension (B1) | Duplicate orders on retry | B1 + per-line UUID + never auto-resend ambiguous lines when B1 absent; Send locked in flight | BE, MOB |
| G14 | Cost/cash summaries readable by all roles | Accept-and-document | App must not call `/cash/current/summary`, `/inventory` (cost) for non-managers | Don't surface; document | PM |
| G15 | User role unvalidated, dup username -> 500 | Accept-and-document | User CRUD out of scope; unknown role -> DENIED screen | none | MOB |
| G16 | `waiting_list:update` name mismatch | Mitigated-in-app | Waiting list P1 | Listen to `waiting:update` only | MOB |
| G17 | Inconsistent / HTML errors | Mitigated-in-app | Parsing crashes | F-X-10 normaliser + unit tests with each error shape | MOB |
| G18 | No pagination (caps 100/50/30) | Accept-and-document | `GET /tickets` capped 100; P0 uses `open-all`/`resources` | none | - |
| G19 | Mixed cents/pesos | Accept-and-document | Only `charts-data` uses pesos; out of scope | Treat all money as integer cents | MOB |
| G20 | Empty socket payloads | Handled-by-extension (B2, partial) | Ready notifications need payload data | B2 for item events; other events remain refetch signals | BE |
| G21 | BUNDLE promo has no apply branch | Accept-and-document | Totals are server-side | none | - |
| G22 | VOID enum comment drift | Accept-and-document | Ticket statuses used: OPEN/CLOSED/CANCELLED only | none | - |
| G23 | `/inventory/open-boxes` docstring-only | Accept-and-document | Not used | none | - |
| G24 | `send-order` dead (always 400) | Mitigated-in-app | No server staging | D5 local draft; never call it | MOB |
| G25 | Role claim stale until refresh | Mitigated-in-app | Demoted user keeps UI role <=8h | Re-read role on refresh and cold start (`/auth/me`) | MOB |
| G26 | Commented-out legacy code | Accept-and-document | none | none | - |

## 2. Additional gaps found (not in G1-G26)

| ID | Gap | Class | Mobile impact | Resolution | Owner |
|---|---|---|---|---|---|
| N1 | Rate limits keyed by `remote_addr`; no ProxyFix, so all phones share nginx's address: login 10/min and verify-pin 5/min across the entire venue (REPOSITORY_AUDIT §4) | **Blocker (operational)** for shift-start logins; UNVERIFIED at runtime | 6 waiters logging in in one minute plus retries can hit 429 | Verify against docker backend (contract test with concurrent logins). Proposed B5 (ProxyFix / `X-Forwarded-For`) or raise limits. Mobile: handle 429 with countdown. | BE, ORCH |
| N2 | `payment_requested` not on `GET /resources` | Mitigated-in-app | Floor chip needs second call | Merge `pending-payment`; optional extension to add field | MOB |
| N3 | Modifier min/max not server-enforced (BR §E.63) | Mitigated-in-app | Staff could bypass | Client enforcement (F-W-06) | MOB |
| N4 | Modifier prices possibly not multiplied by quantity (BR §E.65, UNVERIFIED) | Accept-and-document | Draft price estimate may differ | Show server total after send; verify via contract test | MOB |
| N5 | Default credentials in compose/README | Accept-and-document | Deployment risk, not app | OPS to rotate before field use | OPS |
| N6 | Pool default rate inconsistent (UNKNOWN) | Accept-and-document | Timer estimate only; server authoritative | read live DB | OPS |

## 3. External dependencies

| ID | Dependency | Why it matters | Status | Risk | Owner | Resolution plan |
|---|---|---|---|---|---|---|
| E1 | Bar machine access (real data, real LAN) | Final validation of idempotency, rate limits, menu volume | Not available | Behaviour differs from docker substitute | OPS | Develop/test on local docker `billarmobile` :8090 (D12); schedule a supervised on-site pilot before GA |
| E2 | Wi-Fi AP client isolation | Phones can't reach POS host | Unknown | **Top threat to every P0 story** | OPS | Disable "AP/client isolation", put phones and POS on same VLAN; test with `GET /health` from phone |
| E3 | Windows firewall / port 8080 reachability; static or reserved IP for POS host (`pos-network-setup.ps1`, `set_ip.ps1` exist) | URL stored on phone breaks if IP changes | Unknown | High | OPS | Allow inbound 8080 on private profile; DHCP reservation; the app supports changing URL (US-X-02) |
| E4 | Print agent (:9191 on host) | Pre-bill print (P1), chits | Not available locally | P1 only; P0 unaffected | OPS | Out of v1 P0; mock/skip; 503 handled |
| E5 | Backend extensions B1-B4 deployed on the bar machine | B1 duplicate safety, B2 ready notifications, B3 void guard | Planned, worktree only | **High:** app must feature-detect and degrade (PROJECT_STATE) | BE, ORCH | BE WS builds + tests; deployment through existing `scripts/update` after review; app ships with feature-detection |
| E6 | Real devices (Android phones, varied sizes) | Emulator `billar_mobile_api35` only | Partial | Medium | MOB | Install debug APK on 1-2 staff phones for pilot; min Android version TBD by Architect |
| E7 | Mac for iOS | iOS build | Not available | None for v1 | ORCH | Keep code platform-neutral (D1); defer |
| E8 | Cleartext HTTP on Android 9+ | LAN `http://` blocked by default | Known | Medium: login fails silently | MOB | `usesCleartextTraffic` / network security config for LAN; document in architecture |
| E9 | Staff devices: battery/background | Android kills the socket when backgrounded | Known | Medium | MOB | Foreground refetch (US-X-10); no push in v1 (out of scope) |
| E10 | Real menu/modifier data quality (routing default BAR, G-unvalidated; missing categories) | Wrong station routing | Unknown | Medium | OPS | Review `GET /menu/categories` `routing` on bar machine before pilot |

## 4. Top threats to P0

1. **G13 / E5:** if B1 isn't deployed, Send retry can duplicate orders; mitigated by locked button + no auto-resend, but not eliminated.
2. **E2/E3:** LAN reachability decides whether anything works.
3. **N1 + E5 (B2):** shared rate-limit bucket at shift start; without B2 ready notifications are chattier and less precise.
