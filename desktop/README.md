# Billar POS Desktop

Thin Electron shell: loads the POS web UI from the server (nothing bundled, no local backend).
The browser version is unaffected.

## Run (dev)

    cd desktop && npm install && npm start

## Build Windows installer

    npm run dist      # -> dist/Billar POS Setup <version>.exe (per-user NSIS, unsigned)

## Server URL

Default `http://localhost:8080` (bar PC). On other staff PCs use the LAN address,
e.g. `http://192.168.1.24:8080`. Press **Ctrl+Shift+S** to change it (tested against
`/api/v1/health` before saving). If the server is down the setup page shows and
retries every 5s. Config: `config.json` in the Electron userData folder (under `%APPDATA%`).
Keep the same URL on every launch: login is stored per origin.

Keys: F11 fullscreen, F5 reload, F12 devtools (dev only).
Test hooks: `BILLAR_URL=<url>` overrides the URL, `BILLAR_QUIT_MS=<ms>` auto-quits.

## Bandeja / tray

Closing the window (X or Alt+F4) only hides it to the system tray; the app keeps running
(sockets, KDS beep). Click the tray icon to reopen. Quit for real via tray menu **Salir**
(Windows shutdown/logoff is not blocked). Only one instance runs: launching again shows the
existing window. Test hook: `BILLAR_USER_DATA=<dir>` isolates userData (and the instance lock).

## No-installer alternative

Open the POS in Edge/Chrome and choose "Install app" (the web manifest enables this).
