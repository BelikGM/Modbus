import { useState, useEffect } from 'react'
import { Layout, Typography, Empty, Button, Badge, Segmented, Tooltip } from 'antd'
import { FileTextOutlined, ControlOutlined, BulbOutlined } from '@ant-design/icons'
import DeviceList from './components/DeviceList'
import DeviceDetail from './components/DeviceDetail'
import BulkPanel from './components/BulkPanel'
import ConnectionPanel from './components/ConnectionPanel'
import BusScanner from './components/BusScanner'
import LogDrawer from './components/LogDrawer'
import OlaPage from './components/ola/OlaPage'
import ProjectSelector from './components/ProjectSelector'
import socket from './socket'
import api from './api'
import { useLog } from './log'
import 'antd/dist/reset.css'
import './App.css'

const { Header, Sider, Content } = Layout

export default function App() {
  const [mode, setMode] = useState('modbus')
  const [devices, setDevices] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [siderSide, setSiderSide] = useState('left')
  const [activeProjectId, setActiveProjectId] = useState(null)

  useEffect(() => {
    api.get('/settings').then(({ data }) => {
      if (data.siderSide) setSiderSide(data.siderSide)
    }).catch(() => {})
  }, [])

  function toggleSider() {
    setSiderSide(s => {
      const next = s === 'left' ? 'right' : 'left'
      api.patch('/settings', { siderSide: next }).catch(() => {})
      return next
    })
  }
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [connectedPort, setConnectedPort] = useState(null) // { portPath, baudRate }
  const [waitingPort, setWaitingPort] = useState(null)     // portPath | null
  const [logOpen, setLogOpen] = useState(false)
  const entries = useLog()
  const errorCount = entries.filter(e => e.level === 'error').length

  useEffect(() => {
    socket.on('devices:list', list => setDevices(list))
    socket.on('devices:updated', list => {
      setDevices(list)
      const existingIds = new Set(list.map(d => d.id))
      setSelectedIds(prev => new Set([...prev].filter(id => existingIds.has(id))))
    })
    socket.on('device:id:changed', ({ oldId, newId }) => {
      setSelectedIds(prev => {
        if (!prev.has(oldId)) return prev
        const next = new Set(prev)
        next.delete(oldId)
        next.add(newId)
        return next
      })
    })
    socket.on('modbus:status', status => {
      setConnected(status.connected)
      setReconnecting(status.reconnecting ?? false)
      setReconnectAttempt(status.attempt ?? 0)
      setConnectedPort(status.connected && status.options ? status.options : null)
      setWaitingPort(status.waitingPort ?? null)
    })

    return () => {
      socket.off('devices:list')
      socket.off('devices:updated')
      socket.off('device:id:changed')
      socket.off('modbus:status')
    }
  }, [])

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          padding: '0 24px',
          background: '#001529',
        }}
      >
        <Typography.Title level={4} style={{ color: '#fff', margin: 0, whiteSpace: 'nowrap' }}>
          Modbus Controller
        </Typography.Title>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'modbus', label: 'Modbus RTU', icon: <ControlOutlined /> },
            { value: 'ola', label: 'OLA / DMX', icon: <BulbOutlined /> },
          ]}
          style={{ background: '#ffffff20' }}
        />
        {mode === 'modbus' && (
          <>
            <ProjectSelector
              onProjectInit={id => setActiveProjectId(id)}
              onProjectChange={id => { setSelectedIds(new Set()); setActiveProjectId(id ?? null) }}
            />
            <ConnectionPanel connected={connected} reconnecting={reconnecting} reconnectAttempt={reconnectAttempt} connectedPort={connectedPort} waitingPort={waitingPort} />
            <BusScanner connected={connected} />
          </>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <Badge count={errorCount} size="small">
            <Button
              icon={<FileTextOutlined />}
              onClick={() => setLogOpen(true)}
              style={{ background: 'transparent', borderColor: '#ffffff40', color: '#fff' }}
            >
              Журнал
            </Button>
          </Badge>
        </div>
      </Header>

      {mode === 'modbus' ? (
        <Layout style={{ flex: 1, minHeight: 0, flexDirection: siderSide === 'right' ? 'row-reverse' : 'row' }}>
          <Sider
            width={270}
            style={{
              background: '#fff',
              borderRight: siderSide === 'left' ? '1px solid #f0f0f0' : 'none',
              borderLeft: siderSide === 'right' ? '1px solid #f0f0f0' : 'none',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ flexShrink: 0, padding: '12px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography.Text strong style={{ fontSize: 13, color: '#666' }}>
                УСТРОЙСТВА
              </Typography.Text>
              <Button
                type="text"
                size="small"
                title={siderSide === 'left' ? 'Переместить вправо' : 'Переместить влево'}
                onClick={toggleSider}
                style={{ color: '#999', fontSize: 14, padding: '0 4px' }}
              >
                {siderSide === 'left' ? '→' : '←'}
              </Button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <DeviceList
                devices={devices}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                connected={connected}
                hasProject={!!activeProjectId}
              />
            </div>
          </Sider>

          <Content style={{ padding: 24, background: '#fafafa', overflowY: 'auto', minHeight: 0 }}>
            {(() => {
              const selectedDevices = devices.filter(d => selectedIds.has(d.id))
              if (selectedIds.size > 1) {
                return (
                  <BulkPanel
                    devices={selectedDevices}
                    modbusConnected={connected}
                    onDeselect={id => setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })}
                  />
                )
              }
              if (selectedIds.size === 1 && selectedDevices[0]) {
                return <DeviceDetail device={selectedDevices[0]} modbusConnected={connected} />
              }
              return <Empty description="Выберите устройство из списка слева" style={{ marginTop: 80 }} />
            })()}
          </Content>
        </Layout>
      ) : (
        <Layout style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <OlaPage />
        </Layout>
      )}

      <LogDrawer open={logOpen} onClose={() => setLogOpen(false)} />
    </Layout>
  )
}
