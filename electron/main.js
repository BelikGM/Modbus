const { app, BrowserWindow, dialog, Menu, shell } = require('electron')
const { fork } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

// ── Где хранить данные пользователя (проекты, настройки, журнал, свои типы) ───
//
// Папка `data` РЯДОМ С ПРОГРАММОЙ: куда установили — туда и данные. Программу
// можно распаковать в любой каталог, она сама поймёт, где искать и куда писать,
// а всю папку целиком можно скопировать на другой компьютер или на флешку.
//
// Обычно так не делают, и по делу: деинсталлятор NSIS выполняет
// RMDir /r $INSTDIR, а установка новой версии сначала запускает деинсталлятор
// старой — при таком раскладе обновление стирало бы все проекты. Поэтому
// деинсталлятору отдельно объяснено, что папку `data` трогать нельзя
// (build/installer.nsh, макрос customRemoveFiles).
//
// Если писать рядом с программой нельзя (установка в Program Files без прав),
// молча ломаться нельзя — откатываемся на «Документы», затем на userData.
const DATA_FOLDER_NAME = 'Modbus Controller'

function resolveDataDir() {
  const candidates = [path.join(path.dirname(app.getPath('exe')), 'data')]
  try { candidates.push(path.join(app.getPath('documents'), DATA_FOLDER_NAME)) } catch { /* нет «Документов» */ }
  candidates.push(app.getPath('userData'))

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, '.write-test')
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
    } catch (e) {
      console.warn(`[data] «${dir}» недоступна для записи (${e.code ?? e.message})`)
      continue
    }
    migrateLegacyData(dir)
    return dir
  }
  return app.getPath('userData')
}

// Перенос данных из прежних мест хранения: иначе после обновления пользователь
// увидел бы пустой список проектов и решил, что всё потерялось.
//
// Переносим ПОШТУЧНО, а не папками целиком. Раньше копировалась папка `projects`
// как единое целое и только если её ещё нет — из-за этого один проект, созданный
// в новом месте, навсегда закрывал дорогу всем проектам из старого: папка уже
// существует, значит «переносить нечего». Теперь сверяется каждый проект.
function migrateLegacyData(targetDir) {
  const legacyDirs = [
    path.join(app.getPath('documents') || '', DATA_FOLDER_NAME),
    app.getPath('userData'),
  ]
  const merged = ['projects', 'logs', 'templates']   // содержимое сливаем по элементам
  const single = ['settings.json', 'value-presets.json', 'favorite-params.json', 'template-extras.json']

  for (const legacy of legacyDirs) {
    if (!legacy || path.resolve(legacy) === path.resolve(targetDir) || !fs.existsSync(legacy)) continue
    let moved = 0
    for (const name of merged) {
      const fromDir = path.join(legacy, name)
      if (!fs.existsSync(fromDir)) continue
      fs.mkdirSync(path.join(targetDir, name), { recursive: true })
      for (const entry of fs.readdirSync(fromDir)) {
        const to = path.join(targetDir, name, entry)
        if (fs.existsSync(to)) continue
        try { fs.cpSync(path.join(fromDir, entry), to, { recursive: true }); moved++ } catch { /* пропускаем */ }
      }
    }
    for (const name of single) {
      const from = path.join(legacy, name)
      const to = path.join(targetDir, name)
      if (!fs.existsSync(from) || fs.existsSync(to)) continue
      try { fs.cpSync(from, to, { recursive: true }); moved++ } catch { /* пропускаем */ }
    }
    if (moved) console.log(`[data] перенесено из ${legacy}: ${moved} элементов`)
  }
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
      USER_DATA_PATH: (process.env.MODBUS_DATA_DIR = resolveDataDir()),
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
    // Иконка окна и панели задач. Значок самого exe ставит electron-builder,
    // но окно берёт свой отдельно — без этого в панели задач висел бы
    // стандартный значок Electron.
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadURL('http://localhost:3000')
  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Меню приложения на русском ────────────────────────────────────────────────
// Стандартное меню Electron целиком на английском (File, Edit, View, Window…),
// что для оператора на объекте бесполезно. Собираем своё: только нужные пункты
// и с понятными названиями.
function buildMenu() {
  // Своя папка типов, а не поставочная: там лежат созданные пользователем типы,
  // и только её содержимое переживает обновление программы. Путь вычисляем
  // в момент клика — меню строится раньше, чем backend определит папку данных.
  const userTemplatesDir = () =>
    path.join(process.env.MODBUS_DATA_DIR || app.getPath('userData'), 'templates')

  const template = [
    {
      label: 'Файл',
      submenu: [
        { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        // registerAccelerator: false — иначе Ctrl+Z перехватывает меню и до
        // страницы клавиша не доходит, а отмена действий в редакторе типов
        // живёт именно там. Пункты меню при этом работают по клику как обычно,
        // и в обычных полях ввода Ctrl+Z по-прежнему отменяет текст.
        { role: 'undo', label: 'Отменить', registerAccelerator: false },
        { role: 'redo', label: 'Повторить', registerAccelerator: false },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Обновить страницу' },
        { role: 'forceReload', label: 'Обновить без кэша' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'close', label: 'Закрыть' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'Открыть папку с данными',
          click: () => shell.openPath(process.env.MODBUS_DATA_DIR || app.getPath('userData')),
        },
        {
          label: 'Открыть папку со своими типами ПЧ',
          click: () => {
            const dir = userTemplatesDir()
            try { fs.mkdirSync(dir, { recursive: true }) } catch { /* покажем как есть */ }
            shell.openPath(dir)
          },
        },
        { type: 'separator' },
        {
          label: 'О программе',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: 'О программе',
            message: 'Modbus Controller',
            // Путь к данным показываем прямо здесь: вопрос «где мои проекты»
            // возникает первым, а искать их наугад по диску неоткуда.
            detail: 'Версия ' + app.getVersion() + String.fromCharCode(10) +
                    'Управление частотными преобразователями по Modbus RTU (RS-485).' +
                    String.fromCharCode(10) + String.fromCharCode(10) +
                    'Данные (проекты, настройки, свои типы):' + String.fromCharCode(10) +
                    (process.env.MODBUS_DATA_DIR || app.getPath('userData')),
            buttons: ['Закрыть'],
          }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
      buildMenu()
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
