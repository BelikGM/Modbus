import { useState, useRef, useCallback, useEffect } from 'react'
import { Collapse, Button, Input, message, Typography, Popconfirm, Space, Modal, Table, Checkbox, Progress, Select } from 'antd'
import { DownloadOutlined, SearchOutlined, RollbackOutlined, HolderOutlined, DatabaseOutlined, UploadOutlined, FileTextOutlined } from '@ant-design/icons'
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

const DEFAULT_COLS = { id: 90, desc: 220, def: 120, cur: 150, write: 290 }
const MIN_COLS     = { id: 60, desc: 100, def: 80,  cur: 100, write: 200 }

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

function HeaderCell({ label, width, onResizeStart, marginLeft }) {
  return (
    <div style={{ position: 'relative', width, flexShrink: 0, paddingRight: 10, boxSizing: 'border-box', marginLeft }}>
      <Typography.Text style={{ fontSize: 11, color: '#888', fontWeight: 600, userSelect: 'none' }}>
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
      padding: '5px 4px',
      background: '#fafafa',
      borderBottom: '2px solid #e8e8e8',
      borderTop: '1px solid #e8e8e8',
      position: 'sticky', top: 0, zIndex: 1,
    }}>
      <HeaderCell label="Параметр / Адрес"      width={cols.id}    onResizeStart={onResizeStart('id')} />
      <HeaderCell label="Описание параметра"     width={cols.desc}  onResizeStart={onResizeStart('desc')} />
      <HeaderCell label="Заводское значение"     width={cols.def}   onResizeStart={onResizeStart('def')} />
      <HeaderCell label="Значение на устройстве" width={cols.cur}   onResizeStart={onResizeStart('cur')} marginLeft={20} />
      <HeaderCell label="Значение для записи"    width={cols.write} onResizeStart={onResizeStart('write')} marginLeft={20} />
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
  useEffect(() => {
    if (!effectiveDeviceIds.includes(activeDeviceId)) setActiveDeviceId(effectiveDeviceIds[0])
  }, [effectiveDeviceIds.join(',')])
  const activeDevice = effectiveDevices.find(d => d.id === activeDeviceId) ?? effectiveDevices[0]

  const [readingGroup, setReadingGroup] = useState(null)
  const [groupValues, setGroupValues]   = useState({})
  const [search, setSearch]             = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [groupProgress, setGroupProgress] = useState(null) // { index, total, groupName, kind }
  const [opProgress, setOpProgress] = useState(null) // { done, total } — живой прогресс текущего runBulkOp
  const [openGroupIds, setOpenGroupIds] = useState(() => new Set(device.groups[0] ? [device.groups[0].id] : []))
  const latestGroupValues = useRef({})

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
  const [currentFillStamp, setCurrentFillStamp] = useState(0)
  const [currentValuesModalOpen, setCurrentValuesModalOpen] = useState(false)
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
    api.get(`/devices/${activeDeviceId}/pending-writes`)
      .then(({ data }) => {
        if (cancelled) return
        setPendingWrites(data ?? {})
        setPendingVersion(v => v + 1)
      })
      .catch(() => {})
    api.get(`/devices/${activeDeviceId}/current-values`)
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
    setPendingWrites(prev => {
      const next = { ...prev, [paramId]: val }
      api.patch(`/devices/${activeDeviceId}/pending-writes`, { merge: true, pendingWrites: { [paramId]: val } }).catch(() => {})
      return next
    })
  }, [activeDeviceId])

  const handleReadValue = useCallback((paramId, val) => {
    setCurrentValues(prev => {
      const next = { ...prev, [paramId]: val }
      latestCurrentValues.current = next
      return next
    })
    if (currentSaveTimer.current) clearTimeout(currentSaveTimer.current)
    currentSaveTimer.current = setTimeout(() => {
      api.patch(`/devices/${activeDeviceId}/current-values`, { currentValues: latestCurrentValues.current }).catch(() => {})
    }, 500)
  }, [activeDeviceId])

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

  async function readGroup(group, e) {
    e?.stopPropagation()
    expandGroup(group.id)
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
  async function writeGroup(group, e) {
    e?.stopPropagation()
    expandGroup(group.id)
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
      if (kind === 'read') await readGroup(group, fakeEvent)
      else if (kind === 'write') await writeGroup(group, fakeEvent)
      else await resetGroup(group, fakeEvent)
      processed++
    }
    setGroupProgress(null)
    if (bulkCancelRef.current) {
      message.info(`Остановлено: обработано ${processed} из ${groupsInScope.length} групп`)
    }
  }

  async function resetGroup(group, e) {
    e?.stopPropagation()
    const toWrite = group.params.filter(
      p => isParamWritable(device, p) && p.default !== undefined && p.default !== null && typeof p.default === 'number'
    )
    if (toWrite.length === 0) {
      message.info('Нет параметров с заводскими значениями')
      return
    }
    expandGroup(group.id)
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
      for (const groupId of new Set(Object.keys(preset.values).map(paramId => {
        const g = device.groups.find(gr => gr.params.some(p => p.id === paramId))
        return g?.id
      }).filter(Boolean))) {
        expandGroup(groupId)
      }
      setPresetModalOpen(false)
    } finally {
      setApplyingPreset(false)
    }
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
              injectedValue={groupValues[param.id]}
              cols={cols}
              onWrite={onWrite}
              onClearGroupValue={clearGroupValue}
              pendingWriteValue={pendingWrites[param.id]}
              onPendingWriteChange={handlePendingWriteChange}
              currentValue={currentValues[param.id]}
              currentFillStamp={currentFillStamp}
              onReadValue={handleReadValue}
              hideDeviceValue={isBulk}
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
            style={{ width: 220 }}
            popupMatchSelectWidth={false}
            options={effectiveDevices.map(d => ({
              value: d.id,
              label: `${d.name} · Адрес ${d.connection.slaveId}`,
            }))}
          />
        )}
        <Button
          icon={<FileTextOutlined />}
          onClick={openPresetModal}
        >
          Подготовить из шаблона
        </Button>
        <Button
          icon={<DatabaseOutlined />}
          disabled={Object.keys(currentValues).length === 0}
          onClick={() => setCurrentValuesModalOpen(true)}
          title="Просмотреть и применить последние прочитанные значения"
        >
          Текущие параметры
        </Button>
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
          style={{ marginBottom: 6, display: 'block' }}
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
        title={<Space><DatabaseOutlined />Текущие параметры устройства</Space>}
        open={currentValuesModalOpen}
        onCancel={() => setCurrentValuesModalOpen(false)}
        onOk={() => {
          setCurrentFillStamp(s => s + 1)
          setCurrentValuesModalOpen(false)
        }}
        okText="Подставить в поля записи"
        cancelText="Закрыть"
        width={640}
      >
        <Table
          size="small"
          pagination={false}
          scroll={{ y: 400 }}
          dataSource={device.groups.flatMap(g => g.params)
            .filter(p => currentValues[p.id] != null)
            .map(p => ({ key: p.id, id: p.id, name: p.name, value: currentValues[p.id], unit: p.unit ?? '' }))
          }
          columns={[
            { title: 'Параметр', dataIndex: 'id', width: 90 },
            { title: 'Название', dataIndex: 'name' },
            { title: 'Значение', dataIndex: 'value', width: 100, render: (v, r) => `${v} ${r.unit}`.trim() },
          ]}
          locale={{ emptyText: 'Нет сохранённых значений' }}
        />
      </Modal>

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
