# Tailscale Embedding Research (Bola 8 Staff)

Status: research and recommendation, 2026-11-05. No app code changed. Not committed.

Convention: **[V]** = verified from a cited source (numbers in brackets point to Section 9). **[I]** = my inference or estimate, not verified. Dev-day estimates are all [I].

---

## 1. TL;DR

- **Feasible?** Technically yes, but only as a research-grade custom native build. On Android it needs a Go (tsnet/libtailscale) library, a hand-written Expo native module plus config plugin, and a proxy hook into RN's OkHttp. No maintained React Native or Expo module exists [V: 4, 5]. The only mobile wrappers I found are small community Flutter packages, and one says its Android tunnel is unfinished [V: 6].
- **Recommended now?** **No.** It does not address the diagnosed problem. Your own docs list four LAN causes (firewall profile, Public network profile, changing IP, client isolation) [V: repo, BAR_MACHINE_REQUIREMENTS.md N2-N4]. Three of those are cheap fixes on the bar PC/router. Embedding adds a permanent Go toolchain, a secret-distribution problem, and an internet dependency to solve a LAN problem.
- **The cheapest "Tailscale" answer already works with zero code.** `serverConfig.ts` already accepts `100.64.0.0/10` and `*.ts.net` URLs over http [V: repo, mobile/src/config/serverConfig.ts]. Staff can install the official Tailscale app and enter `http://bola8pos:8080` today. The question is whether that is acceptable UX, not whether it is possible.
- **When to revisit embedding:** only if (a) the network fixes are done and (b) staff still cannot or will not use the official Tailscale app, or you need phones off-site. Even then, first confirm the bar's AP is not blocking direct paths (Section 6).
- **Bottom line for this week:** diagnose with a data-driven in-app "why can't I connect" screen, run a one-time PC script that fixes firewall and profile, add a DHCP reservation, turn off client isolation, and add a QR on the POS that carries the current URL. Details in Section 8.

---

## 2. Options table

Effort in dev-days is [I] for one dev familiar with the repo, Android first, includes testing on 3+ real phones, excludes iOS unless stated.

| # | Approach | How | Effort | Platform | Offline-LAN (internet down) | Security | Cost |
|---|---|---|---|---|---|---|---|
| A | Fix the bar network (firewall rule, Private profile, DHCP reservation, isolation off) | Run commands already drafted in BAR_MACHINE_REQUIREMENTS.md sections 2 and 4, change AP setting | 0.5 to 1 day on site, 0 dev | All phones, all OS | Works. No internet needed | Same as today (cleartext http on LAN, SEC-03 policy) | $0, or ~$30-60 for a dedicated router [I] |
| B | In-app diagnostics: step-by-step check that names the failing layer | Extend existing `validateServer`/reachability probe; classify: no Wi-Fi, wrong subnet, host unreachable (timeout), port refused vs timeout, health bad | 2 to 4 days [I] | Android and iOS (pure JS plus NetInfo, already a dep) | Works | None added | $0 |
| C | QR on the POS screen carrying current URL | Backend/admin page renders a QR of `http://<ip>:8080`; app scans with expo-camera and calls existing `normalizeServerUrl`/`validateServer` | 2 to 3 days [I] | Android and iOS | Works | URL is not a secret | $0 |
| D | mDNS / DNS-SD discovery of the bar PC | RN zeroconf lib plus a service advertised from the PC (Bonjour/Avahi equivalent on Windows, or a tiny advertiser container) | 4 to 7 days [I] | Android NSD, iOS needs multicast entitlement [V: 7]. Libraries are small and of uncertain maintenance [V: 7] | Works, **but** multicast is exactly what client isolation blocks [I] | None added | $0 |
| E | Official Tailscale app on phones (PC runs Tailscale, phones join as tagged devices) | Staff install the Tailscale app; MDM or invite flow; use `bola8pos:8080` or MagicDNS `*.ts.net` (already allowed by the app) | 0 dev; 0.5 day admin setup per device batch [I] | Android and iOS | **Existing sessions survive; new logins and key refresh need internet** [V: 1, 2]. Same-LAN direct path may be blocked by isolation, then it relays over internet [I] | Strong: WireGuard, ACL to one host:port [V: 3] | Free tier likely enough (Section 5) |
| F | Embed tsnet/libtailscale in the app, userspace, local proxy | Go lib compiled to AAR (gomobile) or c-shared `.so`; Kotlin Expo module starts node, exposes 127.0.0.1 proxy; RN OkHttp routed through it | 25 to 45 days Android [I]; plus 15 to 25 days iOS [I]; then ongoing Go/toolchain upkeep | Android first; iOS possible in userspace [V: 6] but unproven for this stack | Same control-plane dependency as E, plus direct-path limits (Section 6) | Strong crypto, but needs an auth key delivered to each phone (Section 4) | Same plan limits as E; engineering cost dominates |
| G | Embed via Android VpnService (as the official app does) | Same Go core with a TUN fd, system VPN consent dialog | 30 to 50 days [I] | Android; iOS needs the Network Extension entitlement and a separate extension target [I] | Same as F | Strong | Same |
| H | Self-hosted Headscale control server | Run Headscale on the bar PC or a VPS | +5 to 10 days [I] on top of E/F | Works with official clients; Headscale targets a single tailnet [V: 8] | **Removes the internet dependency only if Headscale runs on the bar LAN**, but then phones still need to reach it; adds a server to run and secure [I] | You own the control plane | $0 software; ops burden |

Dev-days for F and G are the biggest uncertainty because upstream has no documented path for embedding in a third-party Android app (Section 3).

---

## 3. Embedding technical findings

### 3.1 What exists

- **tsnet**: a Go package that "lets you build Tailscale into your own application"; it uses a userspace TCP/IP stack; auth is via login URL or an auth key [V: 1]. It is a **Go** API only. The official docs say nothing about mobile [V: 1], and pkg.go.dev still labels tsnet experimental [V: 4].
- **libtailscale**: a BSD-3 C library that "embeds Tailscale into a process"; built with `go build -buildmode=c-archive` or `c-shared` [V: 9]. The README does not state stability, platforms, or Android/iOS support [V: 9]. The repo has `swift` and other binding folders [V: 9].
- **Official Android app**: BSD-3 with PATENTS file; Kotlin app built by Gradle with a `gomobile bind` step and a `libtailscale` directory; no documented guidance for third-party embedding or an SDK [V: 10]. The app's design is a VpnService (inferred from Android mechanics, not stated on the page) [I].
- **React Native / Expo**: I found **no** maintained module [V: 4]. Closest are community Flutter wrappers: `libtailscale` (Dart FFI, Android API 35+, iOS 15+) and `tsnet_flutter`, whose own changelog says Android tunnel support is not finished and that Go's interface enumeration needs `CAP_NET_ADMIN` on Android [V: 6, 4]. `leondgarse/tailscale_mobile` runs Tailscale in-process on Android with a local TCP proxy and no TUN, and documents SELinux blocking `/proc/net` for untrusted apps stalling the control client [V: 6]. This is evidence that the Android userspace route needs patching of Tailscale internals [I].

### 3.2 Userspace vs VpnService

| Aspect | Userspace (netstack + local proxy) | Android VpnService |
|---|---|---|
| Permission | None | System consent dialog; one prepared VPN app per user/profile [V: 11] |
| Coexistence with other VPN | Yes, it is not a VPN | Starting a VPN service stops the existing one [V: 11]. Staff with a personal VPN would lose it, or lose yours |
| App routing | App must opt in per connection (proxy) [V: 12] | Transparent for all apps (or an allowed-list of just our app via `addAllowedApplication`) [V: 11] |
| Foreground notification | Not required by the VPN rules, but background execution still needs care | Required, non-dismissible [V: 11] |
| Fit for "employees don't want to see Tailscale" | Best | Worst: key icon, consent dialog, notification |
| iOS | No Network Extension needed per tsnet_flutter [V: 6] (single source, unverified for our stack) | Needs Network Extension entitlement [I] |

Userspace is the only embedding variant that matches the product intent. Its cost is that every library in the app must be proxy-aware.

### 3.3 Routing axios and socket.io through a userspace proxy

- RN lets a native app swap the OkHttp client: `OkHttpClientProvider.setOkHttpClientFactory` with an `OkHttpClientFactory` returning a client built with a `java.net.Proxy` [V: 13]. OkHttp supports SOCKS proxies (Datadog's Android SDK uses that pattern) [V: 13].
- This is how axios (XHR) and `fetch` would be proxied on Android: they run on RN's networking module, which uses OkHttp. RN WebSocket (used by socket.io-client's `websocket` transport) also goes through OkHttp [I; not verified in the RN 0.88 source].
- Expo has no first-party way to do this. It requires a custom config plugin that edits `MainApplication` (or an Expo module's init) to install the factory before RN starts. I found no existing plugin [V: 13 says none found; plan is my inference].
- Proxy must be **per-host selective** (only the POS host goes through the tunnel, others direct) or the app breaks other traffic [I].
- Risk: socket.io long-lived WebSockets through a local TCP proxy are fine in principle but add a failure point that the current plain socket does not have [I].
- iOS: RN's URLSession networking has no equivalent hook; it would need a bridge or a NSURLProtocol/proxy dictionary workaround [I, unverified]. This is why iOS is the larger line item in the table.

---

## 4. Identity and enrollment design (if embedding is pursued)

### 4.1 Verified building blocks

- Auth key types: one-off, reusable, ephemeral, pre-approved, tagged; max lifetime 1 to 90 days; revoking a key does **not** remove devices already using it, delete them in Machines [V: 14].
- Tagged devices have key expiry disabled by default [V: 14, 15]. Normal node key expiry default is 180 days [V: 14, 15].
- OAuth clients: scope `auth_keys` can mint auth keys through `POST /api/v2/tailnet/:tailnet/keys`; keys always carry tags; API token lives 1 hour [V: 16]. (The fetched page did not say which plans include OAuth clients; check before relying on it.)
- ACLs deny by default; you can restrict a tag to one host and port [V: 3].
- Tagged devices do not count as user devices; they count toward "tagged resources" (50 free on Personal, $1/month each beyond) [V: 17].

### 4.2 Do not ship a key in the APK

A reusable auth key in the binary is a secret in a distributed artifact; anyone who unzips the APK (and Android APKs are trivially decompilable) can join your tailnet [I; standard threat]. Tailscale itself warns reusable keys are dangerous if stolen [V: 14]. Mitigations (tags + ACL limiting to bola8pos:8080) reduce blast radius but do not remove it.

### 4.3 Recommended design: per-device one-time enrollment

1. Admin (manager role) opens an "Add device" screen in the POS web UI. Backend calls Tailscale API with an OAuth client (secret stored only on the bar PC `.env`, never in the app) to mint a **one-off, tagged (`tag:bola8-phone`), pre-approved, short-expiry (e.g. 1 hour)** auth key [V: 14, 16 for capabilities].
2. POS shows it as a QR (together with the server name and a staff-name label).
3. Waiter's app scans it (camera permission), hands it to the embedded node once, stores only the resulting node state in app-private storage (and Keystore-backed encryption for the state dir [I]). The one-time key is useless afterward.
4. ACL: `tag:bola8-phone` may reach only `bola8pos` TCP 8080; nothing else [V: 3]. Phones cannot reach each other or other devices.
5. Naming: backend records `device label, staff user, node id, enrolled_at` in a table [I].
6. **Lost phone / staff leaves:** delete the device in the Tailscale admin (or API) AND deactivate the user in the POS. Key revocation alone is insufficient [V: 14]. Existing POS design already notes deactivation is the only server-side cut-off for refresh tokens up to 7 days [V: repo, BAR_MACHINE_REQUIREMENTS.md section 8], so both steps are needed. Deletion needs the control plane to be reachable to take effect for peers [V: 2: revocations cannot happen when the coordination server is down] [I: and in practice propagates on next netmap update].
7. Because a one-off tagged key cannot be reused, a stolen QR is limited to one enrollment within the expiry window.

### 4.4 Headscale option

BSD-3, self-hosted, one tailnet, active project [V: 8]. Pros: no Tailscale plan limits, can host on the bar LAN, no vendor lock to ToS. Cons: you operate it; GUI clients on iOS/macOS/Windows are proprietary [V: 8], its ACL/OIDC/preauth feature parity is not verified here, and it only helps the offline-control-plane risk if it sits on the LAN and phones can reach it, which is the same reachability problem you are trying to solve [I]. Not recommended before real need.

---

## 5. Licensing, plan limits, ToS

- **License**: tailscale-android is BSD-3-Clause with PATENTS [V: 10]; libtailscale is BSD-3 [V: 9]; Headscale BSD-3 [V: 8]. I did not individually verify the core `tailscale/tailscale` repo license in this pass; it is publicly BSD-3 to my knowledge [I]. BSD-3 permits embedding; keep copyright notices in the app's licenses screen [I].
- **Plan limits [V: 17]**: Personal (free): up to 6 users, unlimited user devices, 50 tagged resources included then $1/month each. Standard $8/user/month, Premium $18/user/month. The page said Starter was replaced by Standard. Tagged devices are not user devices. Practical reading [I]: if all phones are tagged devices (enrolled by an admin, not logged in as individual users), N waiters likely fit in the free 50 tagged resources, plus the PC. The owner's tailnet may already be using some of the 6 users and its tags; confirm in the admin console.
- **Terms of Service [V: 18]**: license is "solely for your own personal use or internal business purposes"; you may not "commercially exploit" the Services or "resell" them; no explicit text on embedding in a product. For **this** use (your own bar's phones, your own tailnet, internal business use) that looks permitted [I, not legal advice]. If Bola 8 Staff were ever **sold to other bars** with an embedded tunnel on each customer's tailnet, that is a different case and you would need written confirmation from Tailscale [I].

---

## 6. Hard-constraint check

### 6.1 Internet down, LAN up

- **Verified [V: 2]**: Tailscale traffic never passes through the coordination server; devices connect directly when possible, else via DERP. Existing keys and firewall rules are cached locally. What stops: adding devices, key refresh/exchange (so devices lose each other gradually when keys expire), policy updates, revocation.
- **What this means for the bar [I]**:
  - An already-logged-in phone and PC with valid keys and a direct path keep working during an internet outage. The sources do not state whether a phone that is **restarted or whose app process is killed** during the outage can bring the tunnel back up from cached state; the doc did not cover restart behavior [V: 2 says it does not]. Treat as **unknown, must test**.
  - First enrollment and re-login cannot happen offline. A new waiter on a night the internet is down cannot join.
  - Tagged devices have key expiry off by default [V: 14], so scheduled expiry is not a daily risk, but it is a risk for non-tagged devices (180 days) [V: 15].
- **Net effect**: for a POS that must keep trading when the ISP drops, the pure-LAN path (Option A) has strictly fewer failure modes than any Tailscale path. This is the strongest argument against making Tailscale the *only* path. Keep the LAN URL working as the primary and Tailscale as a fallback at most [I].

### 6.2 Client isolation and DERP

- Direct connections are peer-to-peer over UDP and depend on NAT traversal; if direct fails, traffic goes via DERP; every connection starts relayed and tries to upgrade [V: 19].
- I could **not** find a Tailscale source that explicitly says what happens under AP/client isolation [V: search returned none]. By mechanism [I]: isolation drops frames between wireless clients, so the phone cannot reach the PC's LAN IP directly, and probably not the PC's wired/Wi-Fi UDP endpoint either. Tailscale would then stay on DERP (via the internet), which means every POS request depends on internet and a DERP region, and latency moves from a few ms to tens or hundreds [I].
- **So Tailscale does not remove the isolation dependency; it hides it behind the internet.** If isolation is the root cause, turning it off (or a dedicated staff SSID) fixes both direct LAN and Tailscale's direct path. If you cannot turn it off, Tailscale over DERP works only while the internet is up.
- A peer relay (a device in the tailnet relaying for others) is a documented option in the same page [V: 19], but it needs a third device that both sides can reach; that is more complexity than fixing the AP [I].

### 6.3 Battery and background on Android

- No official Tailscale guidance on Doze was found [V: search]. Community reports show high battery drain in some versions and with split tunneling, and VPNs killed by battery optimization or phantom-process killing [V: 20, anecdotal].
- For an embedded userspace node [I]: the node must run while the app is foreground (waiters keep the app open on shift; the app already uses `expo-keep-awake` [V: repo]). In background, Android will freeze or kill the process unless a foreground service is used, which means a persistent notification and extra Play policy declarations. Socket.io reconnect on resume already exists; the tunnel would add its own reconnect and handshake latency (first packet can take seconds [I, unverified]).
- Keeping the node alive 24/7 on 10+ phones for a bar shift will cost battery that the current plain socket does not [I].

---

## 7. Risks

1. **Wrong problem (high likelihood).** The LAN failure causes are unconfirmed on site (all items are "pending bar-machine access" in BAR_MACHINE_REQUIREMENTS.md). Spending 5 to 9 weeks on embedding before a diagnosis could leave the real fault (e.g., client isolation) in place, with an internet dependency added on top.
2. **Maintenance and fragility of a custom Go-in-RN stack.** No upstream-supported embedding path, community wrappers are Flutter-only and unfinished on Android [V: 6]; Android needs patches around SELinux/netmon [V: 6]; Expo SDK 58 / RN 0.88 upgrades could break the native module; Go toolchain, 16 KB page-size and NDK alignment requirements apply [I]. One dev owns the whole thing.
3. **Internet and control-plane dependency for a POS.** Enrollment, re-login and key refresh need Tailscale's service [V: 2]; if the bar's internet is down during shift start, new/refreshed devices cannot connect [I]. A shared-secret leak (key in APK, QR screenshot) is a second class of risk [V: 14 for warning].
4. Smaller: Play policy for background services / VPN declaration [I]; ToS wording if productized for other venues [V: 18]; iOS effort and entitlement unknowns [I]; multi-VPN conflict on phones with a personal VPN if VpnService variant is chosen [V: 11]; Doze/battery [V: 20].

---

## 8. Recommended plan

### This week (no embedding)

1. **On-site diagnosis (0.5 day).** Run the read-only checks already in BAR_MACHINE_REQUIREMENTS.md section 2/3 from a PC and from two staff phones: network profile (`Get-NetConnectionProfile`), firewall rule, phone browser to `http://<ip>:8080/api/v1/health`, ping between two phones on the SSID (isolation test). Record which of the four causes is true. This decides everything else.
2. **Fix what the diagnosis shows (0.5 to 1 day):** add the Private-profile firewall rule, set the profile Private, add a DHCP reservation, disable client isolation or create a staff SSID/VLAN. If the router cannot do it, a cheap dedicated router for the bar is the fallback [I].
3. **Ship an installer-free PC script** (1 day [I]): a scheduled/startup PowerShell that verifies profile + rule and re-applies them (idempotent), and prints the current URL.
4. **Optional quick win now, zero code:** pilot the official Tailscale app on 2 to 3 phones as tagged devices with an ACL to `bola8pos:8080`. The app already accepts these URLs [V: repo]. This also answers whether staff tolerate the official app, and tests offline/restart behavior (Section 6.1) cheaply.

### Next 2 to 3 weeks (app work, small)

5. **In-app connection diagnostics (2 to 4 days):** names the failing layer: not on Wi-Fi / Wi-Fi without internet; DNS; host timeout (firewall or isolation) vs connection refused (service down) vs bad response (not POS). Add copy-to-clipboard report for the owner. Reuses `validateServer`, NetInfo (already a dependency) [V: repo].
6. **QR with current URL (2 to 3 days):** POS shows QR; app scans (expo-camera) and runs existing validation. Solves "IP changed" without mDNS and works under isolation only if isolation is off (it is a LAN URL).
7. **mDNS (4 to 7 days) only if** QR + DHCP reservation are not enough. Note NETWORKING_AND_SYNC.md already lists mDNS hostnames as unreliable on Android apps [V: repo], and isolation blocks multicast [I].

### Later, only on a trigger

8. **Embedding spike (3 to 5 days, timeboxed)** only if: network fixes are in place, staff reject the official Tailscale app, and remote access from outside the bar is a real requirement. Spike scope: Android only, userspace, tsnet/libtailscale built as a `.so`, local SOCKS5/HTTP proxy on 127.0.0.1, OkHttp factory scoped to the POS host, one pre-authorized tagged key entered by hand, measure battery/latency/restart-offline behavior. Go/no-go after the spike. Full build per the Section 2 estimate (F) follows only on a clear go.
9. Headscale and iOS remain parked.

---

## 9. Open questions for the owner

1. Is the real reason waiters "can't connect" known? (wrong IP, no connection at all, drops after a while, only some phones?) Can we get 30 minutes on site with a laptop and two phones?
2. Who controls the router/AP? Can client isolation be turned off, or a staff SSID created? Is there guest/staff mix on one SSID?
3. Does the bar PC use Ethernet or Wi-Fi? What is its network profile now?
4. Do you need access **outside** the bar (managers at home), or only inside? That decides whether Tailscale has any unique value.
5. Does the bar lose internet regularly? Must the POS keep working during an outage? (If yes, Tailscale cannot be the only path.)
6. Are phones owned by staff or by the bar? (MDM / Android Enterprise only works for bar-owned phones.) How many devices and how often does staff turnover occur?
7. Who administers the Tailscale tailnet today, and how many of the 6 free users / 50 tagged resources are already used? Are you on a paid plan?
8. Will this app ever be offered to other venues? (ToS and support model change.)
9. Is iOS a firm requirement, and by when?

---

## 10. Sources

1. Tailscale, tsnet: https://tailscale.com/kb/1244/tsnet
2. Tailscale, What happens if the coordination server is down: https://tailscale.com/docs/reference/coordination-server-down.md
3. Tailscale, ACL syntax (default deny, host:port example): https://tailscale.com/kb/1337/acl-syntax
4. pkg.go.dev tsnet (experimental, via search): https://pkg.go.dev/tailscale.com/tsnet ; web search for RN modules found none
5. Search for React Native tailscale embedding (no RN module found): results at https://pub.dev/documentation/libtailscale/1.0.1/ and https://github.com/passcod/libtailscale
6. Community mobile wrappers: https://github.com/leondgarse/tailscale_mobile ; https://pub.dev/packages/tsnet_flutter ; https://pub.dev/packages/tsnet_flutter/changelog
7. Zeroconf options for RN/Expo: https://github.com/rdev/react-native-zeroconf ; https://www.pkgstats.com/pkg:expo-zeroconf ; https://www.pkgstats.com/pkg:@dawidzawada/bonjour-zeroconf ; https://dev.to/bfforward/how-to-use-react-native-zeroconf-with-expo-2kjc
8. Headscale: https://github.com/juanfont/headscale
9. libtailscale: https://github.com/tailscale/libtailscale
10. tailscale-android: https://github.com/tailscale/tailscale-android
11. Android VpnService guide: https://developer.android.com/develop/connectivity/vpn
12. Tailscale userspace networking (SOCKS5 v1.8+, HTTP v1.16+): https://tailscale.com/kb/1112/userspace-networking
13. RN OkHttp factory commit https://github.com/facebook/react-native/commit/22efd95 ; Datadog SOCKS proxy example https://docs.datadoghq.com/es/real_user_monitoring/guide/proxy-mobile-rum-data
14. Auth keys: https://tailscale.com/kb/1085/auth-keys
15. Key expiry: https://tailscale.com/kb/1028/key-expiry
16. OAuth clients: https://tailscale.com/kb/1215/oauth-clients
17. Pricing and plan limits: https://tailscale.com/pricing
18. Terms of service: https://tailscale.com/terms
19. Connection types (DERP, direct, peer relays): https://tailscale.com/kb/1257/connection-types
20. Battery anecdotes: https://github.com/tailscale/tailscale/issues/13725 ; https://forum.tailscale.com/t/battery-drain-on-android/2233
21. Android MDM docs (AuthKey, LoginURL policies; v1.66+): https://tailscale.com/docs/integrations/mdm/android ; https://tailscale.com/docs/features/tailscale-system-policies.md
22. Repo: docs/mobile/integration/BAR_MACHINE_REQUIREMENTS.md, docs/mobile/architecture/NETWORKING_AND_SYNC.md, mobile/src/config/serverConfig.ts, mobile/package.json

Not verified in this pass: core tailscale/tailscale license text, OAuth client plan availability, whether a restarted node comes up from cached state while offline, RN 0.88 WebSocket-over-OkHttp proxy honoring, iOS RN proxy hooks, any Tailscale statement about AP isolation.
