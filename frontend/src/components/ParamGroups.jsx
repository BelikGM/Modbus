import { useState, useRef, useCallback, useEffect } from 'react'
import { Collapse, Button, Input, message, Typography, Popconfirm, Space, Modal, Checkbox, Progress, Select } from 'antd'
import { DownloadOutlined, SearchOutlined, RollbackOutlined, HolderOutlined, UploadOutlined, FileTextOutlined } from '@ant-design/icons'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import ParamRow from './ParamRow'
import api from '../api'
import socket from '../socket'
import { useDeviceSettings } from '../useDeviceSettings'
import { isParamWritable } from '../access'
import { downloadCsv, groupFileLabel } from '../csv'

// Значение/запись специально не растянуты "с запасом" — короткие значения
// (типично "—" пока не считано, или пара символов/цифр) не должны тянуть за
// собой пустое место и толкать последующие колонки за край экрана. При
// необходимости колонку всегда можно расширить вручную (перетаскиванием).
const DEFAULT_COLS = { id: 90, desc: 220, def: 110, cur: 110, write: 220 }
const MIN_COLS     = { id: 60, desc: 100, def: 70,  cur: 80,  write: 160 }

function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

function SortableCollapseItem({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: 'relative',
      }}
    >
      <div
        {...attributes}
        {...listeners}
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'grab', zIndex: 2, color: '#bbb',
        }}
        title="Перетащить группу"
      >
        <HolderOutlined style={{ fontSize: 12 }} />
      </div>
      {children}
    </div>
  )
}

function HeaderCell({ label, width, onResizeStart, marginLeft, divider = true }) {
  return (
    <div style={{
      position: 'relative', width, flexShrink: 0, paddingRight: 10, paddingLeft: 4,
      boxSizing: 'border-box', marginLeft,
      borderRight: divider ? '1px solid rgba(120,120,120,0.2)' : 'none',
    }}>
      <Typography.Text style={{
        fontSize: 11, color: '#888', fontWeight: 600, userSelect: 'none',
        display: 'block', textAlign: 'center', lineHeight: 1.3,
      }}>
        {label}
      </Typography.Text>
      <div
        onMouseDown={onResizeStart}
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 5,
          cursor: 'col-resize',
          borderRight: '2px solid transparent',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderRightColor = '#1677ff' }}
        onMouseLeave={e => { e.currentTarget.style.borderRightColor = 'transparent' }}
      />
    </div>
  )
}

function ParamTableHeader({ cols, onResizeStart }) {
  return (
    <div className="param-table-header" style={{
      display: 'flex', alignItems: 'center',
      padding: '6px 4px',
      minHeight: 40,
      background: '#fafafa',
      borderBottom: '2px solid #e8e8e8',
      borderTop: '1px solid #e8e8e8',
      position: 'sticky', top: 0, zIndex: 1,
    }}>
      <HeaderCell label="Параметр / Адрес"      width={cols.id}    onResizeStart={onResizeStart('id')} />
      <HeaderCell label="Описание параметра"     width={cols.desc}  onResizeStart={onResizeStart('desc')} />
      <HeaderCell label="Заводское значение"     width={cols.def}   onResizeStart={onResizeStart('def')} />
      <HeaderCell label="Значение на устройстве" width={cols.cur}   onResizeStart={onResizeStart('cur')} marginLeft={20} />
      <HeaderCell label="Значение для записи"    width={cols.write} onResizeStart={onResizeStart('write')} marginLeft={20} divider={false} />
    </div>
  )
}

export default function ParamGroups({
  device, devices, modbusConnected, deviceRunning, onWrite,
  visibleGroupIds: controlledVisibleGroupIds, onVisibleGroupIdsChange,
}) {
  // В одиночном режиме (DeviceDetail) `devices` не передаётся — работаем с одним
  // `device`. В групповом (BulkPanel) `devices` — полный список выбранных ПЧ
  // одного семейства; `device` при этом — "эталон" с самой полной картой
  // регистров (для отображения групп/параметров), а подготовленные значения у
  // каждого устройства свои — редактируются по одному через переключатель ниже.
  const effectiveDevices = devices ?? [device]
  const effectiveDeviceIds = effectiveDevices.map(d => d.id)
  const isBulk = effectiveDevices.length > 1
  const [activeDeviceId, setActiveDeviceId] = useState(effectiveDeviceIds[0])
  // Спец-значение переключателя «текущее устройство для правки»: правки
  // подготовленных значений применяются сразу ко ВСЕМ выбранным ПЧ.
  const ALL_DEVICES = '__all__'
  const isAllMode = isBulk && activeDeviceId === ALL_DEVICES
  useEffect(() => {
    if (activeDeviceId !== ALL_DEVICES && !effectiveDeviceIds.includes(activeDeviceId)) setActiveDeviceId(effectiveDeviceIds[0])
    setBulkResults({}) // сменился состав выборки — старые групповые результаты не актуальны
  }, [effectiveDeviceIds.join(',')])
  // В режиме «Все» показываем как образец эталонное устройство (с самой полной
  // картой), а правки пишем во все; в обычном — выбранное устройство.
  const activeDevice = isAllMode ? device : (effectiveDevices.find(d => d.id === activeDeviceId) ?? effectiveDevices[0])
  const displayDeviceId = isAllMode ? device.id : activeDeviceId

  const [readingGroup, setReadingGroup] = useState(null)
  const [groupValues, setGroupValues]   = useState({})
  const [search, setSearch]             = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [groupProgress, setGroupProgress] = useState(null) // { index, total, groupName, kind }
  const [opProgress, setOpProgress] = useState(null) // { done, total } — живой прогресс текущего runBulkOp
  const [openGroupIds, setOpenGroupIds] = useState(() => new Set())
  const latestGroupValues = useRef({})

  // Переключение на другое устройство (одиночный вид — сменили выбор в
  // списке слева; групповой — сменили в переключателе "текущее устройство
  // для правки") должно сворачивать все раскрытые группы, а не тянуть за
  // собой раскрытые группы предыдущего устройства и не открывать первую
  // группу автоматически.
  useEffect(() => {
    setOpenGroupIds(new Set())
  }, [activeDeviceId])

  const expandGroup = useCallback((groupId) => {
    setOpenGroupIds(prev => (prev.has(groupId) ? prev : new Set(prev).add(groupId)))
  }, [])

  const clearGroupValue = useCallback((paramId) => {
    setGroupValues(prev => {
      const next = { ...prev }
      delete next[paramId]
      return next
    })
  }, [])
  const [cols, setCols]             = useState(DEFAULT_COLS)
  const [groupOrder, setGroupOrder] = useState(null)
  const isGroupVisibilityControlled = controlledVisibleGroupIds !== undefined
  const [ownVisibleGroupIds, setOwnVisibleGroupIds] = useState(new Set(device.groups.map(g => g.id)))
  const visibleGroupIds = isGroupVisibilityControlled ? controlledVisibleGroupIds : ownVisibleGroupIds
  const [pendingWrites, setPendingWrites] = useState({})
  const [pendingVersion, setPendingVersion] = useState(0) // растёт при смене устройства/применении шаблона — форсирует переинициализацию полей записи в ParamRow
  const [currentValues, setCurrentValues] = useState({})
  // Результаты последнего группового чтения ПЕР УСТРОЙСТВО ({ [deviceId]: { [paramId]: value } }).
  // Нужны, чтобы per-device "Скачать CSV" в групповом режиме выгружал именно то
  // устройство, что выбрано в переключателе, а не первое (у которого раньше
  // остались сохранённые currentValues).
  const [bulkResults, setBulkResults] = useState({})
  const [currentFillStamp] = useState(0)
  const [presetModalOpen, setPresetModalOpen] = useState(false)
  const [presets, setPresets] = useState([])
  const [selectedPresetId, setSelectedPresetId] = useState(null)
  const [applyingPreset, setApplyingPreset] = useState(false)
  const latestCols = useRef(DEFAULT_COLS)
  const latestCurrentValues = useRef({})
  const currentSaveTimer = useRef(null)
  const resizing = useRef(null)

  const [deviceSettings, saveDeviceSettings] = useDeviceSettings(device.templateId ?? device.id)

  useEffect(() => {
    if (deviceSettings === null) return
    if (deviceSettings.paramColWidths) {
      const c = { ...DEFAULT_COLS, ...deviceSettings.paramColWidths }
      setCols(c)
      latestCols.current = c
    }
    setGroupOrder(deviceSettings.groupOrder ?? null)
    if (!isGroupVisibilityControlled) {
      setOwnVisibleGroupIds(
        deviceSettings.visibleGroups
          ? new Set(deviceSettings.visibleGroups)
          : new Set(device.groups.map(g => g.id)),
      )
    }
  }, [deviceSettings])

  function toggleGroupVisible(groupId, checked) {
    const next = new Set(visibleGroupIds)
    if (checked) next.add(groupId)
    else next.delete(groupId)
    if (isGroupVisibilityControlled) {
      onVisibleGroupIdsChange(next)
    } else {
      setOwnVisibleGroupIds(next)
      saveDeviceSettings({ visibleGroups: Array.from(next) })
    }
  }

  function setAllGroupsVisible(checked) {
    const next = checked ? new Set(device.groups.map(g => g.id)) : new Set()
    setVisibleGroups(next)
  }

  function setVisibleGroups(next) {
    if (isGroupVisibilityControlled) {
      onVisibleGroupIdsChange(next)
    } else {
      setOwnVisibleGroupIds(next)
      saveDeviceSettings({ visibleGroups: Array.from(next) })
    }
  }

  // Подготовленные значения (черновик) и последние прочитанные — хранятся на
  // бэке ПЕР УСТРОЙСТВО. В групповом режиме показываем/редактируем черновик
  // ТЕКУЩЕГО выбранного в переключателе устройства; при переключении между
  // устройствами каждое хранит и подставляет своё собственное значение.
  useEffect(() => {
    setPendingWrites({})
    setCurrentValues({})
    let cancelled = false
    api.get(`/devices/${displayDeviceId}/pending-writes`)
      .then(({ data }) => {
        if (cancelled) return
        setPendingWrites(data ?? {})
        setPendingVersion(v => v + 1)
      })
      .catch(() => {})
    api.get(`/devices/${displayDeviceId}/current-values`)
      .then(({ data }) => {
        if (cancelled) return
        const cv = data ?? {}
        setCurrentValues(cv)
        latestCurrentValues.current = cv
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeDeviceId])

  const handlePendingWriteChange = useCallback((paramId, val) => {
    setPendingWrites(prev => ({ ...prev, [paramId]: val }))
    if (isAllMode) {
      // Одним запросом — во все выбранные ПЧ (сервер сохраняет проект один раз).
      api.patch('/devices/pending-writes/bulk', { deviceIds: effectiveDeviceIds, pendingWrites: { [paramId]: val } }).catch(() => {})
    } else {
      api.patch(`/devices/${activeDeviceId}/pending-writes`, { merge: true, pendingWrites: { [paramId]: val } }).catch(() => {})
    }
  }, [activeDeviceId, isAllMode, effectiveDeviceIds.join(',')])

  const handleReadValue = useCallback((paramId, val) => {
    setCurrentValues(prev => {
      const next = { ...prev, [paramId]: val }
      latestCurrentValues.current = next
      return next
    })
    // Держим значение и в per-device карте — на неё опирается колонка "Значение
    // на устройстве" и per-device CSV в групповом режиме (одиночное чтение строки
    // тоже должно там отражаться, не только групповое).
    setBulkResults(prev => ({
      ...prev,
      [displayDeviceId]: { ...prev[displayDeviceId], [paramId]: val },
    }))
    if (currentSaveTimer.current) clearTimeout(currentSaveTimer.current)
    currentSaveTimer.current = setTimeout(() => {
      api.patch(`/devices/${displayDeviceId}/current-values`, { currentValues: latestCurrentValues.current }).catch(() => {})
    }, 500)
  }, [activeDeviceId, displayDeviceId])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const orderedGroups = groupOrder
    ? [...device.groups].sort((a, b) => {
        const ai = groupOrder.indexOf(a.id)
        const bi = groupOrder.indexOf(b.id)
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
      })
    : device.groups

  const groupsInScope = orderedGroups.filter(g => visibleGroupIds.has(g.id))

  function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedGroups.findIndex(g => g.id === active.id)
    const newIndex = orderedGroups.findIndex(g => g.id === over.id)
    const newOrder = arrayMove(orderedGroups, oldIndex, newIndex).map(g => g.id)
    setGroupOrder(newOrder)
    saveDeviceSettings({ groupOrder: newOrder })
  }

  const startResize = useCallback((key) => (e) => {
    e.preventDefault()
    resizing.current = { key, startX: e.clientX, startW: cols[key] }

    function onMove(e) {
      if (!resizing.current) return
      const { key, startX, startW } = resizing.current
      const newW = Math.max(MIN_COLS[key], startW + e.clientX - startX)
      setCols(prev => {
        const next = { ...prev, [key]: newW }
        latestCols.current = next
        return next
      })
    }
    function onUp() {
      resizing.current = null
      saveDeviceSettings({ paramColWidths: latestCols.current })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [cols])

  const bulkCancelRef = useRef(false)

  function stopGroupedOperation() {
    bulkCancelRef.current = true
    socket.emit('bulk:op:cancel')
  }

  // Единый механизм группового чтения/записи: один WebSocket-запрос, сервер сам
  // проходит по всем (устройство × параметр) и шлёт прогресс по каждому — вместо
  // отдельного HTTP-запроса на каждую пару с фронта (было в разы медленнее и
  // "Остановить" реагировало только между уже запущенными HTTP-вызовами).
  //
  // Запись поддерживает два режима payload:
  //  - массив paramIds (чтение)
  //  - { usePending: true, paramIds } — запись per-device подготовленных значений
  //    (сервер сам берёт pendingWrites каждого устройства и очищает записанное)
  //  - обычный объект { paramId: value } — запись ОДИНАКОВЫХ значений всем
  //    устройствам (используется только для сброса до заводских)
  function runBulkOp(kind, ids, payload) {
    const knownTotal = kind === 'read'
      ? ids.length * payload.length
      : (payload?.usePending ? null : ids.length * Object.keys(payload).length)
    setOpProgress({ done: 0, total: knownTotal ?? 0 })
    return new Promise(resolve => {
      let done = 0
      function onTotal(t) {
        if (t.kind !== kind) return
        setOpProgress({ done, total: t.total })
      }
      function onProgress(p) {
        if (p.kind !== kind || !ids.includes(p.deviceId)) return
        done++
        setOpProgress(prev => ({ done, total: prev?.total ?? done }))
        if (!p.error) {
          setGroupValues(prev => {
            const next = { ...prev, [p.paramId]: p.value }
            latestGroupValues.current = next
            return next
          })
          // Копим результаты по каждому устройству отдельно — на них опирается
          // per-device экспорт CSV (groupValues же общий и перетирается
          // последним устройством в круге, для CSV он не годится).
          setBulkResults(prev => ({
            ...prev,
            [p.deviceId]: { ...prev[p.deviceId], [p.paramId]: p.value },
          }))
        }
      }
      function onDone(d) {
        if (d.kind !== kind) return
        socket.off('bulk:op:total', onTotal)
        socket.off('bulk:op:progress', onProgress)
        socket.off('bulk:op:done', onDone)
        setOpProgress(null)
        resolve(d)
      }
      socket.on('bulk:op:total', onTotal)
      socket.on('bulk:op:progress', onProgress)
      socket.on('bulk:op:done', onDone)
      if (kind === 'read') socket.emit('bulk:read:start', { deviceIds: ids, paramIds: payload })
      else if (payload?.usePending) socket.emit('bulk:write:start', { deviceIds: ids, usePending: true, paramIds: payload.paramIds })
      else socket.emit('bulk:write:start', { deviceIds: ids, values: payload })
    })
  }

  async function readGroup(group, e, { autoExpand = true } = {}) {
    e?.stopPropagation()
    if (autoExpand) expandGroup(group.id)
    setReadingGroup(group.id)
    const paramIds = group.params.map(p => p.id)
    const result = await runBulkOp('read', effectiveDeviceIds, paramIds)
    setReadingGroup(null)
    if (result.cancelled) message.info(`Остановлено: группа «${group.name}» прочитана частично (${result.ok}/${result.total})`)
    else message.success(`Группа «${group.name}» прочитана (${result.ok}/${result.total})`)
    if (effectiveDeviceIds.length === 1) {
      const merged = { ...latestCurrentValues.current }
      for (const paramId of paramIds) {
        if (latestGroupValues.current[paramId] !== undefined) merged[paramId] = latestGroupValues.current[paramId]
      }
      setCurrentValues(merged)
      latestCurrentValues.current = merged
      api.patch(`/devices/${activeDeviceId}/current-values`, { currentValues: merged }).catch(() => {})
    }
  }

  // Запись группы: каждое устройство пишет СВОИ подготовленные значения этой
  // группы (не общее значение с экрана) — то, что реально нужно, если часть
  // выбранных ПЧ отличается от остальных.
  async function writeGroup(group, e, { autoExpand = true } = {}) {
    e?.stopPropagation()
    if (autoExpand) expandGroup(group.id)
    setReadingGroup(group.id)
    const paramIds = group.params.filter(p => isParamWritable(device, p)).map(p => p.id)
    const result = await runBulkOp('write', effectiveDeviceIds, { usePending: true, paramIds })
    setReadingGroup(null)
    if (result.total === 0) message.info(`В группе «${group.name}» ни у одного устройства нет подготовленных значений для записи`)
    else if (result.cancelled) message.info(`Остановлено: группа «${group.name}» записана частично (${result.ok}/${result.total})`)
    else message.success(`Записано ${result.ok} из ${result.total} (группа «${group.name}»)`)
    setPendingVersion(v => v + 1)
  }

  async function processAllGroups(kind) {
    if (groupsInScope.length === 0) {
      message.info('Нет отображаемых групп — отметьте хотя бы одну галочкой ниже')
      return
    }
    bulkCancelRef.current = false
    let processed = 0
    for (let i = 0; i < groupsInScope.length; i++) {
      if (bulkCancelRef.current) break
      const group = groupsInScope[i]
      setGroupProgress({ index: i, total: groupsInScope.length, groupName: group.name, kind })
      const fakeEvent = { stopPropagation: () => {} }
      // При "Прочитать/Записать/Сбросить всё" группы НЕ разворачиваются одна за
      // другой по ходу цикла — иначе к концу открытыми оказываются вообще все
      // группы, страница расползается. Значения всё равно попадают в
      // currentValues/groupValues независимо от того, открыта группа или нет.
      const opts = { autoExpand: false }
      if (kind === 'read') await readGroup(group, fakeEvent, opts)
      else if (kind === 'write') await writeGroup(group, fakeEvent, opts)
      else await resetGroup(group, fakeEvent, opts)
      processed++
    }
    setGroupProgress(null)
    if (bulkCancelRef.current) {
      message.info(`Остановлено: обработано ${processed} из ${groupsInScope.length} групп`)
    }
  }

  async function resetGroup(group, e, { autoExpand = true } = {}) {
    e?.stopPropagation()
    const toWrite = group.params.filter(
      p => isParamWritable(device, p) && p.default !== undefined && p.default !== null && typeof p.default === 'number'
    )
    if (toWrite.length === 0) {
      message.info('Нет параметров с заводскими значениями')
      return
    }
    if (autoExpand) expandGroup(group.id)
    setReadingGroup(group.id)
    const values = {}
    for (const p of toWrite) values[p.id] = p.default
    const result = await runBulkOp('write', effectiveDeviceIds, values)
    setReadingGroup(null)
    if (result.cancelled) message.info(`Остановлено: группа «${group.name}» сброшена частично (${result.ok}/${result.total})`)
    else message.success(`Сброшено ${result.ok} из ${result.total} параметров группы ${group.name}`)
  }

  // ─── Шаблоны значений (пресеты) ────────────────────────────────────────────

  const family = deviceFamily(device.templateId ?? device.id)

  async function openPresetModal() {
    setSelectedPresetId(null)
    setPresetModalOpen(true)
    try {
      const { data } = await api.get('/presets', { params: { family } })
      setPresets(data)
    } catch {
      setPresets([])
    }
  }

  async function applyPreset() {
    const preset = presets.find(p => p.id === selectedPresetId)
    if (!preset) return
    setApplyingPreset(true)
    try {
      await Promise.all(effectiveDeviceIds.map(id =>
        api.patch(`/devices/${id}/pending-writes`, { merge: true, pendingWrites: preset.values }).catch(() => {})
      ))
      message.success(`Шаблон «${preset.name}» применён к ${effectiveDeviceIds.length} устр. — значения подготовлены к записи`)
      // Обновить видимые поля, если открытое сейчас устройство входит в выборку
      setPendingWrites(prev => ({ ...prev, ...preset.values }))
      setPendingVersion(v => v + 1)
      // Оставляем в отображении и раскрываем ровно те группы, которые есть в
      // шаблоне — чтобы человек сразу видел подготовленные значения и не искал
      // их среди всех групп.
      const presetGroupIds = new Set(
        device.groups.filter(g => g.params.some(p => preset.values[p.id] !== undefined)).map(g => g.id),
      )
      if (presetGroupIds.size) {
        setVisibleGroups(presetGroupIds)
        for (const groupId of presetGroupIds) expandGroup(groupId)
      }
      setPresetModalOpen(false)
    } finally {
      setApplyingPreset(false)
    }
  }

  // Значения для per-device CSV: в групповом режиме — результаты отображаемого
  // устройства (bulkResults[displayDeviceId]); в одиночном — последние
  // прочитанные (currentValues).
  const csvValues = isBulk ? (bulkResults[displayDeviceId] ?? {}) : currentValues
  // Скачиваем ТОЛЬКО отображаемые (отмеченные галочками) группы и только если
  // все они уже считаны — иначе кнопка неактивна (сначала считка, потом CSV).
  const csvGroupIsRead = g => g.params.some(p => csvValues[p.id] != null)
  const csvReady = groupsInScope.length > 0 && groupsInScope.every(csvGroupIsRead)

  // Экспорт значений отображаемых групп в CSV — тот же формат, что и
  // импорт/экспорт шаблонов значений (колонки "Параметр"/"Значение"), поэтому
  // такой файл можно загрузить и как заготовку шаблона. Имя файла = метки
  // отображаемых групп + имя ПЧ: "F2-EMD-PUMP-6", "Управление_ПЧ-F2-EMD-PUMP-6",
  // все группы → "All-Param-EMD-PUMP-6".
  function exportCurrentValuesCsv() {
    if (!csvReady) return
    const rows = groupsInScope.flatMap(g => g.params)
      .filter(p => csvValues[p.id] != null)
      .map(p => [p.id, p.name, csvValues[p.id], p.unit ?? ''])
    const groupPart = groupsInScope.length === device.groups.length
      ? 'All-Param'
      : (groupsInScope.map(groupFileLabel).join('-') || 'params')
    const safeName = String(activeDevice.name).replace(/[^\p{L}\p{N}_-]+/gu, '_')
    downloadCsv(
      `${groupPart}-${safeName}.csv`,
      ['Параметр', 'Название', 'Значение', 'Единица'],
      rows,
    )
  }

  const query = search.trim().toLowerCase()
  const filteredGroups = groupsInScope
    .map(group => ({
      ...group,
      params: query
        ? group.params.filter(p =>
            p.id.toLowerCase().includes(query) ||
            p.name.toLowerCase().includes(query))
        : group.params,
    }))
    .filter(g => g.params.length > 0)

  const totalWidth = cols.id + cols.desc + cols.def + 20 + cols.cur + 20 + cols.write

  const items = filteredGroups.map((group, groupIndex) => ({
    key: group.id,
    label: group.name,
    extra: (
      <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
        {readingGroup === group.id && (
          <Button size="small" danger onClick={stopGroupedOperation}>
            Остановить
          </Button>
        )}
        <Button
          size="small"
          icon={<DownloadOutlined />}
          loading={readingGroup === group.id}
          disabled={!modbusConnected || (readingGroup !== null && readingGroup !== group.id)}
          onClick={e => readGroup(group, e)}
        >
          Прочитать группу
        </Button>
        <Button
          size="small"
          icon={<UploadOutlined />}
          disabled={!modbusConnected || readingGroup !== null}
          loading={readingGroup === group.id}
          onClick={e => writeGroup(group, e)}
        >
          Записать группу
        </Button>
        <Popconfirm
          title="Сброс до заводских"
          description={`Записать заводские значения во все параметры группы «${group.name}»?`}
          okText="Сбросить"
          cancelText="Отмена"
          okButtonProps={{ danger: true }}
          onConfirm={e => resetGroup(group, e ?? { stopPropagation: () => {} })}
        >
          <Button
            size="small"
            icon={<RollbackOutlined />}
            disabled={!modbusConnected || readingGroup !== null}
            danger
          >
            Заводские
          </Button>
        </Popconfirm>
      </div>
    ),
    children: (
      <div className={groupIndex % 2 === 0 ? 'param-group-body-even' : 'param-group-body-odd'} style={{ overflowX: 'auto', background: groupIndex % 2 === 0 ? '#fff' : '#fafafa' }}>
        <div style={{ minWidth: totalWidth }}>
          <ParamTableHeader cols={cols} onResizeStart={startResize} />
          {group.params.map(param => (
            <ParamRow
              key={`${activeDeviceId}-${param.id}-v${pendingVersion}`}
              device={activeDevice}
              param={param}
              modbusConnected={modbusConnected}
              deviceRunning={deviceRunning}
              injectedValue={isBulk ? bulkResults[displayDeviceId]?.[param.id] : groupValues[param.id]}
              cols={cols}
              onWrite={onWrite}
              onClearGroupValue={clearGroupValue}
              pendingWriteValue={pendingWrites[param.id]}
              onPendingWriteChange={handlePendingWriteChange}
              currentValue={currentValues[param.id]}
              currentFillStamp={currentFillStamp}
              onReadValue={handleReadValue}
            />
          ))}
        </div>
      </div>
    ),
  }))

  // По 3 группы в столбец у Pump, по 4 у VL/VH — раскладка сверху вниз, потом
  // следующий столбец, а не горизонтальный перенос (проще ориентироваться в
  // длинном списке групп).
  const checkboxRows = family === 'vl' ? 4 : 3

  return (
    <>
      <Space style={{ marginBottom: 12, width: '100%' }} wrap>
        <Input
          prefix={<SearchOutlined style={{ color: '#bbb' }} />}
          placeholder={searchFocused || search ? 'Поиск параметра по коду или названию' : 'Поиск'}
          value={search}
          onChange={e => setSearch(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          allowClear
          style={{ width: searchFocused || search ? 320 : 110, transition: 'width 0.15s' }}
        />
        {isBulk && (
          <Select
            value={activeDeviceId}
            onChange={setActiveDeviceId}
            style={{ width: 240 }}
            popupMatchSelectWidth={false}
            options={[
              { value: ALL_DEVICES, label: `★ Все выбранные ПЧ (${effectiveDeviceIds.length}) — править разом` },
              ...effectiveDevices.map(d => ({
                value: d.id,
                label: `${d.name} · Адрес ${d.connection.slaveId}`,
              })),
            ]}
          />
        )}
        <Button
          icon={<FileTextOutlined />}
          onClick={openPresetModal}
        >
          Подготовить из шаблона
        </Button>
        <Tooltip title={csvReady
          ? 'Скачать значения отображаемых (отмеченных галочками) групп в CSV'
          : 'Сначала считайте все отображаемые группы (кнопкой «Прочитать все» или по группам) — потом станет доступно скачивание'}>
          <Button
            icon={<DownloadOutlined />}
            disabled={!csvReady}
            onClick={exportCurrentValuesCsv}
          >
            Скачать CSV
          </Button>
        </Tooltip>
        {groupProgress ? (
          <Button danger onClick={stopGroupedOperation}>
            Остановить {groupProgress.kind === 'read' ? 'чтение' : groupProgress.kind === 'write' ? 'запись' : 'сброс'}
          </Button>
        ) : (
          <>
            <Button
              icon={<DownloadOutlined />}
              disabled={!modbusConnected}
              onClick={() => processAllGroups('read')}
            >
              Прочитать все
            </Button>
            <Button
              icon={<UploadOutlined />}
              disabled={!modbusConnected}
              onClick={() => processAllGroups('write')}
            >
              Записать все
            </Button>
            <Popconfirm
              title="Сброс всех параметров"
              description="Записать заводские значения во все отображаемые параметры?"
              okText="Сбросить всё"
              cancelText="Отмена"
              okButtonProps={{ danger: true }}
              onConfirm={() => processAllGroups('reset')}
            >
              <Button icon={<RollbackOutlined />} danger disabled={!modbusConnected}>
                Сбросить все до заводских
              </Button>
            </Popconfirm>
          </>
        )}
      </Space>

      {isAllMode && (
        <div style={{ marginBottom: 8, padding: '4px 10px', background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 6 }}>
          <Typography.Text style={{ fontSize: 12, color: '#d46b08' }}>
            ★ Режим «Все выбранные ПЧ»: любое изменение поля «Значение для записи» применяется сразу ко всем {effectiveDeviceIds.length} выбранным ПЧ.
          </Typography.Text>
        </div>
      )}

      {groupProgress && (
        <Progress
          style={{ marginBottom: 4 }}
          percent={Math.round(((groupProgress.index) / groupProgress.total) * 100)}
          status="active"
          format={() => `Группа ${groupProgress.index + 1} из ${groupProgress.total}: ${groupProgress.groupName}`}
        />
      )}
      {opProgress && (
        <Progress
          style={{ marginBottom: 12 }}
          size="small"
          percent={opProgress.total > 0 ? Math.round((opProgress.done / opProgress.total) * 100) : 0}
          status="active"
          format={() => `${opProgress.done} из ${opProgress.total} параметров`}
        />
      )}

      <div className="param-toolbar-box" style={{ marginBottom: 12, padding: '8px 10px', background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>
          Отображаемые группы параметров (влияет на «Прочитать/Записать/Сбросить все»)
        </Typography.Text>
        <Checkbox
          checked={visibleGroupIds.size === device.groups.length}
          indeterminate={visibleGroupIds.size > 0 && visibleGroupIds.size < device.groups.length}
          onChange={e => setAllGroupsVisible(e.target.checked)}
          style={{ marginBottom: 6, display: 'inline-flex' }}
        >
          <span style={{ fontSize: 12, fontWeight: 600 }}>Все</span>
        </Checkbox>
        <div style={{
          display: 'grid',
          gridAutoFlow: 'column',
          gridTemplateRows: `repeat(${checkboxRows}, auto)`,
          columnGap: 20,
          rowGap: 4,
        }}>
          {device.groups.map(group => (
            <Checkbox
              key={group.id}
              checked={visibleGroupIds.has(group.id)}
              onChange={e => toggleGroupVisible(group.id, e.target.checked)}
            >
              <span style={{ fontSize: 12 }}>{group.name}</span>
            </Checkbox>
          ))}
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={filteredGroups.map(g => g.id)} strategy={verticalListSortingStrategy}>
          <div style={{ paddingLeft: 20 }}>
            {filteredGroups.map((group) => {
              const item = items.find(it => it.key === group.id)
              if (!item) return null
              const isOpen = query ? true : openGroupIds.has(group.id)
              const groupIndex = filteredGroups.indexOf(group)
              return (
                <SortableCollapseItem key={group.id} id={group.id}>
                  <Collapse
                    items={[item]}
                    activeKey={isOpen ? [group.id] : []}
                    destroyOnHidden
                    onChange={keys => {
                      setOpenGroupIds(prev => {
                        const next = new Set(prev)
                        if (keys.length) next.add(group.id)
                        else next.delete(group.id)
                        return next
                      })
                    }}
                    style={{
                      marginBottom: 8,
                      borderLeft: `3px solid ${groupIndex % 2 === 0 ? '#d9e8ff' : '#e8e8e8'}`,
                    }}
                  />
                </SortableCollapseItem>
              )
            })}
          </div>
        </SortableContext>
      </DndContext>

      <Modal
        title={<Space><FileTextOutlined />Подготовить значения из шаблона</Space>}
        open={presetModalOpen}
        onCancel={() => setPresetModalOpen(false)}
        onOk={applyPreset}
        okText={`Подготовить для ${effectiveDeviceIds.length} устр.`}
        okButtonProps={{ disabled: !selectedPresetId, loading: applyingPreset }}
        cancelText="Отмена"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Значения из выбранного шаблона будут подготовлены (записаны в черновик, но не в ПЧ) у {effectiveDeviceIds.length === 1 ? 'этого устройства' : `всех выбранных устройств (${effectiveDeviceIds.length})`}.
          Уже подготовленные вручную значения других параметров не тронутся; фактическая запись — обычной кнопкой «Записать группу»/«Записать все».
        </Typography.Paragraph>
        <Select
          style={{ width: '100%' }}
          placeholder={presets.length ? 'Выберите шаблон' : `Нет сохранённых шаблонов для ${family === 'vl' ? 'VL' : 'Pump'} — создайте на вкладке «Шаблоны»`}
          value={selectedPresetId}
          onChange={setSelectedPresetId}
          options={presets.map(p => ({ value: p.id, label: `${p.name} (${Object.keys(p.values).length} рег.)` }))}
          notFoundContent="Нет шаблонов для этого типа ПЧ"
        />
      </Modal>
    </>
  )
}
