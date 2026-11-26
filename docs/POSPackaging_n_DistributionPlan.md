POS Packaging & Distribution Plan                                                                                               
                                                         
  Honest framing first                                                                                                            
                                                                                                                                  
  Python and JavaScript are interpreted. There is no way to make them unrecoverable on hardware you don't control — only          
  progressively harder to reverse. The realistic goal is "casual bar owner / IT contractor cannot read or copy your code, and a   
  determined attacker takes weeks, not hours." The plan below targets that bar. Anyone promising stronger is selling snake oil.   
                                                         
  The licensing piece is the same: it raises cost-of-piracy, it does not eliminate it. The strongest deterrent in your category is
   operational lock-in (your support, your menu sync, your Rappi token rotation) — not technical DRM.
                                                                                                                                  
  ---                                                    
  1. Code protection strategy
                             
  1a. Backend (Python) — two-tier
                                                                                                                                  
  ┌──────────┬──────────────────┬───────────────────────────────────────┬─────────────────────────────────────────────────────┐   
  │   Tier   │       Tool       │              Applied to               │                         Why                         │   
  ├──────────┼──────────────────┼───────────────────────────────────────┼─────────────────────────────────────────────────────┤   
  │          │ Cython →         │ app/services/* (pricing, billing,     │ Compiled to C, no recoverable Python. ~10× harder   │
  │ Strong   │ compiled .so /   │ license, Rappi auth, inventory math)  │ to reverse than bytecode. Performance neutral or    │
  │          │ .pyd             │                                       │ faster.                                             │   
  ├──────────┼──────────────────┼───────────────────────────────────────┼─────────────────────────────────────────────────────┤
  │ Standard │ PyArmor 8 (super │ Everything else (app/api/*,           │ Encrypted bytecode + runtime VM. Stops decompilers  │   
  │          │  mode)           │ app/models/*, wsgi.py)                │ like uncompyle6 cold.                               │   
  └──────────┴──────────────────┴───────────────────────────────────────┴─────────────────────────────────────────────────────┘
                                                                                                                                  
  The split exists because Cython is rough on Flask blueprints and dynamic imports — you'd spend a week debugging route           
  registration. Cython on pure-logic modules + PyArmor on the Flask glue gives 90% of the protection at 10% of the integration
  pain.                                                                                                                           
                                                         
  Image rule: the final container has zero .py files — only .so / .pyd (Cython) and PyArmor-protected .pyc. The build stage       
  compiles in a separate "builder" image; the runtime image only gets the artifacts. Multi-stage Dockerfile, well-established
  pattern.                                                                                                                        
                                                         
  Reject:
  - Nuitka whole-app — strongest in theory, but Flask + SocketIO + SQLAlchemy + eventlet trigger enough import-magic edge cases
  that builds become brittle. Not worth it for a small dev team.                                                                  
  - .pyc only — trivially decompiled. Token gesture, not protection.
                                                                                                                                  
  1b. Print agent (Python on Windows host)                                                                                        
                                                                                                                                  
  - PyInstaller --onefile --noconsole to produce print-agent.exe — single binary, no Python runtime visible.                      
  - PyArmor applied to source before PyInstaller bundles it (PyInstaller alone is reversible with pyinstxtractor + uncompyle6;    
  PyArmor blocks that path).                                                                                                      
  - The .exe is what NSSM wraps as a Windows service. Even if someone extracts the PyInstaller archive, they get encrypted
  bytecode.                                                                                                                       
                                                         
  1c. Frontend (React)                                                                                                            
                                                         
  Three layers, in order:                                                                                                         
                                                         
  1. Vite production build — already minified, tree-shaken, hashed filenames. Source maps disabled (build.sourcemap: false).      
  Critical — most "leaked frontend code" stories are from accidentally-shipped sourcemaps.
  2. javascript-obfuscator post-build — string array encoding, control-flow flattening, dead-code injection. ~15% bundle bloat,   
  ~10% runtime cost. Enough to make hand-reading impractical.                                                                     
  3. Build-time license watermark — embed an HMAC-signed (install_id, build_hash) blob in the bundle. If a bundle leaks, you can
  identify which deployment it came from. Pure forensics, no runtime effect.                                                      
                                                         
  Don't bother with: WASM-encryption schemes, DRM'd JS bundles, encrypted code-splitting. They all decrypt in the browser and the 
  cost-vs-benefit is awful.                              
                                                                                                                                  
  1d. Secrets in code — separate problem                                                                                          
   
  Move every secret out of code into env vars / sealed config: Rappi client secret, JWT signing key, Postgres password. Code      
  protection doesn't matter if JWT_REFRESH_SECRET=dev-refresh-secret-change-in-production is hardcoded (which today's
  docker-compose.yml:31 falls back to). The installer generates these per-install — see §3.                                       
                                                         
  ---
  2. Build pipeline
                   
  2a. Where it runs
                                                                                                                                  
  A dedicated build machine or CI runner (GitHub Actions self-hosted is fine) that holds your private signing keys. Never on the  
  dev laptop — the moment those keys leave your control, every shipped install is compromisable.                                  
                                                                                                                                  
  2b. Stages                                                                                                                      
   
     ┌─ source repo ─┐                                                                                                            
     │               │                                   
     ▼               ▼                                                                                                            
  [backend build] [frontend build] [print-agent build]
     │               │                  │                                                                                         
     ▼               ▼                  ▼                                                                                         
   Cython +       Vite +              PyArmor +
   PyArmor        obfuscator          PyInstaller                                                                                 
     │               │                  │                
     ▼               ▼                  ▼                                                                                         
   backend.tar   frontend.tar     print-agent.exe        
   (docker save)  (docker save)    (signed)                                                                                       
     │               │                  │                
     └───────┬───────┴──────────────────┘                                                                                         
             ▼                                                                                                                    
      [installer packager]
      NSIS / Inno Setup                                                                                                           
             │                                                                                                                    
             ▼
      BarPOS-Setup-vX.Y.Z.exe                                                                                                     
      (signed with EV cert)                                                                                                       
                                                                                                                                  
  2c. What ships in the installer                                                                                                 
                                                                                                                                  
  BarPOS-Setup-vX.Y.Z.exe   (~600 MB, signed)                                                                                     
    ├── docker-images/                                                                                                            
    │     ├── backend.tar          (Cython + PyArmor, no .py)
    │     ├── frontend.tar         (obfuscated bundle, served by nginx)                                                           
    │     └── postgres-15.tar      (vanilla upstream image, no need to protect)                                                   
    ├── print-agent/                                                                                                              
    │     ├── print-agent.exe      (PyArmor + PyInstaller)                                                                        
    │     └── nssm.exe                                                                                                            
    ├── docker-compose.yml         (production version, references local images by tag, no `build:` directive)                    
    ├── .env.template                                                                                                             
    ├── migrations/                (Alembic — bytecode only)                                                                      
    ├── tools/                                                                                                                    
    │     ├── DockerDesktopInstaller.exe   (bundled, optional silent install)                                                     
    │     └── activate.exe         (license activation helper)                                                                    
    └── docs/                                                                                                                     
          ├── INSTALL.txt                                                                                                         
          ├── BACKUP.txt                                                                                                          
          └── SUPPORT.txt                                                                                                         
   
  The production docker-compose.yml differs from your dev one in one critical way: no build: directives, only image: references to
   pre-loaded local tags (barpos-backend:1.2.3). The bar owner cannot rebuild from source because there is no source.
                                                                                                                                  
  2d. Image signing                                                                                                               
   
  Each .tar is hashed (SHA-256) and the manifest is signed with your Ed25519 release key. The installer verifies before docker    
  load. Stops a tampered USB stick from injecting a backdoor.
                                                                                                                                  
  ---                                                    
  3. Installer design (Windows)
                               
  3a. Tool choice
                                                                                                                                  
  Inno Setup > NSIS for this case. Cleaner Pascal-like scripting, better Unicode (Spanish), better silent-install support,        
  built-in code signing integration. NSIS is fine but the script gets gnarly fast.                                                
                                                                                                                                  
  3b. Folder layout on target machine                    

  C:\BarPOS\
    ├── compose\                 docker-compose.yml + .env
    ├── data\                                                                                                                     
    │     ├── postgres\          bind-mounted into postgres container
    │     ├── backups\           daily pg_dump output                                                                             
    │     └── logs\                                                                                                               
    ├── print-agent\             print-agent.exe + config + log                                                                   
    ├── license\                                                                                                                  
    │     ├── machine.fingerprint                        
    │     └── license.dat        (signed blob from your activation server)                                                        
    ├── bin\                     helper scripts (start.ps1, stop.ps1, backup.ps1)                                                 
    └── uninstall.exe                                                                                                             
                                                                                                                                  
  Bind-mount C:\BarPOS\data\postgres (not a Docker named volume) — easier for the bar owner to back up on Windows, and survives   
  Docker Desktop reinstalls.                                                                                                      
                                                                                                                                  
  3c. First-run sequence (Inno Setup script orchestrates)                                                                         
   
  1. Pre-flight check — Windows version ≥ 10, 8 GB RAM, virtualization enabled. Bail with clear message if not.                   
  2. Docker Desktop — detect existing install; if absent, run bundled DockerDesktopInstaller.exe /quiet. Reboot prompt if WSL2
  needs enabling.                                                                                                                 
  3. Folder creation — C:\BarPOS\ with correct ACLs (only the install user + Administrators can read license\).
  4. Image load — docker load -i backend.tar, docker load -i frontend.tar, docker load -i postgres-15.tar. Each verified against  
  signed manifest.                                                                                                                
  5. Per-install secret generation — installer generates random 32-byte values for POSTGRES_PASSWORD, SECRET_KEY,                 
  JWT_REFRESH_SECRET, writes to compose\.env with file ACLs locking it to install user. No two installs share a key.              
  6. Machine fingerprint — capture (Windows MachineGUID + CPU brand + primary NIC MAC) → SHA-256 hash, write to
  license\machine.fingerprint.                                                                                                    
  7. Activation prompt — a dialog asks for activation code (the 16-character code you generated for this customer). Helper EXE
  calls your activation server (or accepts an offline-activation file you emailed them). Server returns a license blob signed by  
  your Ed25519 license key, bound to the fingerprint. Stored in license\license.dat.
  8. Compose up — docker compose up -d. Backend's entrypoint runs Alembic migrations on first start (already does today via       
  entrypoint.sh).                                                                                                                 
  9. Seed data — manager/admin user creation prompted interactively (no hardcoded admin123 from the dev compose).
  10. Print agent install — copies print-agent.exe to C:\BarPOS\print-agent\, runs nssm install BarPOSPrintAgent ..., configures  
  it to run as the logged-on local user (not LocalSystem — Bluetooth printers are per-user).                                      
  11. Scheduled tasks — daily 4 AM pg_dump to data\backups\, weekly cleanup, license heartbeat (see §4).                          
  12. Desktop shortcut to http://localhost:8080.                                                                                  
  13. Smoke test — installer waits for /health on backend, prints SUCCESS or rolls back.                                          
                                                                                                                                  
  Total wall time: ~10 minutes if Docker is already installed, ~25 if not.                                                        
                                                                                                                                  
  ---                                                                                                                             
  4. Licensing enforcement                               
                          
  4a. Threat model
                                                                                                                                  
  You're not protecting against nation-states. You're protecting against:                                                         
  - (A) Bar owner installs once, copies the install folder to a second location.                                                  
  - (B) IT contractor takes the installer to another bar.                                                                         
  - (C) Someone tries to keep using it after non-payment.
                                                                                                                                  
  The model below addresses all three with reasonable friction.                                                                   
                                                                                                                                  
  4b. License blob (what your activation server signs)                                                                            
                                                                                                                                  
  {                                                                                                                               
    "license_id": "uuid",
    "customer_id": "uuid",                                                                                                        
    "fingerprint_hash": "sha256(...)",                   
    "issued_at": "2026-04-25T12:00:00Z",                                                                                          
    "expires_at": "2027-04-25T12:00:00Z",
    "features": ["pos", "rappi", "kds", "reports"],                                                                               
    "max_terminals": 5                                                                                                            
  }                                                                                                                               
                                                                                                                                  
  Signed with your private Ed25519 key (32-byte sig). Public key is compiled into the Cython binary (not in a config file).       
  Replacing the public key requires patching the .so/.pyd, which means defeating Cython first.
                                                                                                                                  
  4c. Runtime checks (defense in depth)                  

  1. On every backend startup — read license.dat, verify Ed25519 signature, verify fingerprint matches current machine, verify not
   expired. Fail closed (refuse to start) if invalid.
  2. On every login — same validation, served from cached signed blob. ~0 cost.                                                   
  3. Inside Postgres — store license fingerprint hash in a system_config row at first activation. Backend cross-checks DB hash    
  matches license fingerprint. This is the anti-copy lock: if someone copies data/postgres/ to another machine, the license       
  fingerprint will match the new machine but the DB will still have the old hash → backend refuses to start. They'd have to alter 
  the DB and re-activate.                                                                                                         
  4. Daily heartbeat (optional) — if internet is available, ping your license server with (license_id, fingerprint, version, 
  terminal_count). Non-blocking; failure just logs. Lets you see active installs.                                                 
  5. Hard expiry — at expires_at - 14d, banner appears in UI. At expires_at, system enters read-only mode (can finish open
  tickets, can't open new ones). Never bricks mid-service — bricking during a Saturday night dinner rush is how you lose customers
   and gain a lawsuit.                                   
                                                                                                                                  
  4d. Offline activation                                 

  Many bars have flaky internet. The activation flow must work via emailed code:                                                  
  - Installer captures fingerprint, generates an "activation request" file (just the fingerprint + customer ID).
  - Customer emails it to you (or pastes into a portal).                                                                          
  - You run a tool that signs and emails back license.dat.
  - Installer accepts the file, validates, proceeds.                                                                              
                                                                                                                                  
  Same code path as online activation, just manual hop.                                                                           
                                                                                                                                  
  4e. Renewal                                                                                                                     
                                                                                                                                  
  License files have a 1-year expires_at. Renewal is just issuing a new signed blob with later expiry — no re-installation needed.
   Your activation server can push it via the daily heartbeat, or you email a new license.dat.
                                                                                                                                  
  ---                                                    
  5. Service management on Windows
                                                                                                                                  
  5a. What runs as a service vs not
                                                                                                                                  
  ┌───────────────────────────┬───────────────────────────────────────────────────┬───────────────────────────────────────────┐   
  │         Component         │                      Runs as                      │                    Why                    │
  ├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────────────────┤   
  │ Docker Desktop            │ Auto-start at login                               │ It manages its own lifecycle.             │
  ├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────────────────┤
  │ Postgres + backend +      │ Docker Compose, restart: unless-stopped           │ Compose does the supervision.             │   
  │ frontend                  │                                                   │                                           │   
  ├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────────────────┤   
  │ Print agent               │ Windows service via NSSM, runs as the logged-on   │ Survives crashes; BT printers need user   │   
  │                           │ local user                                        │ context.                                  │
  ├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────────────────┤   
  │ Daily backup              │ Task Scheduler, 4 AM                              │ One-shot.                                 │
  ├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────────────────┤   
  │ License heartbeat         │ Task Scheduler, hourly                            │ Cheap and parallel-safe.                  │
  └───────────────────────────┴───────────────────────────────────────────────────┴───────────────────────────────────────────┘   
                                                         
  5b. Start/stop scripts shipped in bin\                                                                                          
                                                         
  - start-pos.ps1 → docker compose up -d + start BarPOSPrintAgent service.                                                        
  - stop-pos.ps1 → reverse.                              
  - restart-pos.ps1 → useful for support calls.                                                                                   
  - health.ps1 → already exists at scripts/health-check.ps1 — ship the production version.
                                                                                                                                  
  These are small wrappers, not source code. No protection needed.                                                                
                                                                                                                                  
  5c. Auto-start on Windows boot                                                                                                  
                                                         
  - Docker Desktop: settings flag during installer (SettingsJSON: "openOnStartup": true).                                         
  - Print-agent service: NSSM Start = SERVICE_AUTO_START.
  - Compose stack: a Task Scheduler entry "On startup, run start-pos.ps1" with 60s delay (waits for Docker to come up).           
                                                                                                                                  
  The bar owner powers on the PC, walks away, and 90 seconds later it's serving. No manual steps.                                 
                                                                                                                                  
  ---                                                                                                                             
  6. Upgrade strategy                                    
                     
  6a. Update package
                                                                                                                                  
  A signed .barpos-update file (just a renamed zip):                                                                              
  update-1.2.4.barpos-update                                                                                                      
    ├── manifest.json    (version, signed hashes, migration list)                                                                 
    ├── backend.tar                                                                                                               
    ├── frontend.tar                                                                                                              
    ├── print-agent.exe  (only if changed)                                                                                        
    └── manifest.sig     (Ed25519 signature)                                                                                      
                                                                                                                                  
  6b. Two delivery channels                                                                                                       
                                                                                                                                  
  Online (preferred): the backend container, on the daily heartbeat, asks your update server "is there a newer version for license
   X?". If yes, downloads to C:\BarPOS\updates\staging\, verifies signature, marks pending. The bar owner sees a "Update available
   — Apply Tonight" toggle in the manager UI. Applied during a chosen quiet window (usually 4 AM).                                
                                                         
  Offline (fallback): USB drop. Owner copies update-1.2.4.barpos-update into C:\BarPOS\updates\inbox\. A folder watcher (part of  
  the print-agent service) sees it, validates the signature, moves to staging. Same approval flow.
                                                                                                                                  
  6c. Apply step                                         

  1. pg_dump to data\backups\pre-update-1.2.4.sql.gz. Non-negotiable.                                                             
  2. docker compose down.
  3. docker load new images.                                                                                                      
  4. docker compose up -d — backend's entrypoint runs new Alembic migrations.                                                     
  5. Health probe; if it fails within 60s, automatic rollback: load previous images (kept in C:\BarPOS\updates\rollback\), restore
   DB from the dump, restart. Logs the failure for support.                                                                       
  6. Notification toast in UI: "Updated to 1.2.4."                                                                                
                                                                                                                                  
  6d. What you do NOT ship in updates                                                                                             
                                                                                                                                  
  Database schema changes that aren't in Alembic. Manual SQL. Hand-edited config. Every change is a migration; every migration is 
  reversible or has a documented forward-only justification. Same hygiene that made the 2026-04-25 deploy work cleanly.
                                                                                                                                  
  ---                                                    
  Honest tradeoffs / what this plan does not do
                                                                                                                                  
  - A determined reverse-engineer with a week and IDA Pro will recover meaningful chunks of your business logic from the Cython 
  .so files. Cython is real protection against casual reading, not against a security researcher. If your moat is "nobody can     
  replicate this," the moat is fake — your real moat is your support, your data, your operational ownership of the Rappi
  integration.                                                                                                                    
  - Frontend is fundamentally readable. Obfuscation buys time and embarrassment-cost, nothing more.
  - License DRM can be patched by someone who reverses the binary. The DB-fingerprint cross-check raises the bar (they'd have to  
  find both checks AND alter the DB), but it's not unbreakable. Combine with non-technical levers: contracts, named seats, support
   cutoff for unauthorized installs, watermarked builds.                                                                          
  - Auto-updater adds risk. A bad update can take down service. The rollback step is mandatory; without it, don't ship the        
  updater. Many vendors deliberately do not auto-update POS systems for this reason — they push a "Update Now" button only.       
   
  ---                                                                                                                             
  Recommended sequencing                                 
                        
  1. Week 1–2: secret hygiene cleanup (per-install secrets, kill the dev defaults in compose). Cheap, biggest security ROI.
  2. Week 3–4: PyArmor on backend + print agent, frontend obfuscator. Multi-stage Dockerfile. No license enforcement yet — just   
  clean image hygiene.                                                                                                            
  3. Week 5–6: Cython on app/services/*. License-blob format + Ed25519 signing. Activation server (small Flask app on a $5 VPS).  
  4. Week 7–8: Inno Setup installer, NSSM service wiring, backup/restore scripts, end-to-end install on a clean Windows VM.       
  5. Week 9: updater + heartbeat. Optional — many vendors ship v1 without it.                                                     
  6. Week 10: soak test at a friendly second location before commercial rollout.                                                  
                                                                                                                                  
  About 2 months of focused work. The first two weeks alone (secret hygiene + PyArmor) close ~70% of the practical risk; the rest 
  is hardening and operational tooling.                                 