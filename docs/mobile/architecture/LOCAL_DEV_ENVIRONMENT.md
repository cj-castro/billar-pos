# Local Dev Environment (Android companion app)

Verified 2026-11-05 on Windows 11, AMD Ryzen 9800X3D (WHPX).

## Toolchain
| Item | Version |
|---|---|
| JDK | OpenJDK 21.0.7 (Microsoft build), `JAVA_HOME` |
| Android SDK | `ANDROID_HOME=C:\Users\giris\AppData\Local\Android\Sdk` |
| cmdline-tools | 23.0.0 (`latest`) |
| platform-tools / adb | 37.0.1 (adb 1.0.41, installed in this task) |
| emulator | 37.1.11.0 (37.2.13 available, not upgraded) |
| platforms | android-34, 35, 36, 37.0 |
| build-tools | 35.0.0, 36.0.0 |
| system image | `system-images;android-35;google_apis;x86_64` (rev 9.0.0) |
| acceleration | WHPX (10.0.26300) installed and usable |

## AVD `billar_mobile_api35`
- Device `pixel_7`, Android 15 (API 35), Google APIs x86_64.
- Stored in `D:\android-avd` (because the user env var `ANDROID_AVD_HOME` points there; the existing `pos_admin_pixel` is there too and was not touched).
- Booted headless: `emulator -avd billar_mobile_api35 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect`. Serial `emulator-5554`.
- No `curl` in the image; reachability test used toybox nc (see below).

## Backend (compose project `billarmobile`)
- Services: postgres, backend (gunicorn :5000 internal), frontend (nginx). Scheduler and telegram-bot are NOT started.
- Published: `0.0.0.0:8090 -> frontend:80` (proxies `/api` and `/socket.io`). Postgres/backend are not published, so no clash with host 5432/5000.
- Volume `billarmobile_pg_data`, network `billarmobile_billiardbar_net` (isolated from other stacks).
- Dev-only secrets are set as env vars in `scripts/mobile/start-local-backend.ps1` (compose file unchanged).
- Note: `backend/entrypoint.sh` had CRLF endings in this Windows checkout (`autocrlf=true`), which makes the container fail with `exec /entrypoint.sh: no such file or directory`. It was converted to LF in the working tree (git index is already LF, no diff). If git re-checks it out as CRLF, rerun `sed -i 's/\r$//' backend/entrypoint.sh` or add `backend/entrypoint.sh text eol=lf` to `.gitattributes`.
- Login is rate-limited to 10/min per IP (Flask-Limiter, HTTP 429). Plan for this in tests.

## Local-dev logins (seed defaults, LOCAL ONLY)
| username | password | role |
|---|---|---|
| admin | admin123 | ADMIN |
| manager | manager123 | MANAGER |
| waiter1 | waiter123 | WAITER |
| waiter2 | waiter123 | WAITER |
| kitchen | kitchen123 | KITCHEN_STAFF |
| barstaff | bar123 | BAR_STAFF |

`POST /api/v1/auth/login` -> `{access_token, refresh_token, user{id,username,name,role,is_active,has_pin,created_at}}`.
Other endpoints return 200 with a Bearer token: `GET /resources` (array of tables with code/status/type/pool_config), `GET /menu/items`, `GET /menu/categories`. Socket.IO polling handshake returns `0{"sid":...}`.

## URLs
| Caller | Base URL |
|---|---|
| Host browser/curl | `http://localhost:8090/api/v1`, `http://localhost:8090/socket.io/` |
| Emulator | `http://10.0.2.2:8090/api/v1` (10.0.2.2 = host loopback alias) |
| Phone on Wi-Fi | `http://192.168.1.22:8090/api/v1` (LAN IP may change) |

Cleartext HTTP: the app needs `usesCleartextTraffic` / a network security config for debug builds.

## Firewall finding
Windows Defender Firewall is on for all profiles; Wi-Fi is classed Private. `192.168.1.22:8090` answers 401 from the host itself, but self-connections bypass the firewall, so it is NOT proven for a real phone. An inbound Allow rule exists for `com.docker.backend.exe`, the process holding 8090, so it should work. Nothing was changed. If a phone cannot connect, an admin must allow inbound TCP 8090 on the Private profile.

## Commands
```powershell
# backend
scripts\mobile\start-local-backend.ps1          # -Port 8090 default; idempotent
scripts\mobile\stop-local-backend.ps1           # stop only, data kept

# env check
scripts\mobile\check-android-env.ps1

# emulator
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd billar_mobile_api35 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect
& "$env:ANDROID_HOME\platform-tools\adb.exe" shell getprop sys.boot_completed   # 1 when ready
& "$env:ANDROID_HOME\platform-tools\adb.exe" emu kill                           # stop emulator

# reachability from emulator (no curl in image)
adb shell "(printf 'GET /api/v1/resources HTTP/1.0\r\n\r\n'; sleep 2) | toybox nc 10.0.2.2 8090 | head -1"   # HTTP/1.1 401
```
Full reset of backend data (only when intended): `docker compose -p billarmobile down -v`.
