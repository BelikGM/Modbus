import { useState, useEffect, useRef } from 'react'
import { Button, Table, Typography, Space } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'
import socket from '../socket'
import { addLog } from '../log'

function formatCell(entry) {
  if (!entry) return <span style={{ color: '#bbb' }}>—</span>
  if (entry.error) return <span style={{ color: '#ff4d4f', fontSize: 12 }}>ошибка</span>
  const v = entry.value
  const formatted = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v
  return <span>{formatted}{entry.unit ? ` ${entry.unit}` : ''}</span>
}

export default function BulkMonitor({ devices, modbusConnected }) {
  const [running, setRunning] = useState(false)
  const [dataByDevice, setDataByDevice] = useState({}) // { [deviceId]: { [paramId]: entry } }
  const devicesRef = useRef(devices)
  useEffect(() => { devicesRef.current = devices })

  // Параметры мониторинга общие для всех устройств — гарантированно одна и та же
  // карта регистров, т.к. BulkMonitor рендерится только когда все выбранные ПЧ
  // одного templateId (проверяется в BulkPanel).
  const f0Group = devices[0].groups.find(g => g.id === 'F0')
    ?? devices[0].groups.find(g => g.params?.some(p => p.access === 'read' && (p.type === 'float' || p.type === 'integer')))
  const monitorParams = (f0Group?.params ?? []).filter(
    p => p.access === 'read' && (p.type === 'float' || p.type === 'integer') && p.id !== 'F0.00'
  )

  useEffect(() => {
    function onMonitorData({ deviceId, data }) {
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
      const paramIds = monitorParams.map(p => p.id)
      for (const d of devices) socket.emit('monitor:start', { deviceId: d.id, paramIds })
      setRunning(true)
      addLog('info', `Групповой мониторинг запущен: ${devices.length} устройств`)
    }
  }

  if (!monitorParams.length) {
    return (
      <Typography.Text type="secondary">
        Нет параметров для мониторинга (нужны параметры с access: "read" и type: "float" или "integer")
      </Typography.Text>
    )
  }

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
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>ID {d.connection.slaveId}</Typography.Text>
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
            Опрос идёт по общей шине последовательно — чем больше выбрано устройств и параметров, тем медленнее обновляется каждая колонка.
          </Typography.Text>
        )}
      </Space>

      <Table
        size="small"
        pagination={false}
        bordered
        scroll={{ x: 'max-content' }}
        sticky
        columns={columns}
        dataSource={dataSource}
      />
    </Space>
  )
}
