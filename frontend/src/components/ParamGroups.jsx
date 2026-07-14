import { useState, useRef, useCallback, useEffect } from 'react'
import { Collapse, Button, Input, message, Typography, Popconfirm, Space, Modal, Table, Checkbox, Progress } from 'antd'
import { DownloadOutlined, SearchOutlined, RollbackOutlined, HolderOutlined, HistoryOutlined, DatabaseOutlined, UploadOutlined } from '@ant-design/icons'
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
import { useDeviceSettings } from '../useDeviceSettings'
import { isParamWritable } from '../access'

const DEFAULT_COLS = { id: 90, desc: 220, def: 120, cur: 150, write: 290 }
const MIN_COLS     = { id: 60, desc: 100, def: 80,  cur: 100, write: 200 }

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

function HeaderCell({ label, width, onResizeStart }) {
  return (
    <div style={{ position: 'relative', width, flexShrink: 0, paddingRight: 10, boxSizing: 'border-box' }}>
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
    <div style={{
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
      <HeaderCell label="Значение на устройстве" width={cols.cur}   onResizeStart={onResizeStart('cur')} />
      <HeaderCell label="Значение для записи"    width={cols.write} onResizeStart={onResizeStart('write')} />
    </div>
  )
}

export default function ParamGroups({
  device, modbusConnected, deviceRunning, onWrite, onReadGroup, onResetGroup, onWriteGroup,
  visibleGroupIds: controlledVisibleGroupIds, onVisibleGroupIdsChange,
}) {
  const [readingGroup, setReadingGroup] = useState(null)
  const [groupValues, setGroupValues]   = useState({})
  const [search, setSearch]             = useState('')
  const [groupProgress, setGroupProgress] = useState(null) // { index, total, groupName, kind }

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
  const [fillStamp, setFillStamp] = useState(0)
  const [currentValues, setCurrentValues] = useState({})
  const [currentFillStamp, setCurrentFillStamp] = useState(0)
  const [currentValuesModalOpen, setCurrentValuesModalOpen] = useState(false)
  const latestCols = useRef(DEFAULT_COLS)
  const latestPendingWrites = useRef({})
  const latestCurrentValues = useRef({})
  const pendingSaveTimer = useRef(null)
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

  useEffect(() => {
    setPendingWrites({})
    latestPendingWrites.current = {}
    setCurrentValues({})
    let cancelled = false
    api.get(`/devices/${device.id}/pending-writes`)
      .then(({ data }) => {
        if (cancelled) return
        const pw = data ?? {}
        setPendingWrites(pw)
        latestPendingWrites.current = pw
      })
      .catch(() => {})
    api.get(`/devices/${device.id}/current-values`)
      .then(({ data }) => {
        if (cancelled) return
        const cv = data ?? {}
        setCurrentValues(cv)
        latestCurrentValues.current = cv
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [device.id])

  const handlePendingWriteChange = useCallback((paramId, val) => {
    setPendingWrites(prev => {
      const next = { ...prev, [paramId]: val }
      latestPendingWrites.current = next
      return next
    })
    if (pendingSaveTimer.current) clearTimeout(pendingSaveTimer.current)
    pendingSaveTimer.current = setTimeout(() => {
      api.patch(`/devices/${device.id}/pending-writes`, { pendingWrites: latestPendingWrites.current }).catch(() => {})
    }, 500)
  }, [device.id, saveDeviceSettings])

  const handleReadValue = useCallback((paramId, val) => {
    setCurrentValues(prev => {
      const next = { ...prev, [paramId]: val }
      latestCurrentValues.current = next
      return next
    })
    if (currentSaveTimer.current) clearTimeout(currentSaveTimer.current)
    currentSaveTimer.current = setTimeout(() => {
      api.patch(`/devices/${device.id}/current-values`, { currentValues: latestCurrentValues.current }).catch(() => {})
    }, 500)
  }, [device.id])

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

  async function readGroup(group, e) {
    e.stopPropagation()
    setReadingGroup(group.id)
    const results = {}
    for (const param of group.params) {
      try {
        const { data } = await api.post('/modbus/read', { deviceId: device.id, paramId: param.id })
        results[param.id] = data.value
      } catch { }
    }
    setGroupValues(prev => ({ ...prev, ...results }))
    setReadingGroup(null)
    message.success(`Группа ${group.id} прочитана`)
    if (Object.keys(results).length > 0) {
      const merged = { ...latestCurrentValues.current, ...results }
      setCurrentValues(merged)
      latestCurrentValues.current = merged
      api.patch(`/devices/${device.id}/current-values`, { currentValues: merged }).catch(() => {})
    }
  }

  async function writeGroup(group, e) {
    e.stopPropagation()
    const toWrite = group.params.filter(
      p => isParamWritable(device, p) && latestPendingWrites.current[p.id] != null
    )
    if (toWrite.length === 0) {
      message.info(`В группе ${group.id} нет значений для записи`)
      return
    }
    setReadingGroup(group.id)
    let ok = 0
    const results = {}
    for (const param of toWrite) {
      try {
        await api.post('/modbus/write', { deviceId: device.id, paramId: param.id, value: latestPendingWrites.current[param.id] })
        results[param.id] = latestPendingWrites.current[param.id]
        ok++
      } catch { }
    }
    setGroupValues(prev => ({ ...prev, ...results }))
    setReadingGroup(null)
    message.success(`Записано ${ok} из ${toWrite.length} параметров группы ${group.id}`)
  }

  const bulkCancelRef = useRef(false)

  function stopGroupedOperation() {
    bulkCancelRef.current = true
  }

  async function processAllGroups(kind) {
    if (groupsInScope.length === 0) {
      message.info('Нет отображаемых групп — отметьте хотя бы одну галочкой ниже')
      return
    }
    bulkCancelRef.current = false
    setGroupProgress({ index: 0, total: groupsInScope.length, groupName: groupsInScope[0].name, kind })
    let processed = 0
    for (let i = 0; i < groupsInScope.length; i++) {
      if (bulkCancelRef.current) break
      const group = groupsInScope[i]
      setGroupProgress({ index: i, total: groupsInScope.length, groupName: group.name, kind })
      setReadingGroup(group.id)
      const fakeEvent = { stopPropagation: () => {} }
      if (kind === 'read') {
        if (onReadGroup) await onReadGroup(group)
        else await readGroup(group, fakeEvent)
      } else if (kind === 'write') {
        if (onWriteGroup) await onWriteGroup(group, latestPendingWrites.current)
        else await writeGroup(group, fakeEvent)
      } else {
        if (onResetGroup) await onResetGroup(group)
        else await resetGroup(group, fakeEvent)
      }
      setReadingGroup(null)
      processed++
    }
    setGroupProgress(null)
    if (bulkCancelRef.current) {
      message.info(`Остановлено: обработано ${processed} из ${groupsInScope.length} групп`)
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

  const totalWidth = cols.id + cols.desc + cols.def + cols.cur + cols.write

  const items = filteredGroups.map(group => ({
    key: group.id,
    label: group.name,
    extra: (
      <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          loading={readingGroup === group.id}
          disabled={!modbusConnected || (readingGroup !== null && readingGroup !== group.id)}
          onClick={async e => {
            if (onReadGroup) { setReadingGroup(group.id); await onReadGroup(group); setReadingGroup(null) }
            else readGroup(group, e)
          }}
        >
          Прочитать всё
        </Button>
        <Button
          size="small"
          icon={<UploadOutlined />}
          disabled={!modbusConnected || readingGroup !== null}
          loading={readingGroup === group.id}
          onClick={async e => {
            e.stopPropagation()
            if (onWriteGroup) { setReadingGroup(group.id); await onWriteGroup(group); setReadingGroup(null) }
            else writeGroup(group, e)
          }}
        >
          Записать всё
        </Button>
        <Popconfirm
          title="Сброс до заводских"
          description={`Записать заводские значения во все параметры группы «${group.name}»?`}
          okText="Сбросить"
          cancelText="Отмена"
          okButtonProps={{ danger: true }}
          onConfirm={async e => {
            if (onResetGroup) { setReadingGroup(group.id); await onResetGroup(group); setReadingGroup(null) }
            else resetGroup(group, e ?? { stopPropagation: () => {} })
          }}
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
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: totalWidth }}>
          <ParamTableHeader cols={cols} onResizeStart={startResize} />
          {group.params.map(param => (
            <ParamRow
              key={param.id}
              device={device}
              param={param}
              modbusConnected={modbusConnected}
              deviceRunning={deviceRunning}
              injectedValue={groupValues[param.id]}
              cols={cols}
              onWrite={onWrite}
              onClearGroupValue={clearGroupValue}
              pendingWriteValue={pendingWrites[param.id]}
              onPendingWriteChange={handlePendingWriteChange}
              fillStamp={fillStamp}
              currentValue={currentValues[param.id]}
              currentFillStamp={currentFillStamp}
              onReadValue={handleReadValue}
            />
          ))}
        </div>
      </div>
    ),
  }))

  async function resetGroup(group, e) {
    e.stopPropagation()
    const toWrite = group.params.filter(
      p => isParamWritable(device, p) && p.default !== undefined && p.default !== null
    )
    if (toWrite.length === 0) {
      message.info('Нет параметров с заводскими значениями')
      return
    }
    setReadingGroup(group.id)
    let ok = 0
    const results = {}
    for (const param of toWrite) {
      try {
        await api.post('/modbus/write', { deviceId: device.id, paramId: param.id, value: param.default })
        results[param.id] = param.default
        ok++
      } catch { }
    }
    setGroupValues(prev => ({ ...prev, ...results }))
    setReadingGroup(null)
    message.success(`Сброшено ${ok} из ${toWrite.length} параметров группы ${group.name}`)
  }

  return (
    <>
      <Space style={{ marginBottom: 12, width: '100%' }}>
        <Input
          prefix={<SearchOutlined style={{ color: '#bbb' }} />}
          placeholder="Поиск параметра по коду или названию"
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 320 }}
        />
        <Button
          icon={<HistoryOutlined />}
          disabled={Object.keys(pendingWrites).length === 0}
          onClick={() => setFillStamp(s => s + 1)}
          title="Заполнить поля записи сохранёнными черновиками"
        >
          Черновик
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
          style={{ marginBottom: 12 }}
          percent={Math.round(((groupProgress.index) / groupProgress.total) * 100)}
          status="active"
          format={() => `Группа ${groupProgress.index + 1} из ${groupProgress.total}: ${groupProgress.groupName}`}
        />
      )}

      <div style={{ marginBottom: 12, padding: '8px 10px', background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>
          Отображаемые группы параметров (влияет на «Прочитать/Записать/Сбросить все»)
        </Typography.Text>
        <Space wrap size={[10, 4]}>
          <Checkbox
            checked={visibleGroupIds.size === device.groups.length}
            indeterminate={visibleGroupIds.size > 0 && visibleGroupIds.size < device.groups.length}
            onChange={e => setAllGroupsVisible(e.target.checked)}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>Все</span>
          </Checkbox>
          {device.groups.map(group => (
            <Checkbox
              key={group.id}
              checked={visibleGroupIds.has(group.id)}
              onChange={e => toggleGroupVisible(group.id, e.target.checked)}
            >
              <span style={{ fontSize: 12 }}>{group.name}</span>
            </Checkbox>
          ))}
        </Space>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={filteredGroups.map(g => g.id)} strategy={verticalListSortingStrategy}>
          <div style={{ paddingLeft: 20 }}>
            {filteredGroups.map((group, i) => {
              const item = items.find(it => it.key === group.id)
              if (!item) return null
              return (
                <SortableCollapseItem key={group.id} id={group.id}>
                  <Collapse
                    items={[item]}
                    defaultActiveKey={i === 0 ? [group.id] : []}
                    activeKey={query ? [group.id] : undefined}
                    style={{ marginBottom: 4 }}
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
    </>
  )
}
