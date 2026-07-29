const { app, BrowserWindow, dialog } = require('electron')
const { fork } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

// ── Где хранить данные пользователя (проекты, настройки, журнал) ──────────────
// По умолчанию Electron предлагает %APPDATA%\<имя> — данные оказываются далеко
// от установленной программы, их неудобно найти, скопировать и перенести.
// Поэтому храним их в папке data РЯДОМ С EXE (куда установили — туда и данные).
// Если писать туда нельзя (например, установили в Program Files без прав),
// молча ломаться нельзя — откатываемся на стандартный userData.
function resolveDataDir() {
  const nextToExe = path.join(path.dirname(app.getPath('exe')), 'data')
  try {
    fs.mkdirSync(nextToExe, { recursive: true })
    const probe = path.join(nextToExe, '.write-test')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
  } catch (e) {
    const fallback = app.getPath('userData')
    console.warn(`[data] «${nextToExe}» недоступна для записи (${e.code ?? e.message}), данные — в ${fallback}`)
    return fallback
  }
  migrateFromUserData(nextToExe)
  return nextToExe
}

// Разовый перенос ранее созданных данных из %APPDATA%: иначе после обновления
// пользователь увидел бы пустой список проектов и решил, что всё потерялось.
// Копируем только если рядом с exe данных ещё нет.
function migrateFromUserData(targetDir) {
  const legacy = app.getPath('userData')
  if (legacy === targetDir) return
  const items = ['projects', 'logs', 'settings.json', 'value-presets.json', 'favorite-params.json']
  const alreadyHasData = items.some(n => fs.existsSync(path.join(targetDir, n)))
  if (alreadyHasData) return
  let moved = 0
  for (const name of items) {
    const from = path.join(legacy, name)
    const to = path.join(targetDir, name)
    if (!fs.existsSync(from) || fs.existsSync(to)) continue
    try { fs.cpSync(from, to, { recursive: true }); moved++ } catch { /* пропускаем */ }
  }
  if (moved) console.log(`[data] перенесено из ${legacy}: ${moved} элементов`)
}

let backendProcess = null
let mainWindow = null
let backendErrors = []

// ── Запуск NestJS через fork с ELECTRON_RUN_AS_NODE ──────────────────────────
function startBackend() {
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend')

  const scriptPath = path.join(backendDir, 'dist', 'main.js')

  backendProcess = fork(scriptPath, [], {
    cwd: backendDir,
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      USER_DATA_PATH: resolveDataDir(),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  backendProcess.stdout?.on('data', d => console.log('[backend]', d.toString().trim()))
  backendProcess.stderr?.on('data', d => {
    const msg = d.toString().trim()
    console.error('[backend]', msg)
    backendErrors.push(msg)
  })
  backendProcess.on('exit', code => console.log(`[backend] exited: ${code}`))
}

// ── Ожидание готовности бэкенда ───────────────────────────────────────────────
function waitForBackend(maxAttempts = 120) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    function check() {
      const req = http.get('http://localhost:3000', res => {
        res.destroy()
        resolve()
      })
      req.on('error', () => {
        attempts++
        if (attempts >= maxAttempts) {
          const errDetail = backendErrors.slice(-5).join('\n') || 'нет вывода'
          reject(new Error(`Backend не запустился (${maxAttempts * 0.5} сек)\n\nПоследние ошибки:\n${errDetail}`))
        } else {
          setTimeout(check, 500)
        }
      })
      req.setTimeout(500, () => { req.destroy() })
    }
    check()
  })
}

// ── Создание окна ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Modbus Controller',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadURL('http://localhost:3000')
  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Только одна копия приложения ──────────────────────────────────────────────
// Второй экземпляр недопустим: у него свой backend, который либо не сможет
// занять порт 3000 (и окно молча покажет данные ЧУЖОГО экземпляра), либо, что
// хуже, перехватит COM-порт — два мастера на одной шине RS-485 ломают обмен.
// Поэтому вторая копия сразу закрывается, а активной становится уже открытая.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Пользователь запустил ярлык ещё раз — показываем уже открытое окно
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // ── Жизненный цикл ──────────────────────────────────────────────────────────
  app.whenReady().then(async () => {
    try {
      startBackend()
      await waitForBackend()
      createWindow()
    } catch (err) {
      dialog.showErrorBox('Ошибка запуска', String(err.message ?? err))
      app.quit()
    }
  })
}

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill()
})
