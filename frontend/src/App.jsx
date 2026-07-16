import { useState, useEffect, useRef, useCallback } from 'react'
import { Layout, Typography, Empty, Button, Badge } from 'antd'
import { FileTextOutlined } from '@ant-design/icons'
import DeviceList from './components/DeviceList'
import DeviceDetail from './components/DeviceDetail'
import BulkPanel from './components/BulkPanel'
import ConnectionPanel from './components/ConnectionPanel'
import BusScanner from './components/BusScanner'
import LogDrawer from './components/LogDrawer'
import ProjectSelector from './components/ProjectSelector'
import socket from './socket'
import api from './api'
import { useLog } from './log'
import 'antd/dist/reset.css'
import './App.css'

const { Header, Sider, Content } = Layout

export default function App() {
  const [devices, setDevices] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [siderSide, setSiderSide] = useState('left')
  const [siderWidth, setSiderWidth] = useState(270)
  const [activeProjectId, setActiveProjectId] = useState(null)
  const resizingRef = useRef(null)

  useEffect(() => {
    api.get('/settings').then(({ data }) => {
      if (data.siderSide) setSiderSide(data.siderSide)
      if (data.siderWidth) setSiderWidth(data.siderWidth)
    }).catch(() => {})
  }, [])

  function toggleSider() {
    setSiderSide(s => {
      const next = s === 'left' ? 'right' : 'left'
      api.patch('/settings', { siderSide: next }).catch(() => {})
      return next
    })
  }

  const SIDER_MIN_WIDTH = 56
  const SIDER_MAX_WIDTH = 520

  const startResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = siderWidth
    const sign = siderSide === 'right' ? -1 : 1
    resizingRef.current = { startX, startWidth }

    function onMove(ev) {
      if (!resizingRef.current) return
      const delta = (ev.clientX - resizingRef.current.startX) * sign
      const next = Math.min(SIDER_MAX_WIDTH, Math.max(SIDER_MIN_WIDTH, resizingRef.current.startWidth + delta))
      setSiderWidth(next)
    }
    function onUp() {
      resizingRef.current = null
      setSiderWidth(w => {
        api.patch('/settings', { siderWidth: w }).catch(() => {})
        return w
      })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [siderWidth, siderSide])
  const [liveness, setLiveness] = useState({}) // { [deviceId]: boolean }
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
      // Общий статус порта не относится ни к одному устройству лично — при
      // отключении/потере связи с портом сбрасываем весь per-device индикатор,
      // не дожидаясь следующего фонового цикла проверки на бэкенде.
      if (!status.connected) setLiveness({})
    })
    socket.on('devices:liveness:snapshot', snapshot => setLiveness(snapshot ?? {}))
    socket.on('device:liveness', ({ deviceId, online }) => {
      setLiveness(prev => ({ ...prev, [deviceId]: online }))
    })

    return () => {
      socket.off('devices:list')
      socket.off('devices:updated')
      socket.off('device:id:changed')
      socket.off('modbus:status')
      socket.off('devices:liveness:snapshot')
      socket.off('device:liveness')
    }
  }, [])

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          background: '#001529',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          <img
            src="/fbest-logo.png"
            alt="Fbest"
            style={{ height: '90%', background: '#fff', borderRadius: 4, padding: '2px 6px' }}
          />
          <Typography.Title level={4} style={{ color: '#fff', margin: 0, whiteSpace: 'nowrap' }}>
            Modbus Controller
          </Typography.Title>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexShrink: 0 }}>
          <ProjectSelector
            onProjectInit={id => setActiveProjectId(id)}
            onProjectChange={id => { setSelectedIds(new Set()); setActiveProjectId(id ?? null) }}
          />
          <ConnectionPanel connected={connected} reconnecting={reconnecting} reconnectAttempt={reconnectAttempt} connectedPort={connectedPort} waitingPort={waitingPort} />
          <BusScanner connected={connected} />
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ flexShrink: 0 }}>
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

      <Layout style={{ flex: 1, minHeight: 0, flexDirection: siderSide === 'right' ? 'row-reverse' : 'row' }}>
        <Sider
          width={siderWidth}
          style={{
            background: '#fff',
            borderRight: siderSide === 'left' ? '1px solid #f0f0f0' : 'none',
            borderLeft: siderSide === 'right' ? '1px solid #f0f0f0' : 'none',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            onMouseDown={startResize}
            title="Потяните, чтобы изменить ширину"
            style={{
              position: 'absolute',
              top: 0, bottom: 0,
              [siderSide === 'right' ? 'left' : 'right']: -3,
              width: 6,
              cursor: 'col-resize',
              zIndex: 10,
            }}
          />
          {siderWidth >= 90 && (
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
          )}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <DeviceList
              devices={devices}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              connected={connected}
              liveness={liveness}
              hasProject={!!activeProjectId}
              sidebarWidth={siderWidth}
            />
          </div>
        </Sider>

        <Content id="app-scroll-content" style={{ padding: 24, background: '#fafafa', overflowY: 'auto', minHeight: 0 }}>
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

      <LogDrawer open={logOpen} onClose={() => setLogOpen(false)} />
    </Layout>
  )
}
