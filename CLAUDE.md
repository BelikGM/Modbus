# Modbus Controller — Контекст проекта

## Что это за проект
Программа для управления частотными преобразователями (ПЧ) через протокол Modbus RTU / RS-485.
Файловая конфигурация устройств — но не «файл = устройство», а **шаблон + проект**: JSON-шаблоны описывают модель ПЧ (карту регистров), а конкретные устройства на шине (со своим slaveId) живут внутри «проекта» — папки с `*.project.json`.
Собирается как desktop-приложение через Electron (backend+frontend в одном окне), может запускаться и как обычный локальный сервер + браузер.

## Стек
- **Backend:** Node.js + NestJS (TypeScript), порт 3000
- **Frontend:** React 19 + Vite (JavaScript), порт 5173, Ant Design 6
- **Протокол:** Modbus RTU через RS-485 (USB→RS-485 адаптер)
- **Упаковка:** Electron + electron-builder (NSIS-инсталлятор под Windows)

## Библиотеки backend
- `modbus-serial` + `serialport` — общение с ПЧ через RS-485, список/проверка занятости COM-портов
- `chokidar` — слежение за папками `/devices/templates/` и `/projects/` (hot-reload)
- `@nestjs/websockets` + `socket.io` — вся runtime-логика (подключение, мониторинг, сканирование шины) идёт через WebSocket, не REST
- `@nestjs/serve-static` — если есть собранный `backend/frontend-dist`, раздаёт React как статику (режим Electron/production)

## Библиотеки frontend
- `socket.io-client` — реалтайм данные с ПЧ и вся логика подключения/сканирования
- `axios` — разовые HTTP-запросы (чтение/запись одного параметра, список устройств)
- `antd` — UI компоненты
- `recharts` — графики в мониторе
- `@dnd-kit/*` — drag-n-drop карточек в мониторе
- НЕ используем RTK Query — только useState/useEffect + socket.io

## Структура проекта
```
Modbus/
  backend/            ← NestJS сервер
    src/
      devices/        ← шаблоны устройств + инстансы в проекте (мёрж на лету)
      modbus/         ← драйвер Modbus RTU (serialport, мьютекс, идентификация, скан шины)
      gateway/        ← единственный WebSocket-гейтвей — вся runtime-логика здесь
      projects/       ← «проекты»: папки с *.project.json, список устройств на шине
      settings/        ← settings.json: активный проект, сохранённые COM-порты, UI-настройки
  frontend/            ← React + Vite
    src/
      components/      ← UI компоненты
  devices/
    templates/         ← JSON-шаблоны моделей ПЧ из поставки (карта регистров, только чтение)
    images/            ← фото устройств и схемы подключения
  projects/            ← данные проектов пользователя (в .gitignore, создаются в userData)
  electron/            ← main.js (форкает backend, ждёт готовности, открывает окно), afterPack.js
```

## Концепция — «Шаблон + Проект» (не «файл = устройство»)
- `devices/templates/*.json` — шаблон модели ПЧ: карта регистров, `errorCodes`, `alerts`, `access_legend`. Общий для всех устройств этой модели. Это ПОСТАВКА — только чтение, правка запрещена (`assertCustomTemplate`).
- `<userData>/templates/*.json` — типы, созданные пользователем в редакторе (`TemplateEditor.jsx`). Признак «свой» (`custom`) определяется ПАПКОЙ, а не полем в JSON, поэтому штатный файл нельзя сделать редактируемым правкой одной строчки. Писать/удалять можно только здесь: папка поставки заменяется целиком при обновлении программы, а в Program Files ещё и недоступна для записи. Типы, созданные до разделения папок, переносятся при старте (`migrateCustomTemplates`). При совпадении id свой тип перекрывает штатный.
- Проект (`projects/<id>/<id>.project.json`) хранит **инстансы** — конкретные устройства на шине: `{ id, name, templateId, connection: { slaveId, ... }, notes, pendingWrites, currentValues }`.
- `DevicesService.merge()` на лету склеивает шаблон + инстанс в `DeviceConfig`, который видит фронт и API.
- chokidar следит за `/devices/templates/` (правки шаблона → `device:changed` всем устройствам этой модели) и за `/projects/` (переключение/переименование проекта → `devices:reloaded`).
- Активен всегда один проект (`SettingsService.activeProject`) — это единственный набор устройств, видимый в UI, и единственное соединение с COM-портом в моменте.

## Несколько устройств на одной шине RS-485
- RS-485 — многоточечная шина: один COM-порт, до 247 устройств
- Каждый **инстанс** устройства в проекте имеет уникальный `slaveId` (проверяется при создании/редактировании — дубли запрещены)
- Подключение к порту — одно на весь активный проект (порт+скорость+dataBits/stopBits/parity), без Slave ID
- Перед каждым чтением/записью сервис вызывает `client.setID(slaveId)` из конфига устройства
- Мьютекс в `ModbusService.withLock()` гарантирует: `setID + read/write` — атомарная операция
- Порт для проекта запоминается (`SettingsService.saveProjectConnection`) и переподключается автоматически при старте / смене проекта; если порт занят — гейтвей раз в секунду пытается его перехватить (`startPortWatch`), при обрыве связи — переподключение раз в 5 сек (`startReconnect`)

## Структура JSON-шаблона устройства (упрощённо)
```json
{
  "id": "Elhart-Emd-Pump-Full",
  "name": "Elhart-Emd-Pump-Full",
  "template": true,
  "connection": { "slaveId": 1, "baudRate": 9600, "dataBits": 8, "stopBits": 1, "parity": "none", "protocol": "modbus-rtu" },
  "images": { "device": "...png", "wiring": "...png" },
  "errorCodes": { "0": "Нет ошибки", "8": "..." },
  "alerts": [
    { "id": "temp-high", "paramId": "F0.06", "condition": "gt", "threshold": 70, "level": "warning", "message": "Перегрев радиатора: {{value}} °C" }
  ],
  "access_legend": { "read": "только чтение" },
  "groups": [
    {
      "id": "F0",
      "name": "Информационные параметры",
      "params": [
        { "id": "F0.02", "name": "Выходная частота", "register": 2, "access": "read", "type": "float", "scale": 0.01, "unit": "Гц" }
      ]
    }
  ]
}
```
**Важно:** `paramId` в `alerts` должен указывать на параметр, который реально существует у этой модели — при копировании блока `alerts` между шаблонами разных моделей (Pump ↔ VL) id параметров не совпадают (у VL другая система именования — `P0.xx`, `D0.xx`, `FAULT_CODE`, а не `F0.xx`). Всегда сверяйтесь с фактическими `id` в группах `groups`, а не полагайтесь на визуальное сходство названий.

## Устройства которые поддерживаем
- **ELHART EMD-PUMP** (`Elhart-Emd-Pump-Full`, `Elhart-Emd-Pump-OWN`) — лёгкий режим, адресация `F0.xx`/`F1.xx`/... = номер регистра напрямую (F0.06 = регистр 6). Код текущей аварии — регистр `F0.27` (параметр «Текущий код аварийного состояния»); `F0.10`–`F0.13` — это АРХИВ («последняя запись об аварии» и предыдущие), он остаётся ненулевым и после устранения аварии, поэтому для оповещений/подсветки не годится.
- **ELHART EMD-VL** (`Elhart-Emd-VL-Full`) — «тяжёлый» режим, адресация параметров `P0.xx`/`D0.xx`/... через hex-префикс группы (см. `addressingRules` в самом шаблоне). Код текущей аварии — **отдельный служебный регистр 32768 / `8000h`** (параметр `FAULT_CODE` в группе `vfd-modbus`), это НЕ то же самое, что регистр `F0.27` у Pump. Шаблон раньше назывался `Elhart-Emd-VH-Full` (серии VL/VH используют одну карту регистров и одно руководство) — переименован, но `DevicesService.merge()` хранит алиас `Elhart-Emd-VH-Full → Elhart-Emd-VL-Full`, так что старые проекты с инстансами на старый templateId продолжают открываться.
- Официальные мануалы (коды ошибок, карта регистров): `RE_elhart_7747.pdf` (EMD-PUMP), `RE_elhart_9709.pdf` (EMD-VL/VH) — на `ftp.totalkip.ru`. У EMD-PUMP публично задокументированы только буквенно-цифровые мнемоники ошибок на индикаторе (OC1, OU2, OH, nU, CO...), **числовое соответствие регистру `F0.27` производитель не публикует** — текущий словарь `errorCodes` для Pump собран по аналогии и не подтверждён на реальном железе. У EMD-VL, наоборот, есть точная таблица hex-кодов для регистра `8000h` — она перенесена в `FAULT_CODE.options`.
- Идентификация модели по шине (`ModbusService.identifyDevice`) — не по стандартной Modbus device-ID функции (протокол ELHART поддерживает только функции 03/06, function 43/17 не документированы и на практике не отвечают), а по эвристике: регистр `0xF000` (режим работы, 1/2 → VL) и регистр `0` (отвечает → Pump).

## Как работает Modbus RTU
- Компьютер = Master (ведущий), ПЧ = Slave (ведомый)
- Запрос: [адрес устройства][функция][адрес регистра][кол-во регистров][CRC]
- Функция 03 = чтение регистров, функция 06 = запись одного регистра
- Значения хранятся как целые числа, масштабируются через поле `scale`
- Пример: регистр вернул 5000, scale=0.01 → 50.00 Гц

---

## Функции Modbus и структура пакета

### Функция 06 — откуда берётся

Функция — это стандартный номер операции в протоколе Modbus. Придуманы раз и навсегда в 1979 году, все устройства в мире их понимают одинаково.

```
Код    Название                    Что делает
─────────────────────────────────────────────────────
03     Read Holding Registers      Прочитать регистры
06     Write Single Register       Записать один регистр
16     Write Multiple Registers    Записать несколько регистров сразу
01     Read Coils                  Читать биты (вкл/выкл)
05     Write Single Coil           Записать один бит
```

Используются только **03** и **06** — этого достаточно для EMD-PUMP/EMD-VL (единственные функции, задокументированные производителем).

В `modbus.service.ts` библиотека подставляет код сама:
```typescript
client.readHoldingRegisters(register, 1)  // → функция 03 в байте №2
client.writeRegister(register, rawValue)  // → функция 06 в байте №2
```

### Разбор каждого байта пакета

Пример: запись значения 1 (Пуск) в регистр 8192 (CMD):
```
01   06   20 00   00 01   43 CA
│    │    │        │       │
│    │    │        │       └── CRC (2 байта, контрольная сумма)
│    │    │        └────────── значение: 0x0001 = 1
│    │    └─────────────────── адрес регистра: 0x2000 = 8192
│    └──────────────────────── функция 06 = записать регистр
└───────────────────────────── Slave ID = 1 (адрес устройства)
```

**Байт 1 — Slave ID:** кому адресован пакет. Остальные устройства на шине молчат.

**Байт 2 — Функция:** что нужно сделать (03=читать, 06=писать).

**Байты 3-4 — Адрес регистра:** два байта, Big Endian. `0x2000` = 8192.

**Байты 5-6 — Значение:** всегда целое число 0–65535 (uint16). Дробей нет — ПЧ хранит целые, масштаб применяется через поле `scale`:
```
Стоп              value=0   → 00 00
Пуск              value=1   → 00 01
Частота 50 Гц     50/0.01=5000  → 13 88
Время разгона 15с 15/0.1=150   → 00 96
```

**Байты 7-8 — CRC16:** контрольная сумма всех предыдущих байт. ПЧ пересчитывает и сравнивает — если не совпало, пакет игнорируется. `modbus-serial` считает автоматически.

ПЧ отвечает эхом того же пакета = "принял, выполнил". При ошибке шлёт пакет с кодом причины.

---

## Полная цепочка записи — от клика до ПЧ

Пример: записываем время разгона F1.08 = 15 секунд (через REST — так работает `ParamRow.jsx`; подключение к порту при этом идёт отдельно, через WebSocket).

### Шаг 1 — Браузер (React, ParamRow.jsx)
```javascript
api.post('/modbus/write', {
  deviceId: 'elhart-emd-pump',
  paramId:  'F1.08',
  value:    15
})
// HTTP POST → http://localhost:5173/api/modbus/write
```

### Шаг 2 — Vite Proxy
```
/api/modbus/write → перенаправляет на → http://localhost:3000/modbus/write
```

### Шаг 3 — NestJS Controller (modbus.controller.ts)
```typescript
// 1. Находит устройство и параметр (мёрж шаблона + инстанса проекта)
device = devicesService.getById('elhart-emd-pump')
param  = devicesService.findParam('elhart-emd-pump', 'F1.08')
// → { register: 108, scale: 0.1 }

// 2. Проверяет право на запись через access_legend / access: 'read-write'
devicesService.isParamWritable(device, param)

// 3. Переводит значение пользователя в сырое число
rawValue = Math.round(15 / 0.1) = 150

// 4. Передаёт в сервис вместе со slaveId устройства
modbusService.writeRegister(108, 150, device.connection.slaveId)
```

### Шаг 4 — NestJS Service → modbus-serial
```typescript
// withLock(): setID + writeRegister — атомарно, под мьютексом
client.setID(slaveId)
client.writeRegister(108, 150)
// Библиотека собирает байты:
// 01  06  00 6C  00 96  XX XX
//         ^108   ^150   ^CRC
```

### Шаг 5 — Физическая передача
```
Байты → COM-порт → USB → EDC-A1-U1 → RS-485 провода A/B → ПЧ
```

### Шаг 6 — ПЧ принимает
```
Проверяет: Slave ID=01 (мне), функция=06 (писать),
регистр=108 (F1.08 "Время разгона"), CRC=ОК
Записывает: 150 × scale(0.1) = 15.0 секунд
Отвечает эхом: 01 06 00 6C 00 96 XX XX
```

### Шаг 7 — Ответ обратно в браузер
```
ПЧ → RS-485 → EDC-A1-U1 → USB → modbus-serial → NestJS
→ HTTP 200 { success: true } → axios → message.success('Записано')
```

---

## Детальная структура Backend (`backend/src/`)

### `devices/` — шаблоны + инстансы

**`device.types.ts`** — типы: `DeviceParam`, `ParamGroup`, `DeviceConnection`, `AlertRule` (`paramId`, `condition: gt|gte|lt|lte|eq|neq`, `threshold`, `level`, `message`), `DeviceConfig` (включает `template?`, `templateId?`, `errorCodes?`, `alerts?`, `access_legend?`).

**`devices.service.ts`**:
- `onModuleInit()` — грузит шаблоны из ДВУХ папок (`/devices/templates/` — поставка, `<userData>/templates/` — свои), запускает chokidar-слежку за ними, грузит инстансы активного проекта; подписывается на `projectsService.events('project:changed')`, чтобы перезагрузить инстансы при смене проекта
- `loadTemplateFile` / `startTemplateWatcher` — hot-reload шаблонов (`device:added/changed/removed`)
- `merge(instance)` — склеивает шаблон + инстанс в итоговый `DeviceConfig` (id/name/connection берутся из инстанса)
- `getAll()` / `getById(id)` / `findParam(deviceId, paramId)` — как раньше, но по объединённому набору (шаблоны + инстансы текущего проекта)
- `isParamWritable(device, param)` — если у шаблона есть `access_legend`, право на запись определяется по описанию (`!includes('только чтение')`), иначе — по `param.access === 'read-write'`
- `createDevice/updateDevice/deleteDevice` — CRUD инстансов внутри активного проекта, с проверкой уникальности `slaveId`
- `get/updateDevicePendingWrites`, `mergeDevicePendingWrites` (сливает patch в уже сохранённые значения по ключам, `null` — удалить ключ, не трогая остальные — используется групповой записью и применением шаблона), `get/updateDeviceCurrentValues`, `get/add/update/deleteDeviceNote` — сохраняемые в проект UI-данные конкретного устройства (несохранённые правки — «подготовленные значения», снятые значения, заметки). **`pendingWrites` хранится ПЕР УСТРОЙСТВО**, не общее на группу — при групповой записи каждый ПЧ пишет своё.
- `TEMPLATE_ALIASES` в `merge()` — резолвит устаревшие `templateId` (сейчас: `Elhart-Emd-VH-Full → Elhart-Emd-VL-Full`) на текущий шаблон, чтобы переименование модели не «теряло» инстансы в старых проектах

**`devices.controller.ts`** — REST: `GET /devices`, `GET /devices/:id`.

---

### `modbus/` — драйвер Modbus RTU

**`modbus.service.ts`**:
- `connect(opts)` / `disconnect()` / `isConnected()` / `getStatus()` — как раньше; `connect` умеет `dataBits`/`stopBits`/`parity`, не только `baudRate`
- Вотчдог (`startWatchdog`, каждые 3 сек проверяет `client.isOpen`) — при обрыве эмитит `connection:lost`, гейтвей на это событие запускает автопереподключение
- `readRegister(register, slaveId)` / `writeRegister(register, rawValue, slaveId)` — под мьютексом `withLock()`: `setID` + операция атомарно
- `listPorts()` — список COM-портов + флаг `busy` (пробует открыть порт с таймаутом)
- `identifyDevice(slaveId)` — эвристика определения модели (см. раздел про устройства выше), возвращает `'vl' | 'pump' | 'unknown'`
- `probeDevice(slaveId)` — пробует MEI/reportServerID (функции 43/17) с таймаутом — на практике почти всегда `error`, т.к. ELHART их не поддерживает; используется как диагностический инструмент, не как основной способ идентификации
- `scanBus(from, to, onProgress, isCancelled)` — перебирает slaveId в диапазоне, пробует регистр 0 (Pump) и `0xF000` (VL), с прогрессом и отменой
- `findAdapterPort(opts)` — автопоиск USB→RS-485 адаптера по VID (10c4/0403/1a86/067b/04d8) или имени производителя

**`modbus.controller.ts`** — REST (разовые операции, не основной канал управления):
- `GET /modbus/status`, `GET /modbus/ports`, `POST /modbus/scan`, `POST /modbus/connect { portPath, baudRate, dataBits, stopBits, parity }`, `POST /modbus/disconnect`, `POST /modbus/probe { slaveId }`
- `POST /modbus/read { deviceId, paramId }` → `{ paramId, rawValue, value, unit }`
- `POST /modbus/write { deviceId, paramId, value }` → проверяет `isParamWritable`, пишет `Math.round(value/scale)`
- Ошибки Modbus-исключений (коды 1–4) разворачиваются в понятный текст (`wrapModbusError`)

---

### `gateway/` — WebSocket (весь runtime здесь, не в REST)

**`modbus.gateway.ts`**:
- При старте (`onModuleInit`) пытается автоподключиться к порту, сохранённому для активного проекта
- `handleConnection` — новому клиенту сразу шлёт `devices:list`, `modbus:status`, и (если есть) `project:folder:mismatch`
- `connect:port` / `disconnect:port` — подключение/отключение порта, сохраняет выбор порта для активного проекта
- `project:select { id }` — переключение активного проекта: отключается от текущего порта, переключает проект в `ProjectsService`, пытается подключиться к сохранённому порту нового проекта (или просит выбрать порт вручную через `port:required`)
- Автопереподключение при обрыве связи (`connection:lost` → `startReconnect`, попытка раз в 5 сек) и «ожидание порта» если порт занят/недоступен при подключении (`startPortWatch`, раз в 1 сек)
- `bus:scan:start/cancel` — скан диапазона slaveId (на уже открытом порту), прогресс через `bus:scan:progress`, результат `bus:scan:done`
- `bus:autodetect:start { portPath, from?, to? }` / `bus:autodetect:cancel` — «умный автопоиск»: работает БЕЗ предварительного подключения. Перебирает типовые сочетания baudRate×dataBits×stopBits×parity (`ModbusService.autoDetectBus`, порядок: сначала все скорости на 8N1, потом чётность, потом 2 стоп-бита, потом 7 бит данных), на каждом сочетании быстро (150 мс/адрес) пробует первые несколько адресов запрошенного диапазона; как только что-то ответило — оставляет порт открытым с этой конфигурацией (`bus:autodetect:found { combo }`, сохраняет её как `projectConnection`) и сразу переиспользует обычный `scanBus` по всему диапазону (те же события `bus:scan:progress/done`, что и у ручного скана). Если ни одно сочетание не ответило — `bus:autodetect:notfound`
- `bus:identify:start { slaveIds }` — для каждого slaveId определяет модель (`identifyDevice`) и **автоматически создаёт инстанс устройства** из подходящего шаблона (`TEMPLATE_MAP: vl → Elhart-Emd-VL-Full, pump → Elhart-Emd-Pump-Full`)
- `monitor:start { deviceId, paramIds? }` / `monitor:stop { deviceId? }` — добавляет/убирает устройство в `monitoredDevices: Map<deviceId, {slaveId, params}>` и держит один непрерывный round-robin цикл (`ensureMonitorLoopRunning`, не по интервалу на устройство и не раз в секунду фиксированно) — проходит по кругу все замониторенные устройства подряд без искусственной задержки между ними, шлёт `monitor:data { deviceId, data }` по каждому сразу после чтения. Это специально самая быстрая возможная схема при данном ограничении: все запросы всё равно идут через общий мьютекс `ModbusService.withLock()` (одна физическая шина, один мастер), поэтому чем больше устройств/параметров замониторено одновременно, тем реже физически может обновляться конкретная колонка — это ограничение RS-485, не архитектуры. `monitor:stop` без `deviceId` останавливает всё сразу (используется при разрыве соединения/скане шины/смене проекта).
- `bulk:read:start { deviceIds, paramIds }` / `bulk:write:start { deviceIds, values? | usePending?, paramIds? }` — групповое чтение/запись параметров у нескольких устройств разом, прогресс через `bulk:op:progress` (по каждой паре deviceId×paramId) и `bulk:op:done { done, ok, total, cancelled }`; `bulk:op:cancel` останавливает между уже начатыми операциями. Запись поддерживает два режима: `values` — одинаковое значение всем устройствам (сброс до заводских); `usePending: true` — КАЖДОЕ устройство пишет свои собственные подготовленные значения (см. `pendingWrites` ниже), сервер сам вычисляет total и шлёт его через `bulk:op:total` (заранее неизвестен на фронте, т.к. у каждого устройства свой набор), успешно записанные параметры очищаются из pendingWrites этого устройства (`DevicesService.mergeDevicePendingWrites`)
- Слушает события `DevicesService` (`device:added/changed/removed/id:changed`, `devices:reloaded`) и `ProjectsService` (`project:folder:mismatch`, `projects:changed`) — транслирует их всем клиентам
- `ensureLivenessLoopRunning` — постоянный фоновый цикл (независимый от мониторинга), по кругу коротким таймаутом пингует (`ModbusService.probeAddress`) каждое устройство активного проекта и шлёт `device:liveness { deviceId, online }` только при смене статуса; новому клиенту при подключении сразу летит `devices:liveness:snapshot` с текущим состоянием всех. Общий статус порта (`modbus:status`) означает только «адаптер открыт», НЕ «это конкретное устройство отвечает» — на реальном железе устройство может быть выключено/отключено при исправном порте.

---

### `projects/` — проекты (наборы устройств на конкретной шине)

**`project.types.ts`** — `ProjectMeta`, `DeviceInstance` (`id, name, templateId, connection, pendingWrites?, currentValues?, notes?`), `ProjectFile` (`ProjectMeta + devices[]`), `ProjectMismatch` (расхождение имени папки/файла/содержимого).

**`projects.service.ts`**:
- Хранит проекты в `<userData>/projects/<id>/<id>.project.json` (`userData` = `process.env.USER_DATA_PATH` в Electron, иначе `../` от backend). В Electron это папка `data` РЯДОМ С EXE (`resolveDataDir`), с откатом на «Документы» и `%APPDATA%`, если писать туда нельзя. Деинсталлятор NSIS штатно сносит папку установки целиком (`RMDir /r $INSTDIR`), поэтому `build/installer.nsh` переопределяет макрос `customRemoveFiles` и обходит `data` стороной — иначе обновление версии стирало бы все проекты
- chokidar следит за папкой проектов — правки/переименования файла проекта снаружи (например, руками в проводнике) детектятся как «рассинхрон» (`checkMismatches`, опрос раз в 2 сек) и шлются на фронт (`project:folder:mismatch`) с возможностью автоисправить (`fixMismatch`, режимы `sync-to-folder`/`rename-to-content`)
- `listProjects/createProject/deleteProject/renameProject/importProject` — CRUD
- `getActiveProjectId/setActiveProject` — активный проект хранится в `SettingsService`
- `loadInstances/writeInstance/deleteInstance` — CRUD инстансов устройств внутри файла проекта

**`projects.controller.ts`** — REST для списка/создания/переименования/удаления/импорта проектов и выбора активного.

---

### `settings/` — настройки приложения

**`settings.service.ts`** — читает/пишет `<userData>/settings.json`: активный проект, сторона сайдбара, `theme` (`'light' | 'dark'`), `projectConnections` (последний использованный COM-порт на проект — для автоподключения), `deviceSettings` (порядок/видимость карточек монитора, ширины колонок — per-device UI-состояние; `pendingWrites` устройства хранятся отдельно в `DevicesService`, не здесь).

---

### `presets/` — шаблоны значений (пресеты)

**`presets.service.ts`** — хранит **глобально** (не в проекте — переживают смену проекта) в `<userData>/value-presets.json` именованные наборы `{ id, name, family: 'pump'|'vl', values: Record<paramId, number>, updatedAt }`. Это НЕ то же самое, что `pendingWrites` — пресет самостоятельная переиспользуемая сущность («прошивка для настройки насоса такого-то типа»), а `pendingWrites` — сиюминутный черновик конкретного устройства. Применение пресета (кнопка «Подготовить из шаблона» на вкладке «Параметры») копирует `preset.values` в `pendingWrites` выбранных устройств через `mergeDevicePendingWrites` — сам пресет не меняется, можно применять многократно, отдельные устройства потом можно поправить вручную поверх.

**`presets.controller.ts`** — REST: `GET /presets?family=`, `POST /presets`, `PATCH /presets/:id`, `DELETE /presets/:id`.

---

## Детальная структура Frontend (`frontend/src/`)

### Точки входа

**`main.jsx`** — монтирует `<App />` в DOM

**`socket.js`** — единственный экземпляр socket.io клиента, подключённого к `http://localhost:3000`

**`api.js`** — axios instance с `baseURL: '/api'` (Vite-proxy → `localhost:3000` в dev-режиме; в Electron/production бэкенд отдаёт и API, и статику фронта на одном порту 3000)

**`access.js`** — вспомогательная логика прав доступа к параметрам (см. `access_legend` в шаблоне устройства)

**`log.js`** — журнал событий приложения (используется `LogDrawer.jsx`)

**`useDeviceSettings.js`** — хук для чтения/сохранения per-device UI-настроек через `SettingsService` (порядок карточек, видимость, ширины колонок)

**`App.jsx`** — корневой компонент: состояние устройств/подключения/активного проекта/темы, слушает основные socket-события, рендерит layout (шапка с `ConnectionPanel`/`ProjectSelector`/переключателем темы, сайдбар со списком устройств, контент с деталями устройства). Оборачивает всё в `<ConfigProvider theme={{algorithm: light|dark}}>` — так перекрашиваются все antd-компоненты; структурные элементы с инлайн-цветом (Sider/Content) переопределяются через CSS `[data-theme='dark']` в `App.css` (инлайн-стили сильнее обычного CSS, поэтому там `!important`). Также хранит `activeDeviceTab` — общая для одиночного (`DeviceDetail`) и группового (`BulkPanel`) вида вкладка (Параметры/Мониторинг/Шаблоны), чтобы при переключении состава выделения (1 ПЧ ↔ несколько) активная вкладка не сбрасывалась.

**`monitorParams.js`** — общая для `Monitor.jsx` и `BulkMonitor.jsx` логика выбора и порядка параметров мониторинга: не просто «все read-параметры группы F0/D0 подряд», а курируемый порядок (частота/ток → сигналы FIV/FIC → температура/остальное → маска дискретных входов → код текущей аварии) с исключением малополезных для живого мониторинга полей (обратная связь ПИД, архивные записи истории аварий).

**`paramFormat.js`** — `formatParamValue(type, val, unit, options, bits)` — единая функция форматирования значения параметра по типу (`enum`→расшифровка через `options`, `bitmask`→строка `имя_бита:значение` через `bits`, `float`→2 знака, иначе как есть); используется везде, где значение параметра выводится вне `ParamRow` (`BulkPanel`, `Monitor`, `BulkMonitor`).

---

### `components/`

- **`ConnectionPanel.jsx`** — подключение к COM-порту: список портов, автопоиск адаптера (`/modbus/scan`), ручной выбор `baudRate`/`dataBits`/`stopBits`/`parity`, подключение/отключение через сокет (`connect:port`/`disconnect:port`)
- **`ProjectSelector.jsx`** — выбор/создание/переименование/удаление активного проекта, обработка `project:folder:mismatch`
- **`DeviceList.jsx`** — список устройств текущего проекта; клик по строке — тоггл выделения (мультивыбор), двойной клик — выделить ТОЛЬКО это устройство (сброс остального выделения); фильтр по типу (Pump/VL) автоматически снимает выделение со скрываемых устройств, чтобы после скрытия не оставалось невидимо выбранных ПЧ, которые потом путают сообщением о несовместимости типов в групповых операциях; per-device индикатор связи (`device:liveness`, зелёный/красный/синий «проверяется»)
- **`DeviceDetail.jsx`** — карточка одного устройства: вкладки «Параметры» (`ParamGroups`), «Мониторинг» (`Monitor`), «Шаблоны» (`ValuePresets`), инфо об устройстве (`DeviceInfo`), заметки (`DeviceNotes`); активная вкладка — контролируемый проп из `App.jsx` (`activeDeviceTab`)
- **`ParamGroups.jsx`** — дерево групп параметров; работает в двух режимах через проп `devices` (не передан → один `device`, одиночный режим; массив >1 → групповой). В групповом режиме есть переключатель «текущее устройство для правки» — у каждого ПЧ свои `pendingWrites` (подготовленные, но ещё не записанные значения), хранятся и подставляются в поля записи ПЕР УСТРОЙСТВУ (не общее значение на все сразу). Кнопка «Записать группу»/«Записать все» шлёт `bulk:write:start` с `usePending:true` — каждое устройство пишет СВОИ подготовленные значения, сервер очищает их после успешной записи. Кнопка «Подготовить из шаблона» открывает пикер пресетов (`/presets?family=`) и копирует значения в `pendingWrites` всех выбранных устройств. Чекбоксы видимости групп — сеткой по 3 в столбец для Pump, по 4 для VL (не горизонтальный перенос).
- **`ParamRow.jsx`** — одна строка параметра: чтение/запись одного регистра. Подготовленное значение (`pendingWriteValue`) подставляется в поле записи автоматически при получении (без отдельной кнопки восстановления).
- **`ValuePresets.jsx`** — вкладка «Шаблоны»: CRUD именованных пресетов значений на семейство ПЧ (Pump/VL). Новый пресет пуст; галочка на группе параметров разом добавляет в него все её регистры с заводскими значениями, каждое можно поправить или убрать из пресета отдельно.
- **`BulkPanel.jsx`** — групповой просмотр нескольких выбранных устройств: таблица результатов группового чтения + `ParamGroups`/`ValuePresets`/`BulkMonitor` на вкладках. Если выбраны ПЧ **разных семейств** (Pump и VL вперемешку) — вкладки «Параметры»/«Шаблоны» недоступны (разные карты регистров, групповая запись потенциально пишет не туда), активна только «Мониторинг»; попытка переключиться на недоступную вкладку блокируется с пояснением, а при появлении смешанного выбора активная вкладка сама переключается на «Мониторинг».
- **`ControlPanel.jsx`** — быстрые команды управления (пуск/стоп/направление/задание частоты) + текущий статус/ошибка устройства
- **`Monitor.jsx`** — реалтайм-мониторинг одного устройства: карточки со значениями (drag-n-drop порядок через `@dnd-kit`, графики через `recharts`, экспорт в CSV), параметры и их порядок — из `monitorParams.js`; параметры типа `bitmask` показываются не графиком, а тегами по каждому биту. Пороговые **оповещения** (`device.alerts`, см. ниже). Подсветка ошибки для параметров текущего кода аварии (`F0.27` у Pump, `FAULT_CODE`/`D0.45` у VL) — список id зашит в компоненте.
- **`BulkMonitor.jsx`** — мониторинг нескольких устройств: при однотипном выборе — одна таблица; при смешанном (Pump + VL) — своя таблица-секция на каждое семейство (у каждого своя карта параметров мониторинга), кнопка «Запустить» одна и стартует оба сразу
- **`BusScanner.jsx`** — UI для `bus:scan:*` (поиск устройств по диапазону slaveId) и `bus:identify:*` (автоопределение модели + создание устройства из шаблона)
- **`BackupRestore.jsx`** — экспорт/импорт проекта в файл
- **`DeviceInfo.jsx`** / **`DeviceNotes.jsx`** — карточка устройства (фото/схема подключения) и текстовые заметки, привязанные к инстансу
- **`LogDrawer.jsx`** — панель истории событий (`log.js`)

---

## Пороговые оповещения (`alerts`)

У каждого шаблона в `alerts: AlertRule[]` — правила вида «если `paramId` `condition` `threshold` → оповещение уровня `level` с текстом `message` (`{{value}}` подставляется)». Проверяются на фронте в `Monitor.jsx` (`checkAlerts`), только пока запущен мониторинг (`monitor:start`). **Это не то же самое, что словарь `errorCodes`** — оповещение просто сравнивает число с порогом и не обязано знать текстовое значение кода ошибки.

При добавлении/правке `alerts` в шаблоне — всегда проверяйте, что `paramId` существует именно в этом шаблоне (`groups[].params[].id`): скопированный между Pump и VL блок `alerts` с одинаковыми `paramId` — частая причина ложных срабатываний (например, `paramId`, который у одной модели означает температуру, у другой может означать наработку в часах или выходное напряжение — под тем же/похожим именем параметра могут скрываться разные регистры).

## Electron-упаковка

- `electron/main.js` — форкает `backend/dist/main.js` как дочерний Node-процесс (`ELECTRON_RUN_AS_NODE=1`), ждёт ответа `http://localhost:3000` (до 60 сек), открывает `BrowserWindow` на этот адрес; при ошибке показывает `dialog.showErrorBox` с последними строками stderr бэкенда
- `electron/afterPack.js` — копирует `backend/node_modules` (включая нативный `serialport`) в упакованное приложение, т.к. `electron-builder` по умолчанию их не включает
- Корневой `package.json` → `build` — конфиг `electron-builder`: `nsis` таргет для Windows, `extraResources` копирует `backend/` и `devices/` внутрь приложения
- `npm run build` → `build:frontend` (React → `backend/frontend-dist`) + `build:backend` (tsc → `backend/dist`)
- `npm run dist:win` → устанавливает `dist-electron/Modbus Controller Setup <версия>.exe` (NSIS-инсталлятор) и промежуточно `dist-electron/win-unpacked/Modbus Controller.exe` (нераспакованная сборка, тоже рабочая, без инсталляции — удобно для быстрой проверки)
- **Версия увеличивается на каждой сборке** — `dist:*` начинается с `scripts/bump-version.js`, который правит `version` в корневом `package.json`. Разряды десятичные, НЕ semver: 1.0.9 → 1.1.0 → 1.9.9 → 2.0.0. Один и тот же номер видно в трёх местах: имя инсталлятора (electron-builder), шапка программы (`__APP_VERSION__` — Vite `define` из корневого `package.json`, см. `frontend/vite.config.js`) и «Справка → О программе» (`app.getVersion()`). Правя версию руками, помните: фронт узнаёт её только при пересборке.
- **Окно без рамки Windows** (`frame: false`): роль заголовка играет шапка приложения (`.app-header-desktop` в `App.css` — `-webkit-app-region: drag`, всё нажимаемое внутри помечено `no-drag`), кнопки свернуть/развернуть/закрыть рисует `WindowControls.jsx` и шлёт их в главный процесс через `preload.js` → `windowControls`. Меню приложения скрыто (`autoHideMenuBar`), показывается по Alt. Наличие `window.modbusDesktop` — признак «мы в программе, а не в браузере»: в браузерном режиме кнопки окна не рисуются и шапка не таскает окно.
