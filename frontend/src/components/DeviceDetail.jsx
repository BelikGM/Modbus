import { useState, useEffect, useRef } from 'react'
import { Tabs, Typography } from 'antd'
import ParamGroups from './ParamGroups'
import Monitor from './Monitor'
import DeviceInfo from './DeviceInfo'
import ControlPanel from './ControlPanel'
import BackupRestore from './BackupRestore'
import DeviceNotes from './DeviceNotes'
import ValuePresets from './ValuePresets'
import api from '../api'

function findStatusParam(device) {
  if (!device?.access_legend) return null
  for (const g of device.groups) {
    const p = g.params.find(p => p.id === 'STATUS')
    if (p) return p
  }
  return null
}

export default function DeviceDetail({ device, modbusConnected, activeTab, onActiveTabChange }) {
  const [deviceRunning, setDeviceRunning] = useState(null) // null=неизвестно, true=работает, false=остановлен
  const intervalRef = useRef(null)

  useEffect(() => {
    const statusParam = findStatusParam(device)
    if (!statusParam) { setDeviceRunning(null); return }

    async function pollStatus() {
      if (!modbusConnected) { setDeviceRunning(null); return }
      try {
        const res = await api.post('/modbus/read', { deviceId: device.id, paramId: 'STATUS' })
        setDeviceRunning(res.data.value !== 3)
      } catch {
        setDeviceRunning(null)
      }
    }

    pollStatus()
    intervalRef.current = setInterval(pollStatus, 2000)
    return () => clearInterval(intervalRef.current)
  }, [device.id, modbusConnected])

  const items = [
    {
      key: 'params',
      label: 'Параметры',
      children: <ParamGroups device={device} modbusConnected={modbusConnected} deviceRunning={deviceRunning} />,
    },
    {
      key: 'monitor',
      label: 'Мониторинг',
      children: <Monitor device={device} modbusConnected={modbusConnected} />,
    },
    {
      key: 'templates',
      label: 'Шаблоны',
      children: <ValuePresets device={device} />,
    },
    {
      key: 'info',
      label: 'Устройство',
      children: <DeviceInfo device={device} />,
    },
    {
      key: 'notes',
      label: 'Журнал',
      children: <DeviceNotes device={device} />,
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
        <div>
          <Typography.Title level={4} style={{ marginTop: 0, marginBottom: device.description ? 4 : 16 }}>
            {device.name}
          </Typography.Title>
          {device.description && (
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
              {device.description}
            </Typography.Text>
          )}
        </div>
        {/*<BackupRestore device={device} modbusConnected={modbusConnected} />*/}
      </div>
      <ControlPanel device={device} modbusConnected={modbusConnected} />
      <Tabs items={items} activeKey={activeTab} onChange={onActiveTabChange} />
    </div>
  )
}
