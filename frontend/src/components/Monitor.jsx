import { useState, useEffect, useRef } from 'react'
import { Button, Card, Row, Col, Statistic, Space, Typography, Alert, Tag, notification, Select } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, DownloadOutlined, BellOutlined, EyeOutlined } from '@ant-design/icons'
import { LineChart, Line, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
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
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import socket from '../socket'
import { addLog } from '../log'
import { useDeviceSettings } from '../useDeviceSettings'

const MAX_POINTS = 60
const COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#13c2c2', '#faad14', '#f5222d']
const CONDITION_LABEL = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' }

function evalCondition(value, condition, threshold) {
  switch (condition) {
    case 'gt':  return value > threshold
    case 'gte': return value >= threshold
    case 'lt':  return value < threshold
    case 'lte': return value <= threshold
    case 'eq':  return value === threshold
    case 'neq': return value !== threshold
    default:    return false
  }
}


function SortableCard({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <Col
      ref={setNodeRef}
      xs={24} sm={12} md={8} lg={6}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <div style={{ position: 'relative' }}>
        <div
          {...attributes}
          {...listeners}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 16,
            height: 16,
            cursor: 'grab',
            zIndex: 10,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 2,
            padding: 2,
          }}
          title="Перетащить"
        >
          {[...Array(4)].map((_, i) => (
            <div key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} />
          ))}
        </div>
        {children}
      </div>
    </Col>
  )
}

export default function Monitor({ device, modbusConnected }) {
  const [running, setRunning] = useState(false)
  const [data, setData] = useState({})
  const [history, setHistory] = useState({})
  const [error, setError] = useState(null)
  const [alertStatus, setAlertStatus] = useState({})
  const [cardOrder, setCardOrder] = useState(null)
  const [visibleParams, setVisibleParams] = useState(null)
  const [deviceSettings, saveDeviceSettings] = useDeviceSettings(device.templateId ?? device.id)

  useEffect(() => {
    if (deviceSettings === null) return
    setCardOrder(deviceSettings.monitorOrder ?? null)
    setVisibleParams(deviceSettings.monitorVisible ?? null)
  }, [deviceSettings])

  const activeAlertsRef = useRef(new Set())
  const deviceRef = useRef(device)
  useEffect(() => { deviceRef.current = device })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function getParamName(paramId) {
    for (const group of deviceRef.current.groups) {
      const p = group.params.find(p => p.id === paramId)
      if (p) return p.name
    }
    return paramId
  }

  function checkAlerts(incoming) {
    const alerts = deviceRef.current.alerts ?? []
    if (!alerts.length) return

    const updates = {}
    for (const alert of alerts) {
      const entry = incoming[alert.paramId]
      if (!entry || entry.error || entry.value === undefined) continue

      const fired = evalCondition(entry.value, alert.condition, alert.threshold)
      const wasActive = activeAlertsRef.current.has(alert.id)
      updates[alert.id] = fired

      if (fired && !wasActive) {
        activeAlertsRef.current.add(alert.id)
        const v = Number(entry.value)
        const formatted = Number.isInteger(v) ? String(v) : v.toFixed(1)
        const msg = alert.message.replace('{{value}}', formatted)
        notification[alert.level]?.({ message: 'Оповещение', description: msg, duration: 0 })
        addLog(alert.level, `Оповещение: ${msg}`)
      } else if (!fired && wasActive) {
        activeAlertsRef.current.delete(alert.id)
        const label = `${getParamName(alert.paramId)} ${CONDITION_LABEL[alert.condition]} ${alert.threshold}`
        addLog('info', `Оповещение снято: ${label}`)
      }
    }
    setAlertStatus(prev => ({ ...prev, ...updates }))
  }

  function clearAlerts() {
    activeAlertsRef.current.clear()
    setAlertStatus({})
  }

  useEffect(() => {
    function onMonitorData({ deviceId, data: incoming }) {
      if (deviceId !== device.id) return
      setData(incoming)
      checkAlerts(incoming)
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      setHistory(prev => {
        const next = { ...prev }
        for (const [id, entry] of Object.entries(incoming)) {
          if (entry.error || entry.value === undefined) continue
          const arr = prev[id] ?? []
          next[id] = [...arr.slice(-(MAX_POINTS - 1)), { t: time, v: entry.value }]
        }
        return next
      })
    }
    function onError({ message: msg }) {
      setError(msg)
      addLog('error', `Ошибка мониторинга: ${msg}`)
    }
    socket.on('monitor:data', onMonitorData)
    socket.on('modbus:error', onError)
    return () => {
      socket.off('monitor:data', onMonitorData)
      socket.off('modbus:error', onError)
    }
  }, [device.id])

  useEffect(() => {
    return () => {
      socket.emit('monitor:stop')
      setRunning(false)
      setData({})
      setHistory({})
      clearAlerts()
    }
  }, [device.id])

  function toggle() {
    if (running) {
      socket.emit('monitor:stop')
      setRunning(false)
      setData({})
      setHistory({})
      clearAlerts()
      addLog('info', `Мониторинг остановлен: ${device.name}`)
    } else {
      socket.emit('monitor:start', { deviceId: device.id, paramIds: monitorParams.map(p => p.id) })
      setRunning(true)
      addLog('info', `Мониторинг запущен: ${device.name}`)
    }
  }

  function exportCsv() {
    const params = monitorParams
    const allTimes = [...new Set(
      params.flatMap(p => (history[p.id] ?? []).map(pt => pt.t))
    )].sort()

    const header = ['Время', ...params.map(p => `${p.id} ${p.unit ? `(${p.unit})` : ''}`.trim())]
    const rows = allTimes.map(t => {
      const row = [t]
      for (const p of params) {
        const pt = (history[p.id] ?? []).find(x => x.t === t)
        row.push(pt !== undefined ? pt.v : '')
      }
      return row
    })

    const csv = [header, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'))
      .join('\r\n')

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `monitor_${device.id}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(url)
    addLog('success', `Экспорт CSV: ${rows.length} строк, ${params.length} параметров`)
  }

  function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedParams.findIndex(p => p.id === active.id)
    const newIndex = orderedParams.findIndex(p => p.id === over.id)
    const newOrder = arrayMove(orderedParams, oldIndex, newIndex).map(p => p.id)
    setCardOrder(newOrder)
    saveDeviceSettings({ monitorOrder: newOrder })
  }

  // Prefer F0 group; fall back to first group with readable numeric params
  const f0Group = device.groups.find(g => g.id === 'F0')
    ?? device.groups.find(g => g.params?.some(p => p.access === 'read' && (p.type === 'float' || p.type === 'integer')))
  const monitorParams = (f0Group?.params ?? []).filter(
    p => p.access === 'read' && (p.type === 'float' || p.type === 'integer') && p.id !== 'F0.00'
  )

  const orderedParams = cardOrder
    ? [...monitorParams].sort((a, b) => {
        const ai = cardOrder.indexOf(a.id)
        const bi = cardOrder.indexOf(b.id)
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
      })
    : monitorParams

  const activeVisible = visibleParams ?? monitorParams.map(p => p.id)
  const visibleOrdered = orderedParams.filter(p => activeVisible.includes(p.id))

  function handleVisibleChange(selected) {
    setVisibleParams(selected)
    saveDeviceSettings({ monitorVisible: selected })
  }

  const configuredAlerts = device.alerts ?? []

  function getErrorText(code) {
    if (!code && code !== 0) return null
    return device.errorCodes?.[String(Math.round(code))] ?? null
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {error && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} />
      )}

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
        <Button
          icon={<DownloadOutlined />}
          onClick={exportCsv}
          disabled={Object.values(history).every(h => !h?.length)}
        >
          Экспорт CSV
        </Button>
        {monitorParams.length > 0 && (
          <Select
            mode="multiple"
            allowClear
            placeholder="Показать графики"
            suffixIcon={<EyeOutlined />}
            value={activeVisible}
            onChange={handleVisibleChange}
            onClear={() => handleVisibleChange(monitorParams.map(p => p.id))}
            maxTagCount="responsive"
            popupMatchSelectWidth={false}
            style={{ width: 220 }}
            options={monitorParams.map(p => ({ value: p.id, label: p.name }))}
          />
        )}
        {!modbusConnected && (
          <Typography.Text type="secondary">Требуется подключение к порту</Typography.Text>
        )}
      </Space>

      {/* Панель пороговых оповещений */}
      {configuredAlerts.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <BellOutlined />
              <span>Пороговые оповещения</span>
            </Space>
          }
          styles={{ body: { padding: '8px 12px' } }}
        >
          <Space wrap>
            {configuredAlerts.map(alert => {
              const triggered = alertStatus[alert.id]
              const paramName = getParamName(alert.paramId)
              const condLabel = CONDITION_LABEL[alert.condition] ?? alert.condition
              let color = 'default'
              if (running) {
                if (triggered) color = alert.level === 'error' ? 'error' : 'warning'
                else if (triggered === false) color = 'success'
              }
              return (
                <Tag key={alert.id} color={color} style={{ fontSize: 12 }}>
                  {paramName} {condLabel} {alert.threshold}
                </Tag>
              )
            })}
          </Space>
          {!running && (
            <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
              Оповещения активны только во время мониторинга
            </Typography.Text>
          )}
        </Card>
      )}

      {!monitorParams.length && (
        <Typography.Text type="secondary">
          Нет параметров для мониторинга (нужны параметры с access: "read" и type: "float" или "integer")
        </Typography.Text>
      )}

      {running && monitorParams.length > 0 && Object.keys(data).length > 0 &&
       monitorParams.every(p => data[p.id]?.error) && (
        <Alert
          type="warning"
          showIcon
          message="Устройство не отвечает на запросы группы F0"
          description={`Все ${monitorParams.length} параметров возвращают ошибку: ${data[monitorParams[0]?.id]?.error ?? ''}. Проверьте настройки симулятора (регистры 0–11) или подключение к реальному устройству.`}
          style={{ marginBottom: 8 }}
        />
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visibleOrdered.map(p => p.id)} strategy={rectSortingStrategy}>
          <Row gutter={[16, 16]}>
            {visibleOrdered.map((param, idx) => {
              const entry = data[param.id]
              const hist  = history[param.id] ?? []
              const colorIdx = monitorParams.findIndex(p => p.id === param.id)
              const color = COLORS[colorIdx % COLORS.length]
              const isError = param.id === 'F0.10' && entry?.value
              const errText = isError ? getErrorText(entry.value) : null

              const hasTriggeredAlert = configuredAlerts.some(
                a => a.paramId === param.id && alertStatus[a.id]
              )

              return (
                <SortableCard key={param.id} id={param.id}>
                  <Card
                    size="small"
                    title={<span style={{ fontSize: 12 }}>{param.name}</span>}
                    style={{
                      minHeight: 110,
                      borderColor: hasTriggeredAlert ? '#ff7875' : undefined,
                    }}
                    styles={{ body: { paddingBottom: 8 } }}
                  >
                    {entry?.error ? (
                      <Typography.Text type="danger" style={{ fontSize: 12 }}>
                        {entry.error}
                      </Typography.Text>
                    ) : (
                      <>
                        <Statistic
                          value={entry?.value ?? '—'}
                          suffix={param.unit}
                          precision={param.type === 'float' ? 2 : 0}
                          valueStyle={{
                            fontSize: 18,
                            color: (isError && entry?.value !== 0) || hasTriggeredAlert
                              ? '#ff4d4f'
                              : entry ? color : '#bbb',
                          }}
                        />

                        {errText && entry?.value !== 0 && (
                          <Tag color="error" style={{ marginTop: 4, fontSize: 11, whiteSpace: 'normal' }}>
                            {errText}
                          </Tag>
                        )}
                        {isError && entry?.value === 0 && (
                          <Tag color="success" style={{ marginTop: 4, fontSize: 11 }}>Нет ошибки</Tag>
                        )}

                        {hist.length > 1 && (
                          <ResponsiveContainer width="100%" height={36}>
                            <LineChart data={hist}>
                              <YAxis domain={['auto', 'auto']} hide />
                              <Tooltip
                                formatter={v => [`${Number(v).toFixed(param.type === 'float' ? 2 : 0)} ${param.unit ?? ''}`, param.name]}
                                labelFormatter={l => `Время: ${l}`}
                                contentStyle={{ fontSize: 11 }}
                              />
                              <Line
                                type="monotone"
                                dataKey="v"
                                stroke={hasTriggeredAlert ? '#ff4d4f' : color}
                                dot={false}
                                strokeWidth={1.5}
                                isAnimationActive={false}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        )}
                      </>
                    )}
                  </Card>
                </SortableCard>
              )
            })}
          </Row>
        </SortableContext>
      </DndContext>
    </Space>
  )
}
