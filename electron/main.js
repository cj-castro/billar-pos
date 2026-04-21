const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')

const FLASK_PORT = 5000
const FLASK_URL = `http://127.0.0.1:${FLASK_PORT}`
const HEALTH_URL = `${FLASK_URL}/api/v1/health`
const MAX_HEALTH_RETRIES = 60   // 30 seconds
const HEALTH_INTERVAL_MS = 500

let flaskProcess = null
let mainWindow = null

// Load .env written by installer (or fall back to defaults)
function loadEnvConfig() {
  const appDataEnv = path.join(
    process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'BilliardBarPOS',
    '.env'
  )
  if (fs.existsSync(appDataEnv)) {
    const lines = fs.readFileSync(appDataEnv, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      if (key && !(key in process.env)) process.env[key] = val
    }
  }
}

loadEnvConfig()

function startFlask() {
  const backendDir = path.join(__dirname, '..', 'backend')

  const flaskEnv = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/billiardbar',
    SECRET_KEY: process.env.SECRET_KEY || 'desktop-secret-key-change-me',
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'desktop-refresh-secret-change-me',
    SERVE_STATIC: '1',
    FLASK_APP: 'wsgi.py',
    PYTHONUNBUFFERED: '1',
    LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
  }

  // Try 'python' first (Windows default), fall back to 'python3'
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

  flaskProcess = spawn(pythonCmd, ['desktop.py'], {
    cwd: backendDir,
    env: flaskEnv,
  })

  flaskProcess.stdout.on('data', (data) => process.stdout.write(`[Flask] ${data}`))
  flaskProcess.stderr.on('data', (data) => process.stderr.write(`[Flask] ${data}`))

  flaskProcess.on('error', (err) => {
    console.error('[Electron] Failed to start Flask process:', err.message)
    dialog.showErrorBox(
      'Backend Error',
      `Could not start the backend server.\n\nMake sure Python is installed and dependencies are set up.\n\nError: ${err.message}`
    )
    app.quit()
  })

  flaskProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[Electron] Flask exited with code ${code}`)
    }
  })
}

function waitForFlask(callback, retriesLeft = MAX_HEALTH_RETRIES) {
  const req = http.get(HEALTH_URL, (res) => {
    if (res.statusCode === 200) {
      console.log('[Electron] Backend is ready.')
      callback()
    } else {
      retry(callback, retriesLeft)
    }
  })

  req.on('error', () => retry(callback, retriesLeft))
  req.setTimeout(400, () => { req.destroy(); retry(callback, retriesLeft) })
}

function retry(callback, retriesLeft) {
  if (retriesLeft <= 0) {
    dialog.showErrorBox(
      'Backend Timeout',
      'The backend server did not start within 30 seconds.\n\nCheck that PostgreSQL is running and the database exists.\n\nRun setup-desktop.bat if this is your first time.'
    )
    app.quit()
    return
  }
  setTimeout(() => waitForFlask(callback, retriesLeft - 1), HEALTH_INTERVAL_MS)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'BilliardBar POS',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadURL(FLASK_URL)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  startFlask()
  waitForFlask(createWindow)
})

app.on('window-all-closed', () => {
  if (flaskProcess) {
    flaskProcess.kill()
    flaskProcess = null
  }
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
