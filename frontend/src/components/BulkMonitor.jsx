import { useState, useEffect, useRef } from 'react'
import { Button, Table, Typography, Space } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'
import socket from '../socket'
import { addLog } from '../log'
import { formatParamValue } from '../paramFormat'
import { getMonitorParams } from '../monitorParams'

function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

function formatCell(entry) {
  if (!entry) return <span style={{ color: '#bbb' }}>—</span>
  if (entry.error) return <span style={{ color: '#ff4d4f', fontSize: 12 }}>ошибка</span>
  return <span>{formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits)}</span>
}

// Одна секция-таблица на семейство ПЧ (Pump/VL) — при смешанном выборе у
// каждого семейства своя карта регистров мониторинга, общая таблица не имела
// бы смысла.
function FamilySection({ title, devices, monitorParams, dataByDevice }) {
  const columns = [
    {
      title: 'Параметр',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 220,
      render: (name, row) => (
        <div>
          <Typography.Text style={{ fontSize: 13 }}>{name}</Typography.Text>
          {row.unit && <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>({row.unit})</Typography.Text>}
        </div>
      ),
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
      <Table
        size="small"
        pagination={false}
        bordered
        scroll={{ x: 'max-content', y: 'calc(100vh - 280px)' }}
        columns={columns}
        dataSource={dataSource}
      />
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
    }
  }, [])

  function toggle() {
    if (running) {
      for (const d of devices) socket.emit('monitor:stop', { deviceId: d.id })
      setRunning(false)
      setDataByDevice({})
      addLog('info', `Групповой мониторинг остановлен: ${devices.length} устройств`)
    } else {
      for (const group of familyGroups) {
        const paramIds = paramsByFamily[group.family].map(p => p.id)
        for (const d of group.devices) socket.emit('monitor:start', { deviceId: d.id, paramIds })
      }
      setRunning(true)
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
