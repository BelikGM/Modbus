import { useState, useEffect, useRef } from 'react'
import { Button, Table, Typography, Space } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, HolderOutlined } from '@ant-design/icons'
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
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import socket from '../socket'
import { addLog } from '../log'
import { formatParamValue } from '../paramFormat'
import { getMonitorParams } from '../monitorParams'
import { setBusy } from '../busy'

function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

function formatCell(entry) {
  if (!entry) return <span style={{ color: '#bbb' }}>—</span>
  if (entry.error) return <span style={{ color: '#ff4d4f', fontSize: 12 }}>ошибка</span>
  // bitmask форматируется как "имя: значение" по одной на строку (\n) —
  // pre-line сохраняет переносы внутри обычной ячейки таблицы.
  return <span style={{ whiteSpace: 'pre-line' }}>{formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits)}</span>
}

// Заголовок колонки-устройства — тянем весь <th> целиком (не отдельная ручка,
// в шапке и так только название/адрес, кликать там всё равно больше не за чем).
// Колонка "Параметр" (columnId === undefined) остаётся обычным неперетаскиваемым <th>.
function DraggableHeaderCell({ columnId, children, ...restProps }) {
  const sortable = useSortable({ id: columnId ?? '__param__', disabled: columnId === undefined })
  if (columnId === undefined) return <th {...restProps}>{children}</th>
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable
  return (
    <th
      {...restProps}
      ref={setNodeRef}
      style={{
        ...restProps.style,
        transform: CSS.Translate.toString(transform),
        transition,
        cursor: 'grab',
        position: 'relative',
        zIndex: isDragging ? 3 : undefined,
        background: isDragging ? '#e6f4ff' : restProps.style?.background,
      }}
      {...attributes}
      {...listeners}
    >
      <HolderOutlined style={{ fontSize: 10, color: '#bbb', marginRight: 4 }} />
      {children}
    </th>
  )
}

// Одна секция-таблица на семейство ПЧ (Pump/VL) — при смешанном выборе у
// каждого семейства своя карта регистров мониторинга, общая таблица не имела
// бы смысла. Колонки-устройства можно перетаскивать за шапку, чтобы поменять
// местами (порядок держится только в рамках текущего просмотра — сессионный,
// не сохраняется).
function FamilySection({ title, devices, monitorParams, dataByDevice }) {
  const [order, setOrder] = useState(() => devices.map(d => d.id))
  const idsKey = devices.map(d => d.id).join(',')
  const orderedDevices = order
    .map(id => devices.find(d => d.id === id))
    .filter(Boolean)
    .concat(devices.filter(d => !order.includes(d.id)))

  useEffect(() => {
    setOrder(prev => {
      const stillValid = prev.filter(id => devices.some(d => d.id === id))
      const added = devices.map(d => d.id).filter(id => !prev.includes(id))
      return [...stillValid, ...added]
    })
  }, [idsKey])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  function handleColumnDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOrder(prev => {
      const oldIndex = prev.indexOf(active.id)
      const newIndex = prev.indexOf(over.id)
      if (oldIndex === -1 || newIndex === -1) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  const columns = [
    {
      title: 'Параметр',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 220,
      onHeaderCell: () => ({ columnId: undefined }),
      render: (name, row) => (
        <div>
          <Typography.Text style={{ fontSize: 13 }}>{name}</Typography.Text>
          {row.unit && <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>({row.unit})</Typography.Text>}
        </div>
      ),
    },
    ...orderedDevices.map(d => ({
      title: (
        <div>
          <div style={{ fontSize: 12 }}>{d.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>Адрес {d.connection.slaveId}</Typography.Text>
        </div>
      ),
      dataIndex: d.id,
      key: d.id,
      width: 130,
      onHeaderCell: () => ({ columnId: d.id }),
      render: (_, row) => formatCell(dataByDevice[d.id]?.[row.paramId]),
    })),
  ]

  const dataSource = monitorParams.map(p => ({
    key: p.id,
    paramId: p.id,
    name: p.name,
    unit: p.unit,
  }))

  return (
    <div>
      {title && <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>{title} ({devices.length})</Typography.Text>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleColumnDragEnd}>
        <SortableContext items={orderedDevices.map(d => d.id)} strategy={horizontalListSortingStrategy}>
          <Table
            size="small"
            pagination={false}
            bordered
            scroll={{ x: 'max-content', y: 'calc(100vh - 280px)' }}
            columns={columns}
            dataSource={dataSource}
            components={{ header: { cell: DraggableHeaderCell } }}
          />
        </SortableContext>
      </DndContext>
    </div>
  )
}

export default function BulkMonitor({ devices, modbusConnected, sameType }) {
  const [running, setRunning] = useState(false)
  const [dataByDevice, setDataByDevice] = useState({}) // { [deviceId]: { [paramId]: entry } }
  const devicesRef = useRef(devices)
  useEffect(() => { devicesRef.current = devices })
  const runningRef = useRef(false)
  useEffect(() => { runningRef.current = running }, [running])

  // Группируем по семейству ПЧ — при смешанном выборе у каждого своя карта
  // регистров мониторинга; при однотипном выборе получится одна группа.
  const familyGroups = ['pump', 'vl']
    .map(family => ({ family, devices: devices.filter(d => deviceFamily(d.templateId) === family) }))
    .filter(g => g.devices.length > 0)

  const paramsByFamily = Object.fromEntries(
    familyGroups.map(g => [g.family, getMonitorParams(g.devices[0])]),
  )

  useEffect(() => {
    function onMonitorData({ deviceId, data }) {
      // Раунд-робин цикл на бэкенде мог начать читать это устройство ДО того,
      // как обработалась остановка — без этой проверки "хвостовой" ответ
      // мог прилететь уже после setDataByDevice({}) и вернуть одну колонку
      // с устаревшим значением.
      if (!runningRef.current) return
      if (!devicesRef.current.some(d => d.id === deviceId)) return
      setDataByDevice(prev => ({ ...prev, [deviceId]: data }))
    }
    socket.on('monitor:data', onMonitorData)
    return () => socket.off('monitor:data', onMonitorData)
  }, [])

  // Остановить мониторинг всех текущих устройств при закрытии вкладки/смене выбора
  useEffect(() => {
    return () => {
      for (const d of devicesRef.current) socket.emit('monitor:stop', { deviceId: d.id })
      setBusy('monitor', false)
    }
  }, [])

  // Сменился состав выбранных ПЧ (другая комбинация, не просто перерендер) —
  // старый мониторинг никогда не должен продолжать тихо крутиться поверх уже
  // не актуального выбора: останавливаем именно ПРЕЖНИЙ набор устройств и
  // сбрасываем показания, а не просто ждём, пока пользователь сам заметит.
  const deviceIdsKey = devices.map(d => d.id).join(',')
  const prevIdsKeyRef = useRef(deviceIdsKey)
  useEffect(() => {
    if (prevIdsKeyRef.current === deviceIdsKey) return
    const prevIds = prevIdsKeyRef.current.split(',').filter(Boolean)
    prevIdsKeyRef.current = deviceIdsKey
    if (!runningRef.current) return
    for (const id of prevIds) socket.emit('monitor:stop', { deviceId: id })
    setRunning(false)
    setBusy('monitor', false)
    setDataByDevice({})
    addLog('info', 'Групповой мониторинг остановлен: изменился состав выбранных устройств')
  }, [deviceIdsKey])

  function toggle() {
    if (running) {
      for (const d of devices) socket.emit('monitor:stop', { deviceId: d.id })
      setRunning(false)
      setBusy('monitor', false)
      setDataByDevice({})
      addLog('info', `Групповой мониторинг остановлен: ${devices.length} устройств`)
    } else {
      for (const group of familyGroups) {
        const paramIds = paramsByFamily[group.family].map(p => p.id)
        for (const d of group.devices) socket.emit('monitor:start', { deviceId: d.id, paramIds })
      }
      setRunning(true)
      setBusy('monitor', true)
      addLog('info', `Групповой мониторинг запущен: ${devices.length} устройств`)
    }
  }

  const hasAnyParams = familyGroups.some(g => paramsByFamily[g.family].length > 0)
  if (!hasAnyParams) {
    return (
      <Typography.Text type="secondary">
        Нет параметров для мониторинга (нужны параметры с access: "read" и type: "float"/"integer"/"bitmask")
      </Typography.Text>
    )
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space align="center" wrap>
        <Button
          type={running ? 'default' : 'primary'}
          icon={running ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          onClick={toggle}
          disabled={!modbusConnected}
          danger={running}
        >
          {running ? 'Остановить мониторинг' : 'Запустить мониторинг'}
        </Button>
        {!modbusConnected && (
          <Typography.Text type="secondary">Требуется подключение к порту</Typography.Text>
        )}
        {running && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Опрос идёт по общей шине друг за другом без искусственной задержки — так быстро, как позволяет сама шина. Чем больше выбрано устройств и параметров, тем реже обновляется каждая конкретная колонка (это ограничение физической шины RS-485, не программы).
          </Typography.Text>
        )}
      </Space>

      {familyGroups.map(group => (
        <FamilySection
          key={group.family}
          title={sameType ? null : (group.family === 'vl' ? 'VL' : 'Pump')}
          devices={group.devices}
          monitorParams={paramsByFamily[group.family]}
          dataByDevice={dataByDevice}
        />
      ))}
    </Space>
  )
}
