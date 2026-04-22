const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const FLASK_PORT = 5000
const FLASK_URL = `http://127.0.0.1:${FLASK_PORT}`
const HEALTH_URL = `${FLASK_URL}/api/v1/health`
const MAX_HEALTH_RETRIES = 60   // 30 seconds
const HEALTH_INTERVAL_MS = 500

let flaskProcess = null
let mainWindow = null
let setupWindow = null

// ---------------------------------------------------------------------------
// AppData .env helpers
// ---------------------------------------------------------------------------

function getEnvDir() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'BilliardBarPOS'
  )
}

function getEnvPath() {
  return path.join(getEnvDir(), '.env')
}

function loadEnvConfig() {
  const envPath = getEnvPath()
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
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

function isConfigured() {
  const envPath = getEnvPath()
  if (!fs.existsSync(envPath)) return false
  const content = fs.readFileSync(envPath, 'utf8')
  // Configured if DATABASE_URL is present and non-empty
  return /^DATABASE_URL=.+/m.test(content)
}

function writeEnvFile({ host, port, dbName, user, password }) {
  const dir = getEnvDir()
  fs.mkdirSync(dir, { recursive: true })

  // Percent-encode special chars in password for the connection URL
  const encodedPass = encodeURIComponent(password)
  const dbUrl = `postgresql://${user}:${encodedPass}@${host}:${port}/${dbName}`

  const content = [
    `DATABASE_URL=${dbUrl}`,
    `SECRET_KEY=${crypto.randomBytes(32).toString('hex')}`,
    `JWT_REFRESH_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    `LOG_LEVEL=INFO`,
  ].join('\n') + '\n'

  fs.writeFileSync(getEnvPath(), content, 'utf8')
}

// ---------------------------------------------------------------------------
// Flask process
// ---------------------------------------------------------------------------

function startFlask() {
  // Reload .env so freshly written config is picked up
  loadEnvConfig()

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

  let flaskExe, flaskArgs, flaskCwd

  if (app.isPackaged) {
    const backendDir = path.join(process.resourcesPath, 'backend')
    flaskExe = path.join(backendDir, 'billiardbar-backend.exe')
    flaskArgs = []
    flaskCwd = backendDir
  } else {
    const backendDir = path.join(__dirname, '..', 'backend')
    flaskExe = process.platform === 'win32' ? 'python' : 'python3'
    flaskArgs = ['desktop.py']
    flaskCwd = backendDir
  }

  flaskProcess = spawn(flaskExe, flaskArgs, {
    cwd: flaskCwd,
    env: flaskEnv,
  })

  flaskProcess.stdout.on('data', (data) => process.stdout.write(`[Flask] ${data}`))
  flaskProcess.stderr.on('data', (data) => process.stderr.write(`[Flask] ${data}`))

  flaskProcess.on('error', (err) => {
    console.error('[Electron] Failed to start Flask process:', err.message)
    showFatalError(`Could not start the backend server.\n\nError: ${err.message}`)
  })

  flaskProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[Electron] Flask exited with code ${code}`)
    }
  })
}

function stopFlask() {
  if (flaskProcess) {
    flaskProcess.kill()
    flaskProcess = null
  }
}

// ---------------------------------------------------------------------------
// Health check with retry — on permanent failure offer Reconfigure / Quit
// ---------------------------------------------------------------------------

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
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'BilliardBar POS — Backend Timeout',
      message: 'The backend server did not start within 30 seconds.',
      detail: 'This usually means the database credentials are wrong or PostgreSQL is not running.\n\nCheck that PostgreSQL is running and try reconfiguring the connection.',
      buttons: ['Reconfigure Database', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) {
      stopFlask()
      showSetupWindow()
    } else {
      app.quit()
    }
    return
  }
  setTimeout(() => waitForFlask(callback, retriesLeft - 1), HEALTH_INTERVAL_MS)
}

function showFatalError(detail) {
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'BilliardBar POS — Error',
    message: 'A fatal error occurred.',
    detail,
    buttons: ['Quit'],
  })
  app.quit()
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

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

function showSetupWindow() {
  if (setupWindow) {
    setupWindow.focus()
    return
  }

  setupWindow = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    title: 'BilliardBar POS — Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // In packaged mode, app files live in resources/app/ (asar:false → unpacked dir)
  const setupFile = path.join(__dirname, 'setup.html')

  setupWindow.loadFile(setupFile)

  setupWindow.on('closed', () => {
    setupWindow = null
  })
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('save-config', async (_event, config) => {
  try {
    writeEnvFile(config)
    // Close setup window, launch Flask
    if (setupWindow) { setupWindow.close(); setupWindow = null }
    startFlask()
    waitForFlask(createWindow)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('reconfigure', async () => {
  stopFlask()
  if (mainWindow) { mainWindow.close(); mainWindow = null }
  try { fs.unlinkSync(getEnvPath()) } catch (_) {}
  showSetupWindow()
  return { success: true }
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  if (isConfigured()) {
    loadEnvConfig()
    startFlask()
    waitForFlask(createWindow)
  } else {
    showSetupWindow()
  }
})

app.on('window-all-closed', () => {
  stopFlask()
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null && !setupWindow) {
    if (isConfigured()) {
      createWindow()
    } else {
      showSetupWindow()
    }
  }
})
