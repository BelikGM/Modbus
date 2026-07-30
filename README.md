# Modbus Controller

Программа для управления частотными преобразователями через Modbus RTU / RS-485.

> Подробное описание внутренней архитектуры (backend-модули, формат JSON-шаблонов, гейтвей и т.д.) — в [CLAUDE.md](CLAUDE.md). Этот файл — про то, как всё запустить руками.

## Что это такое

У тебя есть **частотный преобразователь** (ПЧ) — железяка которая управляет двигателем насоса. Внутри неё куча настроек: частота вращения, ток, температура, ПИД-регулятор и т.д.

Эта программа позволяет **читать и менять эти настройки через компьютер**.

## Как физически всё подключено

```
Компьютер
    │
  USB
    │
USB → RS-485 адаптер    ← маленькая коробочка/свисток
    │
  RS-485 (два провода: A и B)
    │
Частотный преобразователь ELHART EMD-PUMP / EMD-VH
```

---

## Полный запуск с нуля (от `git clone` до рабочего приложения)

Требования: **Node.js 18+** (nodejs.org — качается один раз, дальше всё остальное через `npm`), **git**.

```bash
# 1. Клонировать репозиторий
git clone https://github.com/BelikGM/Modbus.git
cd Modbus

# 2. Поставить зависимости — везде по отдельности, у каждой части свой package.json
npm install                  # корень: electron + electron-builder
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### Запуск в режиме разработки (2 терминала, без Electron)

```bash
# Терминал 1 — backend
cd backend
npm run start:dev
# → NestJS слушает http://localhost:3000, chokidar следит за /devices и /projects

# Терминал 2 — frontend
  cd frontend
  npm run dev
# → Vite слушает http://localhost:5173 и проксирует /api/* на localhost:3000
```

Открыть в браузере: **http://localhost:5173**

### Запуск как desktop-приложение (Electron)

```bash
# из корня проекта
npm run build          # соберёт React → backend/frontend-dist и скомпилирует backend (tsc)
npm run electron:dev   # откроет desktop-окно; backend стартует внутри как дочерний процесс
```
Освободить порт 3000 (backend)
$p=3000; $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if(-not $c){Write-Host "Порт $p свободен"} else {$c | ForEach-Object { $n=(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Host "Закрываю PID $($_.OwningProcess) ($n) на порту $p"; Stop-Process -Id $_.OwningProcess -Force }}


Освободить порт 5173 (frontend)
$p=5173; $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if(-not $c){Write-Host "Порт $p свободен"} else {$c | ForEach-Object { $n=(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Host "Закрываю PID $($_.OwningProcess) ($n) на порту $p"; Stop-Process -Id $_.OwningProcess -Force }}



Отдельно запускать backend/frontend не нужно — `electron/main.js` сам форкает `backend/dist/main.js`, ждёт ответа на `localhost:3000` и открывает окно.

Остановить: закрыть окно, или в терминале:
```bash
# Windows (PowerShell)
Stop-Process -Name electron -Force
```

---

## Нужно ли перезапускать после изменений?

Зависит от того, что поменялось:

| Что изменили | Нужен ли перезапуск |
|---|---|
| JSON-шаблон в `devices/templates/*.json` (регистры, alerts, errorCodes) | **Нет** — chokidar подхватывает файл сам, устройство обновится в UI за секунду |
| Файл проекта в `projects/` (вручную, не через UI) | **Нет** — тоже под слежкой chokidar |
| Код фронта (`frontend/src/**`) в режиме `npm run dev` | **Нет** — Vite HMR подставляет изменения в открытую вкладку браузера сама, без ручного `F5` |
| Код бэкенда (`backend/src/**`) при `npm run start:dev` | **Нет** — у NestJS свой watch-режим (`--watch`), пересобирает и перезапускает процесс сам за пару секунд; просто следи за логом в терминале, что рестарт закончился |
| Код бэкенда/фронта при обычном `npm run start` / уже собранном Electron-приложении | **Да** — без `--watch` и без Vite dev-сервера изменения не подхватываются, нужно останавливать и запускать заново (`Ctrl+C` → `npm run start:dev` / `npm run electron:dev` заново, для Electron ещё и `npm run build` перед этим) |

**Про автоматическую перезагрузку твоей открытой вкладки браузера** — я (Claude Code) не имею доступа к твоему открытому окну браузера напрямую, управлять им или жать в нём F5 я не могу. В режиме разработки (`npm run dev`) это в большинстве случаев и не требуется — Vite сам обновляет содержимое открытой страницы при сохранении файла.

---

## Тестирование без физического ПЧ (симулятор + com0com)

Чтобы проверить автопоиск/скан шины/мониторинг без реального устройства, используется пара виртуальных COM-портов (com0com) + скрипт-симулятор Modbus-slave.

**1. Установка com0com**
1. Скачать: https://sourceforge.net/projects/com0com/ (файл вида `setup_com0com_vX.X.X_W7_x64_signed.exe` — версия с подписанным драйвером ставится на Windows 10/11 без доп. телодвижений; если качаешь неподписанную версию — придётся временно разрешить установку неподписанных драйверов, `bcdedit /set testsigning on` и перезагрузка, либо взять форк с валидной подписью, например `github.com/paulakalanmalus/com0com`)
2. Запустить установщик, поставить с настройками по умолчанию — он сразу создаёт одну пару портов
3. После установки в меню Пуск найти **"Setup Command Prompt"** (это утилита настройки com0com, не обычная консоль) — она покажет что-то вроде:
   ```
   CNCA0 PortName=COM8
   CNCB0 PortName=COM9
   ```
   Если портов не видно/названия не те — в этой же утилите выполнить:
   ```
   change CNCA0 PortName=COM8
   change CNCB0 PortName=COM9
   ```
   `COM8` и `COM9` — два конца одной виртуальной "проволоки": всё, что пишется в один, читается из другого.

**2. Запуск симулятора** (эмулирует "устройства" на одном конце пары):
```bash
cd backend
npm run simulate -- COM11 9600 1:pump,2:vl,3:vl,4:pump,5:pump,6:pump,7:pump,8:pump
```
Это поднимет на `COM8` три виртуальных устройства на шине: slaveId 1 отвечает как Pump, slaveId 2 — как VH (можно перечислить больше через запятую, напр. `1:pump,2:vh,5:pump`).

**2.1 Очистка занятого COM порта
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*modbus-simulator*' } |
  ForEach-Object { Write-Host "kill $($_.ProcessId): $($_.CommandLine)"; Stop-Process -Id $_.ProcessId -Force }


**3. В самом приложении** подключаться нужно к **другому** концу пары — `COM9` — как к обычному порту. Дальше всё работает как с настоящим железом: автопоиск слейв-адресов, автоопределение модели, мониторинг с "живыми" (слегка шумящими) значениями.

Логика симулятора — `backend/tools/modbus-simulator.js`, там же можно добавить свои регистры при необходимости.

---

## Как фронт общается с бэком

Два канала одновременно, оба на порт **3000**:

**1. HTTP REST** (через axios + Vite proxy) — разовые операции: чтение/запись одного параметра, список устройств/проектов.
**2. WebSocket** (socket.io) — вся runtime-логика: подключение к порту, автопоиск/умный автопоиск, скан шины, мониторинг в реальном времени.

В продакшене (Electron, без Vite) оба запроса идут напрямую на 3000 — NestJS сам раздаёт собранный фронт как статику.

---

## Структура проекта
```
Modbus/
  backend/            — NestJS сервер (порт 3000)
    src/
      devices/        — шаблоны устройств + инстансы в проекте
      modbus/         — драйвер Modbus RTU
      gateway/        — WebSocket-гейтвей (вся runtime-логика)
      projects/       — проекты (наборы устройств на шине)
      settings/       — settings.json (активный проект, сохранённые порты)
    tools/
      modbus-simulator.js — симулятор устройств для тестов без железа
  frontend/           — React + Vite (порт 5173)
    src/components/   — UI компоненты
  devices/
    templates/        — JSON-шаблоны моделей ПЧ (карта регистров)
  projects/           — данные проектов пользователя (в .gitignore)
  electron/           — main.js (запуск desktop-окна), afterPack.js
```
Подробнее про каждый модуль — в [CLAUDE.md](CLAUDE.md).

## Добавление нового устройства

Шаблон модели ПЧ кладётся в `devices/templates/*.json` — появится в списке доступных шаблонов без перезапуска. Конкретное устройство на шине (со своим Slave ID) создаётся уже в приложении — вручную или через сканер шины (`Сканер шины → Умный автопоиск → Определить и добавить устройства`).

---

## Electron — сборка установщика

### Коротко: как собрать самому

Одна команда **из корня проекта** (`C:\Modbus\Modbus`), в обычном терминале / PowerShell:

```bash
npm run dist:win
```

Она делает всё сама: собирает фронтенд, собирает бэкенд, пересобирает нативный
`serialport` под текущую версию Electron и упаковывает установщик. Занимает
несколько минут.

Результат появится здесь:

| Что | Путь |
|---|---|
| **Установщик** (раздавать людям) | `C:\Modbus\Modbus\dist-electron\Modbus Controller Setup 1.0.0.exe` |
| **Портативная версия** (проверить сразу, без установки) | `C:\Modbus\Modbus\dist-electron\win-unpacked\Modbus Controller.exe` |

Перед сборкой стоит закрыть dev-серверы, иначе они держат порты и мешают
проверить собранное приложение (см. «Порт занят» ниже).

> **Где приложение хранит данные.** Всё пользовательское — проекты, настройки,
> журнал, шаблоны значений, избранное и созданные вами типы ПЧ — лежит в одной
> папке: **`Документы\Modbus Controller`** (`%USERPROFILE%\Documents\Modbus Controller`).
> Место не зависит от того, куда установлена программа, поэтому переустановка и
> обновление её не трогают. Если писать туда нельзя (перенаправленный профиль,
> политика домена), приложение откатывается на `%APPDATA%\modbus-controller`.
> Данные из прежних мест хранения переносятся один раз, автоматически.
>
> Импортированный проект **копируется** в эту же папку — путь, откуда его взяли,
> нигде не запоминается. То есть созданные и импортированные проекты всегда
> лежат вместе.
>
> Класть данные внутрь папки установки нельзя: деинсталлятор NSIS выполняет
> `RMDir /r $INSTDIR`, а установка новой версии сначала запускает деинсталлятор
> старой — то есть каждое обновление стирало бы все проекты.

### Обновление установленной версии

Старую папку удалять **не нужно** и права администратора **не нужны**:
установка идёт в профиль пользователя (`%LOCALAPPDATA%\Programs`), а новый
инсталлятор сам снимает предыдущую версию. Достаточно закрыть приложение и
запустить новый `Modbus Controller Setup <версия>.exe`.

Права администратора понадобятся, только если при установке вручную выбрать
путь вроде `C:\Program Files\...` — тогда Windows спросит их сама.

### Значок приложения

Значок собирается скриптом в PNG с прозрачным фоном:

```bash
node build/make-icon.cjs                # нарисовать знак заново
node build/make-icon.cjs --from-source  # взять build/logo-source.png и убрать у него фон
```

Результат — `build/icon.png`, из него `electron-builder` сам делает `.ico`
для Windows и `.icns` для macOS. Чтобы поставить настоящий логотип, положите
его в `build/logo-source.png` и запустите второй вариант команды.

### Порт занят (3000 или 5173)

Мешает и dev-режиму, и запуску собранного приложения: если порт 3000 уже занят
чужим процессом, окно приложения молча покажет данные ЧУЖОГО бэкенда.
Освободить (PowerShell):

```powershell
# порт 3000 — backend
$p=3000; $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if(-not $c){Write-Host "Порт $p свободен"} else {$c | ForEach-Object { $n=(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Host "Закрываю PID $($_.OwningProcess) ($n) на порту $p"; Stop-Process -Id $_.OwningProcess -Force }}

# порт 5173 — frontend (vite)
$p=5173; $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if(-not $c){Write-Host "Порт $p свободен"} else {$c | ForEach-Object { $n=(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Host "Закрываю PID $($_.OwningProcess) ($n) на порту $p"; Stop-Process -Id $_.OwningProcess -Force }}
```

Посмотреть, кто занимает, ничего не убивая:

```powershell
Get-NetTCPConnection -LocalPort 3000,5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $pr=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [PSCustomObject]@{ Порт=$_.LocalPort; PID=$_.OwningProcess; Процесс=$pr.ProcessName } } | Format-Table -AutoSize
```

---

`electron-builder` кладёт результат сборки в папку **`dist-electron/`** — это обычная папка **внутри самого проекта** (`<где лежит клонированный репозиторий>\dist-electron\`, например `C:\Modbus\Modbus\dist-electron\`), появляется только после того как ты сам запустишь `npm run dist:win` (в `.gitignore`, поэтому в свежесклонированном репозитории её нет — не баг, а норма).

```bash
npm run dist:win     # Windows: NSIS-инсталлятор
npm run dist:mac     # macOS: .dmg (собирать на Mac)
npm run dist:linux   # Linux: .AppImage
```

После `npm run dist:win` внутри `dist-electron/` будет:
- **`Modbus Controller Setup <версия>.exe`** — инсталлятор (NSIS). Это то, что раздаётся другим людям: запускается как обычная Windows-программа-установщик, спрашивает куда ставить, создаёт ярлык.
- **`win-unpacked/Modbus Controller.exe`** — уже собранное, но не упакованное в инсталлятор приложение. Можно запустить сразу двойным кликом, ничего не устанавливая — удобно для быстрой проверки своей же сборки, но это папка целиком (не один файл), раздавать в таком виде не стоит.

### Сборка .exe через GitHub Actions (без Windows-машины)

Уже настроено в `.github/workflows/build.yml` — при пуше тега вида `v*` GitHub сам соберёт `.exe` и положит в **Releases** репозитория:
```bash
git tag v1.0.0
git push origin v1.0.0
```

### Возможные проблемы

**Окно не открывается / "Backend не запустился"**
- Проверь что бэкенд собран: `cd backend && npm run build`
- Проверь что порт 3000 свободен: `netstat -ano | findstr :3000` (Windows)

**Ошибка с COM-портом / serialport**
- На Windows может потребоваться драйвер USB→RS-485 адаптера: CH340 → CH341SER, FTDI → ftdichip.com, Silicon Labs CP210x → silabs.com

---

## Поддержание документации в актуальном состоянии

Если коммит меняет что-то, что описано в README.md или CLAUDE.md (новый модуль, изменение схемы JSON, новый npm-скрипт, новый способ запуска) — обнови соответствующий раздел в этом же коммите или отдельным следующим. Оба файла должны отражать реальное текущее состояние проекта, а не историю его создания.
