import { useState, useEffect, useRef } from 'react'
import { Space, Typography, Tag, Alert, message, Tabs, Table, Button, Tooltip, Popconfirm, Progress } from 'antd'
import { CloseOutlined, ClearOutlined, DownloadOutlined, UploadOutlined, LoadingOutlined } from '@ant-design/icons'
import socket from '../socket'
import ParamGroups from './ParamGroups'
import BulkMonitor from './BulkMonitor'
import ValuePresets from './ValuePresets'
import { useDeviceSettings } from '../useDeviceSettings'
import { formatParamValue } from '../paramFormat'
import { downloadCsv, groupFileLabel } from '../csv'
import { processStart, processDone, processInfo, processError } from '../notify'
import OverwriteGuard, { collectOverwriteConflicts } from './OverwriteGuard'
import api from '../api'

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

  useEffect(() => {
    if (!sameType || deviceSettings === null) return
    setVisibleGroupIds(
      deviceSettings.visibleGroups
        ? new Set(deviceSettings.visibleGroups)
        : new Set(templateDevice.groups.map(g => g.id)),
    )
  }, [deviceSettings, sameType])

  const deviceIds = devices.map(d => d.id)

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
      setBulkReadResults(prev => {
        const next = { ...prev }
        for (const [dId, vals] of Object.entries(acc)) next[dId] = { ...next[dId], ...vals }
        return next
      })
      for (const k of Object.keys(acc)) delete acc[k]
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
        return String(formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits))
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
      if (conflicts.length > 0) {
        setBusy(false)
        setGuard({ conflicts, uncheckedCount: totalUnchecked })
        return
      }
      writeAllPrepared({})
    } catch {
      setBusy(false)
      message.error('Не удалось проверить подготовленные значения')
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
            return String(formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits))
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
      children: <BulkMonitor devices={devices} modbusConnected={modbusConnected} sameType={sameType} />,
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
        <Space wrap>
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
              Записать подготовленное во все выбранные ({devices.length})
            </Button>
          </Popconfirm>
          <Tooltip title="Считать ВСЕ параметры с каждого выбранного ПЧ и сразу скачать общий CSV (Pump и VL — отдельными секциями в файле)">
            <Button
              icon={<DownloadOutlined />}
              disabled={!modbusConnected || busy || !!bulkOpBar}
              loading={busy}
              onClick={downloadAllParams}
            >
              Скачать все параметры в CSV ({devices.length})
            </Button>
          </Tooltip>
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
        onCancel={() => setGuard(null)}
        onConfirm={skip => { setGuard(null); writeAllPrepared(skip) }}
      />
    </div>
  )
}
