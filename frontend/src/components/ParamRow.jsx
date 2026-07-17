import { useState, useEffect, useRef } from 'react'
import { Button, InputNumber, Select, Typography, Spin, message, Tag, Tooltip } from 'antd'
import api from '../api'
import { addLog } from '../log'
import { isParamWritable, isStopOnly } from '../access'
import { formatParamValue, normalizeOptions } from '../paramFormat'

function bitsToInt(bits, bitState) {
  return bits.reduce((acc, b) => acc | ((bitState[b.bit] ?? 0) << b.bit), 0)
}

function intToBitState(bits, raw) {
  const state = {}
  bits.forEach(b => { state[b.bit] = (Math.round(raw) >> b.bit) & 1 })
  return state
}

function getAccessTooltip(device, param) {
  if (device?.access_legend) return device.access_legend[param.access] ?? param.access
  return null
}

const DEFAULT_COLS = { id: 90, desc: 220, def: 120, cur: 150, write: 290 }

export default function ParamRow({ device, param, modbusConnected, deviceRunning, injectedValue, cols, onWrite, onClearGroupValue, pendingWriteValue, onPendingWriteChange, currentValue, currentFillStamp, onReadValue, hideDeviceValue }) {
  const [value, setValue]         = useState(null)
  const [bitState, setBitState]   = useState({})
  const [editValue, setEditValue] = useState(null)
  const appliedCurrentStamp = useRef(0)
  const appliedPending = useRef(false)

  // Подготовленное (но ещё не записанное) значение подставляется в поле записи
  // само, как только приходит из хранилища устройства — без отдельной кнопки
  // "восстановить". Срабатывает один раз при получении, дальше не перетирает
  // то, что пользователь уже правит руками.
  useEffect(() => {
    if (appliedPending.current || pendingWriteValue == null) return
    appliedPending.current = true
    setEditValue(pendingWriteValue)
    if (param.type === 'bitmask' && param.bits) {
      setBitState(intToBitState(param.bits, pendingWriteValue))
    }
  }, [pendingWriteValue])

  useEffect(() => {
    if (!currentFillStamp || currentFillStamp === appliedCurrentStamp.current || currentValue == null) return
    appliedCurrentStamp.current = currentFillStamp
    setEditValue(currentValue)
    if (param.type === 'bitmask' && param.bits) {
      setBitState(intToBitState(param.bits, currentValue))
    }
  }, [currentFillStamp])
  const [reading, setReading]   = useState(false)
  const [writing, setWriting]   = useState(false)

  const C = cols ?? DEFAULT_COLS

  // Sync bitmask controls when group-read updates the value
  useEffect(() => {
    if (injectedValue !== undefined && param.type === 'bitmask' && param.bits) {
      setBitState(intToBitState(param.bits, injectedValue))
      setEditValue(injectedValue)
      setValue(injectedValue)
    }
  }, [injectedValue])

  async function handleRead() {
    setReading(true)
    try {
      const res = await api.post('/modbus/read', { deviceId: device.id, paramId: param.id })
      onClearGroupValue?.(param.id)
      setValue(res.data.value)
      onReadValue?.(param.id, res.data.value)
      if (param.type === 'bitmask' && param.bits) {
        setBitState(intToBitState(param.bits, res.data.value))
        setEditValue(res.data.value)
      }
      addLog('success', `Прочитано ${param.id} (${param.name}): ${res.data.value} ${param.unit ?? ''}`)
    } catch (e) {
      const msg = e.response?.data?.message ?? 'Ошибка чтения'
      message.error(msg)
      addLog('error', `Ошибка чтения ${param.id}: ${msg}`)
    } finally {
      setReading(false)
    }
  }

  async function handleWrite() {
    if (editValue === null || editValue === undefined) return
    setWriting(true)
    try {
      if (onWrite) {
        await onWrite(param.id, editValue)
      } else {
        await api.post('/modbus/write', { deviceId: device.id, paramId: param.id, value: editValue })
        onClearGroupValue?.(param.id)
        setValue(editValue)
        message.success('Записано успешно')
        addLog('success', `Записано ${param.id} (${param.name}): ${editValue} ${param.unit ?? ''}`)
      }
    } catch (e) {
      const msg = e.response?.data?.message ?? 'Ошибка записи'
      message.error(msg)
      addLog('error', `Ошибка записи ${param.id}: ${msg}`)
    } finally {
      setWriting(false)
    }
  }

  const isBitmask = param.type === 'bitmask' && param.bits
  const canWrite = isParamWritable(device, param)
  const stopOnly = isStopOnly(device, param)
  const blockedByRunning = stopOnly && deviceRunning === true
  const accessTooltip = getAccessTooltip(device, param)

  function renderBitTags(raw) {
    return param.bits.map(b => {
      const bitVal = (Math.round(raw) >> b.bit) & 1
      const label  = b.options?.[String(bitVal)] ?? String(bitVal)
      const active = bitVal === 1
      return (
        <Tag key={b.bit} color={active ? 'success' : 'default'} style={{ margin: '2px', fontSize: 11 }}>
          <span style={{ opacity: active ? 1 : 0.5 }}>{b.name}</span>
          <span style={{ marginLeft: 4, fontWeight: 600, color: active ? undefined : '#aaa' }}>
            {active ? '●' : '○'} {label}
          </span>
        </Tag>
      )
    })
  }

  const defaultFormatted = formatParamValue(param.type, param.default, param.unit, param.options)
  // injectedValue (from group read) takes priority; cleared on individual read/write so value wins
  const displayValue = injectedValue !== undefined ? injectedValue : value
  const currentFormatted = formatParamValue(param.type, displayValue, param.unit, param.options)

  /* ── ширина ввода в колонке "Записать" ───────────────────────── */
  const inputW = Math.max(60, C.write - 90)   // место за вычетом кнопки "Записать"

  return (
    <div style={{ borderBottom: '1px solid #f5f5f5' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 4px', minHeight: 36 }}>

        {/* Параметр / Адрес */}
        <div style={{ width: C.id, flexShrink: 0 }}>
          <Typography.Text code style={{ fontSize: 11, display: 'block' }}>{param.id}</Typography.Text>
          <Tooltip title={accessTooltip} placement="right">
            <Typography.Text style={{ fontSize: 10, color: '#999', cursor: accessTooltip ? 'help' : undefined }}>
              регистр {param.register}
              {accessTooltip && <span style={{ marginLeft: 3, opacity: 0.6 }}>[{param.access}]</span>}
            </Typography.Text>
          </Tooltip>
        </div>

        {/* Описание */}
        <div style={{ width: C.desc, flexShrink: 0, paddingRight: 8, overflow: 'hidden' }}>
          <Tooltip title={param.description ?? param.name} placement="topLeft">
            <Typography.Text
              style={{ fontSize: 12, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {param.name}
            </Typography.Text>
          </Tooltip>
        </div>

        {/* Заводское значение */}
        <div style={{ width: C.def, flexShrink: 0, overflow: 'hidden' }}>
          <Tooltip title={param.default === undefined ? 'Не задано в шаблоне — это регистр команды/статуса или показание, а не хранимая настройка' : undefined}>
            <Typography.Text
              style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', cursor: param.default === undefined ? 'help' : undefined }}
            >
              {defaultFormatted}
            </Typography.Text>
          </Tooltip>
        </div>

        {/* Значение на устройстве — читать сюда же, отдельным отступом от заводского.
            Текстовая часть фиксированной ширины, чтобы кнопка "Читать" всегда
            была в одном и том же месте независимо от длины значения в этой
            строке и в соседних (иначе кнопки "гуляют" по горизонтали). */}
        <div style={{ width: C.cur, flexShrink: 0, marginLeft: 20, display: 'flex', alignItems: 'center' }}>
          <div style={{ width: Math.max(40, C.cur - 74), flexShrink: 0, overflow: 'hidden' }}>
            {hideDeviceValue ? (
              <Tooltip title="Выбрано несколько устройств — значения по каждому смотрите в таблице результатов выше">
                <Typography.Text style={{ fontSize: 12, color: '#bbb', cursor: 'help' }}>—</Typography.Text>
              </Tooltip>
            ) : reading ? <Spin size="small" /> : (
              <Typography.Text style={{
                fontSize: 12,
                color: displayValue !== null ? '#1677ff' : '#bbb',
                fontWeight: displayValue !== null ? 500 : 400,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: 'block',
              }}>
                {isBitmask ? (displayValue !== null ? 'см. ниже' : '—') : currentFormatted}
              </Typography.Text>
            )}
          </div>
          <Button size="small" onClick={handleRead} disabled={!modbusConnected || !!onWrite} loading={reading}>
            Читать
          </Button>
        </div>

        {/* Значение для записи — та же логика: поле ввода фиксированной ширины
            (inputW), кнопка "Записать" всегда сразу после него на одном месте.
            Для нередактируемых/битовых параметров место остаётся пустым, но
            зарезервированным — колонка не "прыгает". */}
        <div style={{ width: C.write, flexShrink: 0, marginLeft: 20, display: 'flex', alignItems: 'center' }}>
          {canWrite && !isBitmask && (
            <>
              {param.type === 'enum' ? (
                <Select
                  size="small"
                  style={{ width: inputW }}
                  placeholder="Выбрать"
                  popupMatchSelectWidth={false}
                  value={editValue ?? undefined}
                  options={normalizeOptions(param.options)}
                  onChange={val => { setEditValue(val); onPendingWriteChange?.(param.id, val) }}
                />
              ) : (
                <InputNumber
                  size="small"
                  style={{ width: inputW }}
                  min={param.min}
                  max={param.max}
                  step={param.step ?? param.scale ?? 1}
                  placeholder={String(param.default ?? '')}
                  value={editValue ?? undefined}
                  onChange={val => { setEditValue(val); onPendingWriteChange?.(param.id, val) }}
                />
              )}
              <Tooltip title={blockedByRunning ? 'Остановите ПЧ перед изменением' : undefined}>
                <Button
                  size="small"
                  type="primary"
                  onClick={handleWrite}
                  disabled={!modbusConnected || editValue === null || editValue === undefined || blockedByRunning}
                  loading={writing}
                  style={{ marginLeft: 8 }}
                >
                  Записать
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Биты bitmask — отдельная строка */}
      {isBitmask && (
        <div style={{ paddingLeft: C.id + 4, paddingBottom: 8 }}>
          {reading ? (
            <Spin size="small" />
          ) : value !== null ? (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {renderBitTags(value)}
              </div>
              {canWrite && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {param.bits.map(b => (
                    <Select
                      key={b.bit}
                      size="small"
                      style={{ width: 130 }}
                      placeholder={b.name}
                      value={bitState[b.bit] ?? null}
                      popupMatchSelectWidth={false}
                      options={Object.entries(b.options ?? { 0: '0', 1: '1' }).map(([k, v]) => ({
                        value: Number(k),
                        label: `${b.name}: ${v}`,
                      }))}
                      onChange={val => {
                        const next = { ...bitState, [b.bit]: val }
                        setBitState(next)
                        const intVal = bitsToInt(param.bits, next)
                        setEditValue(intVal)
                        onPendingWriteChange?.(param.id, intVal)
                      }}
                    />
                  ))}
                  <Tooltip title={blockedByRunning ? 'Остановите ПЧ перед изменением' : undefined}>
                    <Button
                      size="small"
                      type="primary"
                      onClick={handleWrite}
                      disabled={!modbusConnected || editValue === null || editValue === undefined || blockedByRunning}
                      loading={writing}
                    >
                      Записать
                    </Button>
                  </Tooltip>
                </div>
              )}
            </>
          ) : (
            <Typography.Text style={{ color: '#bbb', fontSize: 12 }}>— нажмите Читать</Typography.Text>
          )}
        </div>
      )}
    </div>
  )
}
