import { useState, useEffect, useRef } from 'react'
// ВНИМАНИЕ: Tooltip здесь ДВА разных — у recharts (подсказка на графике) и у
// antd (подсказка при наведении на элемент). Импортируем antd-версию под
// псевдонимом, иначе recharts-Tooltip вне графика молча рендерит пустоту.
import { Button, Card, Row, Col, Statistic, Space, Typography, Alert, Tag, notification, Select, Tooltip as AntTooltip } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, DownloadOutlined, BellOutlined, EyeOutlined, DeleteOutlined } from '@ant-design/icons'
import { LineChart, Line, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
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
import { getMonitorParams } from '../monitorParams'
import { setBusy } from '../busy'
import { isGenericBitLabel } from '../paramFormat'

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


// Зона удаления: появляется вверху экрана, как только начали тащить карточку.
// Дотащил сюда и отпустил — параметр убирается из мониторинга (то же самое, что
// снять с него галочку в списке «показать графики»), вернуть можно там же.
const TRASH_ID = '__monitor-trash__'

// Корзина: закрытая крышка — пока карточку только тащат, открытая — когда её
// уже поднесли к зоне и можно отпускать.
function TrashIcon({ open }) {
  return (
    // viewBox с запасом сверху (y от -6) — открытая крышка приподнимается и
    // поворачивается, без запаса её верхний край обрезался.
    <svg width="54" height="60" viewBox="0 -6 24 30" fill="none" stroke="#ff4d4f" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ overflow: 'visible' }}>
      {/* крышка: при открытии приподнята и повёрнута */}
      <g style={{ transform: open ? 'translateY(-4px) rotate(-20deg)' : 'none', transformOrigin: '5px 6px', transition: 'transform 0.15s' }}>
        <path d="M3 6h18" />
        <path d="M9 6V4h6v2" />
      </g>
      <path d="M6 8v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8" />
      <path d="M10 11v7M14 11v7" />
    </svg>
  )
}

function TrashZone({ active }) {
  const { setNodeRef, isOver } = useDroppable({ id: TRASH_ID })
  if (!active) return null
  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 180, zIndex: 1200,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
        // Текст и корзина опущены от самого верха: у открытой крышки должно
        // быть место, иначе она уезжала за край и не отрисовывалась.
        gap: 12, paddingTop: 26,
        // Тёмно-серая «асфальтовая» заливка: вверху плотная, книзу растворяется,
        // чтобы зона не перекрывала интерфейс глухой панелью.
        background: isOver
          ? 'linear-gradient(to bottom, rgba(48,50,54,0.97) 0%, rgba(48,50,54,0.80) 50%, rgba(48,50,54,0) 100%)'
          : 'linear-gradient(to bottom, rgba(62,65,70,0.94) 0%, rgba(62,65,70,0.62) 50%, rgba(62,65,70,0) 100%)',
        color: '#fff', fontSize: 14, fontWeight: 500, textShadow: '0 1px 2px rgba(0,0,0,0.55)',
        transition: 'background 0.15s',
        pointerEvents: 'auto',
      }}
    >
      <span>{isOver ? 'Отпустите — параметр будет убран из мониторинга' : 'Перетащите сюда, чтобы убрать параметр из мониторинга'}</span>
      <TrashIcon open={isOver} />
    </div>
  )
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

  // Единица измерения параметра — чтобы порог показывался как «70 °C», а не
  // просто «70» (по голому числу непонятно, градусы это, амперы или герцы).
  function getParamUnit(paramId) {
    for (const group of deviceRef.current.groups) {
      const p = group.params.find(p => p.id === paramId)
      if (p) return p.unit ?? ''
    }
    return ''
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
        const unit = getParamUnit(alert.paramId)
        const label = `${getParamName(alert.paramId)} ${CONDITION_LABEL[alert.condition]} ${alert.threshold}${unit ? ` ${unit}` : ''}`
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
      socket.emit('monitor:stop', { deviceId: device.id })
      setRunning(false)
      setBusy('monitor', false) // размонтировали компонент — блокировку снимаем
      setData({})
      setHistory({})
      clearAlerts()
    }
  }, [device.id])

  function toggle() {
    if (running) {
      socket.emit('monitor:stop', { deviceId: device.id })
      setRunning(false)
      setBusy('monitor', false)
      setData({})
      setHistory({})
      clearAlerts()
      addLog('info', `Мониторинг остановлен: ${device.name}`)
    } else {
      socket.emit('monitor:start', { deviceId: device.id, paramIds: monitorParams.map(p => p.id) })
      setRunning(true)
      // Пока идёт опрос, переключаться на другой ПЧ/вкладку нельзя — иначе
      // мониторинг остаётся висеть на прежнем устройстве.
      setBusy('monitor', true, 'мониторинг')
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

  const [draggingId, setDraggingId] = useState(null)

  function handleDragEnd(event) {
    const { active, over } = event
    setDraggingId(null)
    if (!over) return
    // Бросили в зону удаления вверху — убираем параметр из мониторинга
    // (эквивалент снятия галочки, значение сохраняется и возвращается).
    if (over.id === TRASH_ID) {
      const removed = monitorParams.find(p => p.id === active.id)
      handleVisibleChange(activeVisible.filter(id => id !== active.id))
      addLog('info', `Параметр убран из мониторинга: ${removed?.name ?? active.id}`)
      return
    }
    if (active.id === over.id) return
    const oldIndex = orderedParams.findIndex(p => p.id === active.id)
    const newIndex = orderedParams.findIndex(p => p.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const newOrder = arrayMove(orderedParams, oldIndex, newIndex).map(p => p.id)
    setCardOrder(newOrder)
    saveDeviceSettings({ monitorOrder: newOrder })
  }

  const monitorParams = getMonitorParams(device)

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
          <>
            <Select
              mode="multiple"
              allowClear
              placeholder="Показать графики"
              suffixIcon={<EyeOutlined />}
              value={activeVisible}
              onChange={handleVisibleChange}
              onClear={() => handleVisibleChange([])}
              maxTagCount={0}
              // По умолчанию antd пишет «+N ...» — непонятно, что за «плюс».
              // Показываем прямо, сколько параметров выбрано.
              maxTagPlaceholder={() => `${activeVisible.length} из ${monitorParams.length} параметров`}
              popupMatchSelectWidth={false}
              style={{ width: 240 }}
              options={monitorParams.map(p => ({ value: p.id, label: p.name }))}
            />
            <Button
              size="small"
              onClick={() => handleVisibleChange(monitorParams.map(p => p.id))}
              disabled={activeVisible.length === monitorParams.length}
            >
              Выделить все
            </Button>
            <Button
              size="small"
              onClick={() => handleVisibleChange([])}
              disabled={activeVisible.length === 0}
            >
              Снять все
            </Button>
          </>
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
              const unit = getParamUnit(alert.paramId)
              const condLabel = CONDITION_LABEL[alert.condition] ?? alert.condition
              // Пока мониторинг не запущен, правило всё равно показываем —
              // спокойным синим, чтобы было видно, ЧТО и по какому порогу
              // отслеживается (раньше неактивные правила выглядели пусто).
              let color = 'processing'
              if (running) {
                if (triggered) color = alert.level === 'error' ? 'error' : 'warning'
                else if (triggered === false) color = 'success'
              }
              // Формулируем как УСЛОВИЕ СРАБАТЫВАНИЯ, а не как факт: строка
              // «Температура ПЧ > 70 °C» читалась так, будто сейчас больше 70 и
              // это норма. Теперь «сработает при > 70 °C», а рядом — текущее
              // значение и вердикт (норма / сработало).
              const cur = data[alert.paramId]
              const curNum = cur && !cur.error && typeof cur.value === 'number' ? cur.value : null
              const curText = curNum === null
                ? null
                : `${Number.isInteger(curNum) ? curNum : curNum.toFixed(2)}${unit ? ` ${unit}` : ''}`
              const ruleName = alert.label ?? paramName
              const condText = `сработает при ${condLabel} ${alert.threshold}${unit ? ` ${unit}` : ''}`
              const statusText = !running
                ? 'мониторинг не запущен'
                : curText === null ? 'нет данных'
                : triggered ? `СЕЙЧАС ${curText} — сработало`
                : `сейчас ${curText} — норма`
              return (
                <AntTooltip key={alert.id} title={`Параметр: ${paramName}`}>
                  <Tag color={color} style={{ fontSize: 12, cursor: 'help' }}>
                    {`${ruleName}: ${condText} · ${statusText}`}
                  </Tag>
                </AntTooltip>
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={e => setDraggingId(e.active.id)}
        onDragCancel={() => setDraggingId(null)}
        onDragEnd={handleDragEnd}
      >
        <TrashZone active={!!draggingId} />
        <SortableContext items={visibleOrdered.map(p => p.id)} strategy={rectSortingStrategy}>
          <Row gutter={[16, 16]}>
            {visibleOrdered.map((param, idx) => {
              const entry = data[param.id]
              const hist  = history[param.id] ?? []
              const colorIdx = monitorParams.findIndex(p => p.id === param.id)
              const color = COLORS[colorIdx % COLORS.length]
              // Подсвечиваем ТЕКУЩИЙ код аварии: у Pump это F0.27, у VL —
              // FAULT_CODE/D0.45. F0.10 — это архивная «последняя запись об
              // аварии», она остаётся ненулевой и после устранения аварии,
              // поэтому подсветка по ней горела бы вечно.
              const isError = ['F0.27', 'FAULT_CODE', 'D0.45'].includes(param.id) && entry?.value
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
                    ) : param.type === 'bitmask' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {entry?.value == null || !Array.isArray(param.bits) || !param.bits.length ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>
                        ) : param.bits.map(b => {
                          const bitVal = (Math.round(entry.value) >> b.bit) & 1
                          const label = b.options?.[String(bitVal)] ?? String(bitVal)
                          return (
                            <Typography.Text key={b.bit} style={{ fontSize: 12 }}>
                              {isGenericBitLabel(label) && <>{b.name}: </>}
                              <span style={{ fontWeight: 500 }}>{label}</span>
                            </Typography.Text>
                          )
                        })}
                      </div>
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
