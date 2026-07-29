import { useState, useEffect, useRef } from 'react'
import { Space, Typography, Tag, Alert, message, Tabs, Table, Button, Tooltip, Popconfirm, Progress, Modal } from 'antd'
import { CloseOutlined, ClearOutlined, DownloadOutlined, UploadOutlined, LoadingOutlined, WarningOutlined } from '@ant-design/icons'
import socket from '../socket'
import ParamGroups from './ParamGroups'
import BulkMonitor from './BulkMonitor'
import Monitor from './Monitor'
import ValuePresets from './ValuePresets'
import { useDeviceSettings } from '../useDeviceSettings'
import { formatParamValue } from '../paramFormat'
import { downloadCsv, groupFileLabel } from '../csv'
import { processStart, processDone, processInfo, processError } from '../notify'
import OverwriteGuard, { collectOverwriteConflicts } from './OverwriteGuard'
import api from '../api'
import { addLog } from '../log'
import { stopOnlyParamsOf, statusParamId, isRunningFromStatus, stopCommandValue } from '../driveControl'
import { parseParamsCsv } from '../csvImport'
import { ALL_DEVICES } from './ParamGroups'

// Pump-Full и Pump-OWN — один и тот же физический ПЧ, у OWN просто урезанный
// (но регистрово идентичный) набор параметров — сверено вручную: все параметры
// OWN присутствуют в Full с теми же номерами регистров. Групповые операции между
// ними безопасны, поэтому они считаются одним "семейством". VL — другая карта
// регистров, отдельное семейство.
function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

function formatResult(entry) {
  if (!entry) return <span style={{ color: '#bbb' }}>—</span>
  if (entry.error) {
    return (
      <Tooltip title={entry.error}>
        <span style={{ color: '#ff4d4f', fontSize: 12, cursor: 'help', textDecoration: 'underline dotted' }}>ошибка</span>
      </Tooltip>
    )
  }
  return <span>{formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits)}</span>
}

const TAB_LABELS = { params: 'Параметры', templates: 'Шаблоны' }

export default function BulkPanel({ devices, modbusConnected, onDeselect, activeTab, onActiveTabChange, focusedDeviceId, onFocusDevice, focusedDevice, locked = false, lockLabel = '' }) {
  const templateIds = [...new Set(devices.map(d => d.templateId))]
  const families = [...new Set(devices.map(d => deviceFamily(d.templateId)))]
  const sameType = families.length === 1
  // Устройство с наибольшим числом параметров в выборке (напр. Full среди Full+OWN) —
  // используется как эталон для отображения групп, чтобы не потерять группы,
  // которых нет у "урезанного" варианта.
  const templateDevice = devices.reduce((best, d) => (
    d.groups.flatMap(g => g.params).length > best.groups.flatMap(g => g.params).length ? d : best
  ), devices[0])

  const [deviceSettings, saveDeviceSettings] = useDeviceSettings(sameType ? templateDevice.templateId : '__mixed__')
  const [visibleGroupIds, setVisibleGroupIds] = useState(new Set())
  const [bulkReadResults, setBulkReadResults] = useState({}) // { [deviceId]: { [paramId]: { value/error, unit, name } } }
  const [bulkOpBar, setBulkOpBar] = useState(null) // { kind:'read'|'write', done, total } — полоса прогресса НАД таблицей
  // locked в ref — эффекты очистки читают актуальное значение, не перезапускаясь
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const [busy, setBusy] = useState(false) // идёт «Записать всё» / «Скачать всё» (для блокировки кнопок)
  const [guard, setGuard] = useState(null) // { conflicts, uncheckedCount } — предупреждение о перезаписи
  const [guardReading, setGuardReading] = useState(false) // идёт «считать все и сравнить» из окна предупреждения
  const [stopGuard, setStopGuard] = useState(null) // { statuses, running, unknown, skip } — нужен останов ПЧ
  const [stopping, setStopping] = useState(false)
  const importInputRef = useRef(null)
  const [importPreview, setImportPreview] = useState(null) // разбор CSV до применения
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!sameType || deviceSettings === null) return
    setVisibleGroupIds(
      deviceSettings.visibleGroups
        ? new Set(deviceSettings.visibleGroups)
        : new Set(templateDevice.groups.map(g => g.id)),
    )
  }, [deviceSettings, sameType])

  const deviceIds = devices.map(d => d.id)

  // Что именно мониторим: в режиме «Все выбранные ПЧ» — всю группу, иначе —
  // только тот ПЧ, что выбран одиночным кликом/переключателем (он может быть и
  // вне группы). Если ничего не выбрано, остаётся вся группа.
  const monitoredDevices = (() => {
    if (!focusedDeviceId || focusedDeviceId === ALL_DEVICES) return devices
    const inGroup = devices.find(d => d.id === focusedDeviceId)
    if (inGroup) return [inGroup]
    if (focusedDevice) return [focusedDevice]
    return devices
  })()

  // Разные типы ПЧ вперемешку — групповая настройка параметров лишена смысла
  // (разные карты регистров), но мониторинг каждого по своей карте — вполне
  // безопасен и полезен, поэтому доступна только вкладка "Мониторинг".
  useEffect(() => {
    // Смешанный выбор: уводим на мониторинг только с «Шаблонов» (они реально
    // невозможны). «Параметры» остаются — там показывается ПЧ, выбранный
    // одиночным кликом.
    if (!sameType && activeTab === 'templates') onActiveTabChange('monitor')
  }, [sameType])

  function handleTabChange(key) {
    if (locked) {
      message.warning(`Идёт ${lockLabel || 'операция'} — дождитесь завершения или нажмите «Остановить»`)
      return
    }
    if (!sameType && key === 'templates') {
      message.warning('Шаблоны требуют устройств одного семейства (Pump или VL) — при смешанном выборе они недоступны')
      return
    }
    onActiveTabChange(key)
  }

  // Сбрасываем накопленные результаты чтения при смене состава выбранных
  // устройств — но НЕ во время самой операции: иначе уже прочитанная часть
  // таблицы обнулялась на лету и продолжала заполняться с середины.
  useEffect(() => {
    if (lockedRef.current) return
    setBulkReadResults({})
  }, [deviceIds.join(',')])

  // Групповое чтение теперь целиком выполняется внутри ParamGroups через
  // WebSocket (bulk:read:start) — сюда прилетают те же самые прогресс-события
  // просто чтобы построить таблицу "по устройствам" отдельно от собственного
  // (одноколоночного) отображения ParamGroups.
  // Единый пассивный слушатель групповых операций: держит полосу прогресса НАД
  // таблицей (task: прогресс сверху) и копит результаты чтения ПАЧКАМИ (не на
  // каждый параметр — при сотнях регистров это тормозило бы таблицу), сбрасывая
  // накопленное в состояние не чаще ~1 раза в 80 мс.
  useEffect(() => {
    let done = 0
    let flushTimer = null
    const acc = {} // { [deviceId]: { [paramId]: entry } }
    function flush() {
      flushTimer = null
      if (Object.keys(acc).length === 0) return
      // Копию накопителя снимаем ДО очистки: updater в setState вызывается
      // отложенно (на рендере), и если очистить acc сразу, он увидит пустой
      // объект — часть прочитанных значений просто исчезала из таблицы
      // (те самые прочерки у одного ПЧ при заполненной колонке у другого).
      const batch = {}
      for (const [dId, vals] of Object.entries(acc)) batch[dId] = { ...vals }
      for (const k of Object.keys(acc)) delete acc[k]
      setBulkReadResults(prev => {
        const next = { ...prev }
        for (const [dId, vals] of Object.entries(batch)) next[dId] = { ...next[dId], ...vals }
        return next
      })
    }
    function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 80) }
    function onTotal(t) { setBulkOpBar({ kind: t.kind, done, total: t.total }) }
    function onProgress(p) {
      if (!deviceIds.includes(p.deviceId)) return
      done++
      setBulkOpBar(prev => ({ kind: p.kind, done, total: prev?.total ?? 0 }))
      if (p.kind === 'read') {
        acc[p.deviceId] = {
          ...(acc[p.deviceId] || {}),
          [p.paramId]: p.error
            ? { error: p.error, name: p.name }
            : { value: p.value, unit: p.unit, name: p.name, type: p.type, options: p.options, bits: p.bits },
        }
        schedule()
      }
    }
    function onDone() {
      if (flushTimer) clearTimeout(flushTimer)
      flush()
      setBulkOpBar(null)
      done = 0
    }
    function onError() { setBulkOpBar(null); done = 0 }
    socket.on('bulk:op:total', onTotal)
    socket.on('bulk:op:progress', onProgress)
    socket.on('bulk:op:done', onDone)
    socket.on('bulk:op:error', onError)
    return () => {
      socket.off('bulk:op:total', onTotal)
      socket.off('bulk:op:progress', onProgress)
      socket.off('bulk:op:done', onDone)
      socket.off('bulk:op:error', onError)
      if (flushTimer) clearTimeout(flushTimer)
    }
  }, [deviceIds.join(',')])

  function handleVisibleGroupIdsChange(next) {
    setVisibleGroupIds(next)
    saveDeviceSettings({ visibleGroups: Array.from(next) })
    // При любом изменении набора отображаемых групп таблицу результатов чтения
    // очищаем целиком — даже если это та же самая единственная группа, что и
    // была, старые значения не должны "мелькать" до нового чтения.
    setBulkReadResults({})
  }

  const paramToGroup = new Map() // paramId -> { id, name }
  if (sameType) {
    for (const g of templateDevice.groups) {
      for (const p of g.params) paramToGroup.set(p.id, { id: g.id, name: g.name })
    }
  }

  // Показываем только параметры групп, которые СЕЙЧАС отмечены галочками —
  // если группу сняли с отображения (или она уже не в выборке), её старые
  // результаты чтения пропадают из таблицы сами, без явной очистки состояния
  // (что удобно: если галочку вернуть обратно, кэш уже тут).
  const readResultParamIds = [...new Set(devices.flatMap(d => Object.keys(bulkReadResults[d.id] ?? {})))]
    .filter(paramId => visibleGroupIds.has(paramToGroup.get(paramId)?.id))
  const templateParamOrder = sameType ? templateDevice.groups.flatMap(g => g.params.map(p => p.id)) : []
  const readResultRows = readResultParamIds
    .slice()
    .sort((a, b) => templateParamOrder.indexOf(a) - templateParamOrder.indexOf(b))

  // CSV группы доступен, только когда КАЖДАЯ отображаемая группа считана у
  // КАЖДОГО выбранного ПЧ (сначала считка — потом скачивание).
  const visibleGroupsList = sameType ? templateDevice.groups.filter(g => visibleGroupIds.has(g.id)) : []
  const groupCsvReady = visibleGroupsList.length > 0 && devices.every(d =>
    visibleGroupsList.every(g => g.params.some(p => bulkReadResults[d.id]?.[p.id] != null)),
  )

  const readResultsColumns = [
    {
      title: 'Параметр',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 220,
      render: (name, row) => row.isGroupHeader
        ? <Typography.Text strong style={{ fontSize: 12 }}>{row.groupName}</Typography.Text>
        : name,
    },
    ...devices.map(d => ({
      title: (
        <div>
          <div style={{ fontSize: 12 }}>{d.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>Адрес {d.connection.slaveId}</Typography.Text>
        </div>
      ),
      dataIndex: d.id,
      key: d.id,
      width: 130,
      render: (_, row) => (row.isGroupHeader ? null : formatResult(bulkReadResults[d.id]?.[row.paramId])),
    })),
  ]

  const readResultsDataSource = []
  let lastGroupName = null
  for (const paramId of readResultRows) {
    const groupName = paramToGroup.get(paramId)?.name ?? ''
    if (groupName !== lastGroupName) {
      readResultsDataSource.push({ key: `group-header-${groupName || paramId}`, isGroupHeader: true, groupName })
      lastGroupName = groupName
    }
    const name = devices.map(d => bulkReadResults[d.id]?.[paramId]?.name).find(Boolean) ?? paramId
    readResultsDataSource.push({ key: paramId, paramId, name })
  }

  // Экспорт всей таблицы группового чтения (все выбранные устройства сразу) —
  // по колонке на каждый ПЧ, строки-заголовки групп сохраняются. Это то, чего
  // не даёт per-device "Скачать CSV" на вкладке "Параметры" (тот выгружает
  // только одно устройство).
  function exportGroupCsv() {
    const header = ['Параметр', 'Название', ...devices.map(d => `${d.name} (Адрес ${d.connection.slaveId})`)]
    const rows = []
    let lastGroup = null
    for (const paramId of readResultRows) {
      const groupName = paramToGroup.get(paramId)?.name ?? ''
      if (groupName !== lastGroup) {
        rows.push([groupName, '', ...devices.map(() => '')])
        lastGroup = groupName
      }
      const name = devices.map(d => bulkReadResults[d.id]?.[paramId]?.name).find(Boolean) ?? paramId
      const cells = devices.map(d => {
        const entry = bulkReadResults[d.id]?.[paramId]
        if (!entry) return ''
        if (entry.error) return 'ошибка'
        // Битовые маски форматируются с переносами строк — в CSV это ломает
            // строку (парсер читает файл построчно), поэтому склеиваем в одну.
            return String(formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits)).replace(/\n/g, '; ')
      })
      rows.push([paramId, name, ...cells])
    }
    // Имя файла = какие группы считаны + семейство + адреса всех выбранных ПЧ:
    // "F0-EMD-PUMP-1-4", "F0-F3-EMD-PUMP-1-4", "All-Param-EMD-PUMP-1-4".
    const presentGroups = templateDevice.groups
      .filter(g => g.params.some(p => readResultRows.includes(p.id)))
    const groupPart = presentGroups.length === templateDevice.groups.length
      ? 'All-Param'
      : (presentGroups.map(groupFileLabel).join('-') || 'params')
    const familyLabel = families[0] === 'vl' ? 'EMD-VL' : 'EMD-PUMP'
    // Номера ПЧ через запятую (1,7 — это ПЧ №1 и №7), а НЕ через дефис (1-7
    // читалось бы как диапазон 1..7).
    const nums = devices.map(d => d.connection.slaveId).join(',')
    downloadCsv(
      `${groupPart}-${familyLabel}-${nums}.csv`,
      header,
      rows,
    )
  }

  // Одна кнопка «Записать подготовленное во все выбранные ПЧ»: каждый ПЧ пишет
  // СВОИ подготовленные значения (колонка «Значение для записи» / pendingWrites),
  // независимо от того, Pump это или VL — сервер берёт pendingWrites каждого
  // устройства по его собственной карте регистров. Работает и для смешанного
  // выбора Pump+VL, поэтому кнопка живёт над вкладками и доступна всегда.
  // Перед реальной записью проверяем, не затрут ли ЗАВОДСКИЕ значения (те, что
  // шаблон не задаёт) уже настроенные параметры на ПЧ. Если да — показываем
  // список и даём выбрать, что перезаписывать.
  // «Сначала считать все параметры и сравнить» из окна предупреждения: читаем
  // с каждого ПЧ его собственную карту (сервер попутно сохраняет значения в
  // «значение на устройстве»), затем пересобираем сравнение уже по полным данным.
  function readAllThenRecheck() {
    setGuardReading(true)
    const paramsByDevice = Object.fromEntries(
      devices.map(d => [d.id, d.groups.flatMap(g => g.params.map(p => p.id))]),
    )
    const key = processStart(`Чтение всех параметров с ${devices.length} ПЧ для сравнения…`, 'Опрос ПЧ')
    function cleanup() {
      socket.off('bulk:op:done', onDone)
      socket.off('bulk:op:error', onError)
      setGuardReading(false)
    }
    async function onDone(d) {
      if (d.kind !== 'read') return
      cleanup()
      processDone(key, `Считано ${d.ok} из ${d.total} — сравнение обновлено`)
      addLog('success', `Считаны все параметры с ${devices.length} ПЧ перед записью (${d.ok}/${d.total})`)
      setGuard(null)
      await checkAndWriteAll() // пересобрать конфликты уже по свежим данным
    }
    function onError(e) {
      cleanup()
      processError(key, e?.message ?? 'Не удалось считать параметры')
    }
    socket.on('bulk:op:done', onDone)
    socket.on('bulk:op:error', onError)
    socket.emit('bulk:read:start', { deviceIds, paramsByDevice })
  }

  async function checkAndWriteAll() {
    setBusy(true)
    try {
      const [effective, raw] = await Promise.all([
        Promise.all(devices.map(d => api.get(`/devices/${d.id}/pending-writes`).then(r => [d.id, r.data ?? {}]).catch(() => [d.id, {}]))),
        Promise.all(devices.map(d => api.get(`/devices/${d.id}/pending-writes/raw`).then(r => [d.id, r.data ?? {}]).catch(() => [d.id, {}]))),
      ])
      const values = Object.fromEntries(effective)
      // Покрытые шаблоном/ручной правкой — их изменение ожидаемо, не предупреждаем.
      const covered = new Set(raw.flatMap(([, v]) => Object.keys(v)))
      // Что реально известно с ПЧ: последние прочитанные значения.
      const known = {}
      for (const d of devices) {
        const fromTable = Object.fromEntries(
          Object.entries(bulkReadResults[d.id] ?? {})
            .filter(([, e]) => e && !e.error && typeof e.value === 'number')
            .map(([pid, e]) => [pid, e.value]),
        )
        const stored = await api.get(`/devices/${d.id}/current-values`).then(r => r.data ?? {}).catch(() => ({}))
        known[d.id] = { ...stored, ...fromTable }
      }
      const paramsById = new Map(devices.flatMap(d => d.groups.flatMap(g => g.params)).map(p => [p.id, p]))
      const conflicts = collectOverwriteConflicts({ devices, values, known, coveredParamIds: covered, paramsById })
      const totalUnchecked = devices.reduce((sum, d) => {
        const vals = values[d.id] ?? {}
        return sum + Object.keys(vals).filter(pid => !covered.has(pid) && known[d.id]?.[pid] === undefined).length
      }, 0)
      // Окно показываем не только когда нашли конфликты, но и когда часть
      // параметров вообще не читалась: молча записать заводское поверх
      // неизвестного — как раз то, чего нужно избежать.
      if (conflicts.length > 0 || totalUnchecked > 0) {
        setBusy(false)
        setGuard({ conflicts, uncheckedCount: totalUnchecked })
        return
      }
      setBusy(false)
      await startWriteWithStopCheck({})
    } catch {
      setBusy(false)
      message.error('Не удалось проверить подготовленные значения')
    }
  }

  // Перед записью проверяем, нет ли среди записываемых параметров таких, что
  // меняются ТОЛЬКО на остановленном приводе (у VL это access "X"; у Pump таких
  // в документации нет). Если есть и ПЧ сейчас работает — спрашиваем, а не
  // останавливаем молча. Если таких параметров нет — привод не трогаем вовсе.
  async function startWriteWithStopCheck(skip = {}) {
    try {
      const pend = await Promise.all(devices.map(d =>
        api.get(`/devices/${d.id}/pending-writes`).then(r => [d.id, r.data ?? {}]).catch(() => [d.id, {}]),
      ))
      const needStop = [] // [{ device, params: [...] }]
      for (const [id, vals] of pend) {
        const device = devices.find(d => d.id === id)
        if (!device) continue
        const ids = Object.keys(vals).filter(pid => !(skip[id] ?? []).includes(pid))
        const stopOnly = stopOnlyParamsOf(device, ids)
        if (stopOnly.length) needStop.push({ device, params: stopOnly })
      }
      if (needStop.length === 0) { writeAllPrepared(skip); return }

      // Узнаём, какие из них реально вращаются прямо сейчас.
      const statuses = await Promise.all(needStop.map(async ({ device, params }) => {
        const value = await api.post('/modbus/read', { deviceId: device.id, paramId: statusParamId() })
          .then(r => r.data?.value).catch(() => null)
        return { device, params, running: isRunningFromStatus(device, value) }
      }))
      const running = statuses.filter(s => s.running === true)
      const unknown = statuses.filter(s => s.running === null)
      if (running.length === 0 && unknown.length === 0) { writeAllPrepared(skip); return }
      setStopGuard({ statuses, running, unknown, skip })
    } catch {
      message.error('Не удалось проверить состояние ПЧ перед записью')
    }
  }

  // Остановить работающие ПЧ (мягкая остановка) и продолжить запись.
  async function stopRunningAndWrite() {
    const g = stopGuard
    if (!g) return
    setStopping(true)
    try {
      for (const { device } of g.running) {
        await api.post('/modbus/write', {
          deviceId: device.id, paramId: 'CMD', value: stopCommandValue(device),
        }).catch(() => {})
        addLog('warning', `Подана команда остановки перед записью: ${device.name} (Адрес ${device.connection.slaveId})`)
      }
      // Приводу нужно время на торможение по рампе, иначе запись «только на
      // остановленном» ещё отвалится по ошибке доступа.
      await new Promise(r => setTimeout(r, 1500))
      setStopGuard(null)
      writeAllPrepared(g.skip)
    } finally {
      setStopping(false)
    }
  }

  // Записать только то, что можно менять на ходу — работающие ПЧ не трогаем.
  function writeOnlySafe() {
    const g = stopGuard
    if (!g) return
    const skip = { ...g.skip }
    for (const { device, params } of g.statuses) {
      // пропускаем «только на остановленном» у ВСЕХ проверенных ПЧ, чтобы
      // результат был предсказуемым, а не зависел от момента опроса статуса
      skip[device.id] = [...(skip[device.id] ?? []), ...params.map(p => p.id)]
    }
    setStopGuard(null)
    writeAllPrepared(skip)
  }

  // ─── Импорт CSV в подготовленные значения ────────────────────────────────
  // Ничего не пишем в устройства: файл лишь заполняет колонку «Значение для
  // записи». Сначала показываем разбор (сколько применится, что не разобралось),
  // и только по подтверждению сохраняем.
  function handleImportFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // чтобы повторный выбор того же файла тоже сработал
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseParamsCsv(String(reader.result ?? ''), devices)
        if (parsed.stats.matchedColumns === 0) {
          message.error('В файле не найдено ни одной колонки с ПЧ из текущего выбора. Проверьте, что это файл, скачанный кнопкой «Скачать все параметры в CSV», и что адреса совпадают.')
          return
        }
        setImportPreview({ fileName: file.name, ...parsed })
      } catch (err) {
        message.error(`Не удалось разобрать файл: ${err?.message ?? err}`)
      }
    }
    reader.onerror = () => message.error('Не удалось прочитать файл')
    reader.readAsText(file, 'utf-8')
  }

  async function applyImport() {
    if (!importPreview) return
    setImporting(true)
    try {
      const entries = Object.entries(importPreview.byDevice)
      await Promise.all(entries.map(([id, values]) =>
        api.patch(`/devices/${id}/pending-writes`, { merge: true, pendingWrites: values }).catch(() => {}),
      ))
      const total = importPreview.stats.applied
      message.success(`Подготовлено ${total} значений у ${entries.length} ПЧ — проверьте колонку «Значение для записи» и запишите обычной кнопкой`)
      addLog('success', `Импорт CSV «${importPreview.fileName}»: подготовлено ${total} значений у ${entries.length} ПЧ`)
      window.dispatchEvent(new CustomEvent('pending-writes:changed', { detail: { deviceIds: entries.map(([id]) => id) } }))
      setImportPreview(null)
    } finally {
      setImporting(false)
    }
  }

  function writeAllPrepared(skip = {}) {
    setBusy(true)
    const key = processStart(`Запись подготовленных значений во все выбранные ПЧ (${deviceIds.length})…`, 'Запись в ПЧ')
    function cleanup() {
      socket.off('bulk:op:done', onDone)
      socket.off('bulk:op:error', onError)
      setBusy(false)
    }
    function onDone(d) {
      if (d.kind !== 'write') return
      cleanup()
      if (d.total === 0) { message.info('Ни у одного выбранного ПЧ нет подготовленных значений для записи'); processInfo(key, 'Нет подготовленных значений для записи') }
      else if (d.cancelled) { message.warning(`Остановлено: записано ${d.ok} из ${d.total}`); processInfo(key, `Остановлено: записано ${d.ok} из ${d.total}`) }
      else { message.success(`Записано ${d.ok} из ${d.total} подготовленных значений (${deviceIds.length} ПЧ)`); processDone(key, `Записано ${d.ok} из ${d.total} значений в ${deviceIds.length} ПЧ`) }
    }
    function onError(e) { cleanup(); message.error(e?.message ?? 'Групповая операция уже выполняется'); processError(key, e?.message ?? 'Групповая операция уже выполняется') }
    socket.on('bulk:op:done', onDone)
    socket.on('bulk:op:error', onError)
    socket.emit('bulk:write:start', { deviceIds, usePending: true, skip })
  }

  // Task: общая кнопка «Скачать все параметры с выбранных ПЧ» — работает и для
  // смешанного выбора Pump+VL. Сначала считываем ВСЕ параметры каждого ПЧ (сервер
  // сам пропускает параметры, которых у устройства нет), затем автоматически
  // формируем и скачиваем CSV: секция на каждое семейство (у Pump и VL разные
  // карты регистров), внутри — по колонке на каждый ПЧ.
  function downloadAllParams() {
    setBusy(true)
    const key = processStart(`Чтение всех параметров с ${deviceIds.length} ПЧ…`, 'Опрос ПЧ')
    const collected = {} // { [deviceId]: { [paramId]: entry } }
    // У каждого ПЧ читаем ТОЛЬКО его собственные параметры (у Pump и VL разные
    // карты регистров) — иначе половина запросов уходит впустую и прогресс
    // показывает завышенный total вроде «600 из 1200».
    const paramsByDevice = Object.fromEntries(
      devices.map(d => [d.id, d.groups.flatMap(g => g.params.map(p => p.id))]),
    )
    function onProgress(p) {
      if (p.kind !== 'read' || !deviceIds.includes(p.deviceId)) return
      collected[p.deviceId] = {
        ...(collected[p.deviceId] || {}),
        [p.paramId]: p.error ? { error: p.error } : { value: p.value, unit: p.unit, type: p.type, options: p.options, bits: p.bits },
      }
    }
    function cleanup() {
      socket.off('bulk:op:progress', onProgress)
      socket.off('bulk:op:done', onDone)
      socket.off('bulk:op:error', onError)
      setBusy(false)
    }
    function onDone(d) {
      if (d.kind !== 'read') return
      cleanup()
      if (d.cancelled) { message.info(`Остановлено: считано ${d.ok} из ${d.total}`); processInfo(key, `Остановлено: считано ${d.ok} из ${d.total}`); return }
      buildAndDownloadAllCsv(collected)
      message.success(`Считаны все параметры (${d.ok}/${d.total}). CSV скачан.`)
      processDone(key, `Считаны все параметры с ${deviceIds.length} ПЧ — CSV скачан`, 'Готово, файл скачан')
    }
    function onError(e) { cleanup(); message.error(e?.message ?? 'Групповая операция уже выполняется'); processError(key, e?.message ?? 'Групповая операция уже выполняется') }
    socket.on('bulk:op:progress', onProgress)
    socket.on('bulk:op:done', onDone)
    socket.on('bulk:op:error', onError)
    socket.emit('bulk:read:start', { deviceIds, paramsByDevice })
  }

  // Отдельная таблица на каждое семейство: у Pump и VL разные карты регистров,
  // поэтому колонки VL-устройств в Pump-таблице были бы полностью пустыми (и
  // наоборот). Секции идут одна под другой в одном файле, у каждой — своя
  // строка заголовков со своим набором колонок.
  function buildAndDownloadAllCsv(collected) {
    const maxCols = Math.max(...families.map(f => devices.filter(d => deviceFamily(d.templateId) === f).length))
    const pad = arr => [...arr, ...Array(Math.max(0, maxCols + 2 - arr.length)).fill('')]
    const rows = []
    let first = true
    for (const fam of families) {
      const famDevices = devices.filter(d => deviceFamily(d.templateId) === fam)
      if (famDevices.length === 0) continue
      // Эталон семейства — с самой полной картой параметров.
      const famTemplate = famDevices.reduce((best, d) => (
        d.groups.flatMap(g => g.params).length > best.groups.flatMap(g => g.params).length ? d : best
      ), famDevices[0])
      if (!first) rows.push(pad([]))
      first = false
      rows.push(pad([`=== ${fam === 'vl' ? 'EMD-VL' : 'EMD-PUMP'} (${famDevices.length} ПЧ) ===`]))
      rows.push(pad(['Параметр', 'Название', ...famDevices.map(d => `${d.name} (Адрес ${d.connection.slaveId})`)]))
      for (const g of famTemplate.groups) {
        rows.push(pad([g.name]))
        for (const param of g.params) {
          const cells = famDevices.map(d => {
            const entry = collected[d.id]?.[param.id]
            if (!entry) return ''
            if (entry.error) return 'ошибка'
            // Битовые маски форматируются с переносами строк — в CSV это ломает
            // строку (парсер читает файл построчно), поэтому склеиваем в одну.
            return String(formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits)).replace(/\n/g, '; ')
          })
          rows.push(pad([param.id, param.name, ...cells]))
        }
      }
    }
    const nums = devices.map(d => d.connection.slaveId).join(',')
    // Заголовок файла общий-технический; настоящие заголовки — внутри секций.
    downloadCsv(`All-Param-${nums}.csv`, pad(['Параметр', 'Название']), rows)
  }

  // BulkPanel не имеет вкладок "Устройство"/"Журнал" (это данные конкретного
  // ПЧ, не группы) — если пришли сюда из одиночного просмотра, откатываемся на
  // "Параметры".
  let tabKey = ['params', 'monitor', 'templates'].includes(activeTab) ? activeTab : 'params'
  // «Шаблоны» при смешанном выборе невозможны — подстраховка на случай, если
  // вкладка осталась активной с прошлого (однотипного) выбора.
  if (!sameType && tabKey === 'templates') tabKey = 'monitor'

  const items = [
    {
      key: 'params',
      // При смешанном выборе групповые операции невозможны (разные карты
      // регистров), но ПОСМОТРЕТЬ параметры конкретного ПЧ можно — вкладка
      // остаётся доступной, если одиночным кликом выбран конкретный ПЧ.
      label: <span style={{ opacity: (sameType || focusedDevice) ? 1 : 0.4 }}>{TAB_LABELS.params}</span>,
      children: !sameType ? (
        focusedDevice ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              type="info"
              showIcon
              message={`Просмотр параметров: ${focusedDevice.name} · Адрес ${focusedDevice.connection.slaveId}`}
              description="Выбраны ПЧ разных типов, поэтому групповые чтение/запись недоступны — показаны параметры одного устройства, отмеченного одиночным кликом. Значения можно читать и писать по отдельным строкам."
            />
            <ParamGroups
              key={focusedDevice.id}
              device={focusedDevice}
              modbusConnected={modbusConnected}
              groupOpsEnabled={false}
            />
          </Space>
        ) : (
          <Alert
            type="warning"
            showIcon
            message="Выбраны ПЧ разных типов"
            description="Групповые операции с параметрами недоступны — у Pump и VL разные карты регистров. Нажмите одиночным кликом на нужный ПЧ в списке слева, чтобы посмотреть и править его параметры по отдельности."
          />
        )
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {readResultRows.length > 0 && (
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Typography.Text strong style={{ fontSize: 12 }}>Результаты группового чтения</Typography.Text>
                <Button
                  size="small"
                  icon={<ClearOutlined />}
                  onClick={() => setBulkReadResults({})}
                >
                  Очистить
                </Button>
                <Tooltip title={groupCsvReady
                  ? 'Скачать таблицу отображаемых групп по всем выбранным ПЧ в CSV'
                  : 'Сначала считайте все отображаемые группы у всех выбранных ПЧ — потом станет доступно скачивание'}>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    disabled={!groupCsvReady}
                    onClick={exportGroupCsv}
                  >
                    Скачать CSV группы
                  </Button>
                </Tooltip>
              </Space>
              <Table
                size="small"
                pagination={false}
                bordered
                scroll={{ x: 'max-content', y: 'calc(100vh - 280px)' }}
                rowClassName={row => (row.isGroupHeader ? 'group-header-row' : '')}
                columns={readResultsColumns}
                dataSource={readResultsDataSource}
              />
            </div>
          )}
          <ParamGroups
            device={templateDevice}
            devices={devices}
            modbusConnected={modbusConnected}
            visibleGroupIds={visibleGroupIds}
            onVisibleGroupIdsChange={handleVisibleGroupIdsChange}
            focusedDeviceId={focusedDeviceId}
            onFocusDevice={onFocusDevice}
            focusedDevice={focusedDevice}
          />
        </Space>
      ),
    },
    {
      key: 'monitor',
      label: 'Мониторинг',
      // Мониторим то же, с чем работаем: конкретный выбранный ПЧ (в т.ч. вне
      // группы) — только его; режим «Все выбранные ПЧ» — всю группу. Раньше
      // мониторинг всегда шёл по группе, даже когда одиночным кликом выбран
      // другой ПЧ, и было непонятно, чьи это показания.
      children: monitoredDevices.length === 1
        ? <Monitor device={monitoredDevices[0]} modbusConnected={modbusConnected} />
        : <BulkMonitor devices={monitoredDevices} modbusConnected={modbusConnected} sameType={sameType} />,
    },
    {
      key: 'templates',
      label: <span style={{ opacity: sameType ? 1 : 0.4 }}>{TAB_LABELS.templates}</span>,
      children: !sameType ? null : <ValuePresets device={templateDevice} devices={devices} />,
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Typography.Text strong>Выбрано:</Typography.Text>
        <Space wrap size={4}>
          {devices.map(d => (
            <Tag
              key={d.id}
              color={sameType ? 'blue' : 'orange'}
              closable
              closeIcon={<CloseOutlined />}
              onClose={() => onDeselect(d.id)}
            >
              {d.name} · Адрес {d.connection.slaveId}
            </Tag>
          ))}
        </Space>
      </div>

      {/* Главные кнопки сценария «на объекте». Пояснение — НАД кнопками, а не
          справа от них: справа оно оказывалось рядом с посторонними кнопками
          (например «Прочитать все» для одного семейства) и читалось как их
          описание. */}
      <div style={{ marginBottom: 16, padding: '8px 10px', border: '1px solid #f0f0f0', borderRadius: 6 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          Действуют на ПЧ, <b>отмеченные галочками</b> — сейчас их {devices.length}
          {' '}({devices.map(d => `№${d.connection.slaveId}`).join(', ')}).
          Чтобы обработать все ПЧ проекта, сначала нажмите «Выбрать все» в списке слева.
          Типы можно смешивать: Pump и VL обрабатываются каждый по своей карте регистров.
        </Typography.Text>
        {/* Порядок кнопок = порядок работы: сначала считать и выгрузить,
            потом подготовить значения, и только в конце записать в ПЧ. */}
        <Space wrap>
          <Tooltip title="Считать ВСЕ параметры с каждого выбранного ПЧ и сразу скачать общий CSV (Pump и VL — отдельными секциями в файле)">
            <Button
              icon={<DownloadOutlined />}
              disabled={!modbusConnected || busy || !!bulkOpBar}
              loading={busy}
              onClick={downloadAllParams}
            >
              1. Скачать все параметры в CSV ({devices.length})
            </Button>
          </Tooltip>
          <Tooltip title="Загрузить ранее скачанный CSV с исправленными значениями — они станут подготовленными значениями соответствующих ПЧ (сопоставление по адресу на шине). Запись в устройства при этом не выполняется.">
            <Button
              icon={<UploadOutlined />}
              disabled={busy || !!bulkOpBar}
              onClick={() => importInputRef.current?.click()}
            >
              2. Подготовить значения из CSV
            </Button>
          </Tooltip>
          <Popconfirm
            title="Записать подготовленные значения"
            description={`Каждый из ${devices.length} выбранных ПЧ получит СВОИ подготовленные значения (колонка «Значение для записи»). Идёт реальная запись регистров в устройства.`}
            okText="Записать"
            cancelText="Отмена"
            okButtonProps={{ danger: true }}
            disabled={!modbusConnected || busy || !!bulkOpBar}
            onConfirm={checkAndWriteAll}
          >
            <Button
              type="primary"
              icon={<UploadOutlined />}
              disabled={!modbusConnected || busy || !!bulkOpBar}
              loading={busy}
            >
              3. Записать подготовленное во все выбранные ({devices.length})
            </Button>
          </Popconfirm>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </Space>
      </div>

      {/* Прогресс и «Остановить» — отдельным блоком, чтобы пояснение про работу
          с разными типами ПЧ не воспринималось как описание текущей операции
          (групповое чтение идёт по ПЧ одного семейства). */}
      <div style={{ marginBottom: 16 }}>
        {(busy || bulkOpBar) && (
          <Button danger onClick={() => socket.emit('bulk:op:cancel')}>Остановить</Button>
        )}
        {/* Полоса прогресса — СВЕРХУ, выше таблицы с данными. */}
        {bulkOpBar && (
          bulkOpBar.total > 0 ? (
            <Progress
              style={{ marginTop: 8 }}
              size="small"
              status="active"
              percent={Math.round((bulkOpBar.done / bulkOpBar.total) * 100)}
              format={() => `${bulkOpBar.kind === 'write' ? 'Запись' : 'Чтение'}: ${bulkOpBar.done} из ${bulkOpBar.total}`}
            />
          ) : (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12, color: '#faad14' }}>
              <LoadingOutlined spin /> {bulkOpBar.kind === 'write' ? 'Запись' : 'Чтение'}: обработано {bulkOpBar.done} параметров…
            </Typography.Text>
          )
        )}
      </div>

      {/* Общее предупреждение о смешанном выборе показываем только там, где оно
          к месту: на «Параметрах» своё, более конкретное (см. вкладку). */}
      {!sameType && tabKey === 'monitor' && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="Выбраны ПЧ разных типов"
          description={`Выбраны устройства разных семейств (${templateIds.join(', ')}) — у них разные карты регистров, поэтому ГРУППОВЫЕ чтение/запись параметров и шаблоны недоступны. Мониторинг работает: показания каждого семейства выводятся отдельным блоком по своей карте параметров. Параметры отдельного ПЧ можно посмотреть на вкладке «Параметры», выбрав его одиночным кликом в списке слева. Pump-Full и Pump-OWN между собой совместимы — это один и тот же ПЧ с урезанным набором параметров.`}
        />
      )}

      <Tabs activeKey={tabKey} onChange={handleTabChange} items={items} />

      <OverwriteGuard
        open={!!guard}
        conflicts={guard?.conflicts ?? []}
        uncheckedCount={guard?.uncheckedCount ?? 0}
        reading={guardReading}
        onReadAll={readAllThenRecheck}
        onCancel={() => setGuard(null)}
        onConfirm={skip => { setGuard(null); startWriteWithStopCheck(skip) }}
      />

      {/* Разбор загруженного CSV — показываем ДО применения: сколько значений
          ляжет в подготовленные, по каким ПЧ, и что не разобралось. */}
      <Modal
        title={<Space><UploadOutlined />Подготовить значения из CSV</Space>}
        open={!!importPreview}
        onCancel={() => setImportPreview(null)}
        onOk={applyImport}
        okText={`Подготовить ${importPreview?.stats?.applied ?? 0} значений`}
        okButtonProps={{ loading: importing, disabled: !importPreview?.stats?.applied }}
        cancelText="Отмена"
        width={780}
      >
        <Alert
          type={importPreview?.stats?.applied ? 'info' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message={`Файл: ${importPreview?.fileName ?? ''}`}
          description={
            <>
              Будет подготовлено <b>{importPreview?.stats?.applied ?? 0}</b> значений
              у <b>{importPreview?.stats?.devices ?? 0}</b> ПЧ (колонок сопоставлено
              по адресу: {importPreview?.stats?.matchedColumns ?? 0}).
              {' '}Значения попадут в колонку «Значение для записи» — <b>в устройства
              ничего не пишется</b>, записать нужно будет отдельной кнопкой.
            </>
          }
        />
        {importPreview?.unmatchedColumns?.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Часть колонок пропущена"
            description={importPreview.unmatchedColumns.join('; ')}
          />
        )}
        {importPreview?.issues?.length > 0 && (
          <>
            <Typography.Text strong style={{ fontSize: 12 }}>
              Не разобрано ({importPreview.issues.length}) — эти значения останутся без изменений:
            </Typography.Text>
            <Table
              size="small"
              style={{ marginTop: 6 }}
              pagination={{ pageSize: 6, size: 'small' }}
              rowKey={(r, i) => `${r.deviceName}-${r.paramId}-${i}`}
              dataSource={importPreview.issues}
              columns={[
                { title: 'ПЧ', dataIndex: 'deviceName', width: 150, render: (v, r) => `${v} (${r.slaveId})` },
                { title: 'Параметр', width: 200, render: (_, r) => `${r.paramId} ${r.name ?? ''}` },
                { title: 'Причина', dataIndex: 'message' },
              ]}
            />
          </>
        )}
      </Modal>

      {/* Часть параметров меняется только на остановленном приводе. Останавливаем
          не «на всякий случай», а лишь когда такие параметры реально есть в
          записи и ПЧ сейчас вращается. */}
      <Modal
        title={<Space><WarningOutlined style={{ color: '#faad14' }} />Для записи нужен остановленный ПЧ</Space>}
        open={!!stopGuard}
        onCancel={() => setStopGuard(null)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setStopGuard(null)}>Отмена</Button>,
          <Button key="safe" onClick={writeOnlySafe}>
            Записать только то, что можно на ходу
          </Button>,
          <Button key="stop" type="primary" danger loading={stopping} onClick={stopRunningAndWrite}>
            Остановить {stopGuard?.running?.length ? `(${stopGuard.running.length} ПЧ)` : ''} и записать всё
          </Button>,
        ]}
      >
        <Typography.Paragraph style={{ fontSize: 13 }}>
          Среди подготовленных значений есть параметры, которые ПЧ разрешает менять
          <b> только когда привод остановлен</b>. Если записать их на ходу, устройство
          вернёт ошибку доступа и значения не применятся.
        </Typography.Paragraph>
        {stopGuard?.running?.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="Сейчас вращаются"
            description={
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {stopGuard.running.map(({ device, params }) => (
                  <li key={device.id} style={{ fontSize: 12 }}>
                    <b>{device.name}</b> · Адрес {device.connection.slaveId} — требуют остановки: {params.length} парам.
                    {' '}<Typography.Text type="secondary">({params.slice(0, 6).map(p => p.id).join(', ')}{params.length > 6 ? '…' : ''})</Typography.Text>
                  </li>
                ))}
              </ul>
            }
          />
        )}
        {stopGuard?.unknown?.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 10 }}
            message="Состояние не удалось прочитать"
            description={`Не ответили на запрос статуса: ${stopGuard.unknown.map(s => s.device.name).join(', ')}. Возможно, они остановлены — но проверить нечем.`}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          «Остановить и записать всё» — подаст команду плавной остановки (торможение
          с замедлением) только тем ПЧ, что сейчас вращаются, подождёт полторы секунды
          и запишет все значения. Обратно приводы <b>не запускаются</b> — пуск остаётся
          за вами. «Записать только то, что можно на ходу» — приводы не трогаем,
          параметры «только на остановленном» пропускаем.
        </Typography.Paragraph>
      </Modal>
    </div>
  )
}
