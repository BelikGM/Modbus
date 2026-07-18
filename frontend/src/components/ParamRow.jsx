import { useState, useEffect, useRef, memo } from 'react'
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

const DEFAULT_COLS = { id: 90, desc: 220, def: 110, cur: 110, write: 220 }
// Тонкая полупрозрачная разделительная линия между колонками — та же, что и
// в шапке таблицы (см. ParamGroups.jsx HeaderCell), продолжена вниз в каждую
// строку параметра, чтобы сетка колонок была видна не только в заголовке.
const COL_DIVIDER = '1px solid rgba(120,120,120,0.2)'

function ParamRow({ device, param, modbusConnected, deviceRunning, injectedValue, cols, onWrite, onClearGroupValue, pendingWriteValue, onPendingWriteChange, currentValue, currentFillStamp, onReadValue, hideDeviceValue }) {
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

  return (
    <div style={{ borderBottom: '1px solid #f5f5f5' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 4px', minHeight: 36 }}>

        {/* Параметр / Адрес */}
        <div style={{ width: C.id, flexShrink: 0, paddingRight: 6, borderRight: COL_DIVIDER }}>
          <Typography.Text code style={{ fontSize: 11, display: 'block' }}>{param.id}</Typography.Text>
          <Tooltip title={accessTooltip} placement="right">
            <Typography.Text style={{ fontSize: 10, color: '#999', cursor: accessTooltip ? 'help' : undefined }}>
              регистр {param.register}
              {accessTooltip && <span style={{ marginLeft: 3, opacity: 0.6 }}>[{param.access}]</span>}
            </Typography.Text>
          </Tooltip>
        </div>

        {/* Описание */}
        <div style={{ width: C.desc, flexShrink: 0, padding: '0 8px', overflow: 'hidden', borderRight: COL_DIVIDER }}>
          <Tooltip title={param.description ?? param.name} placement="topLeft">
            <Typography.Text
              style={{ fontSize: 12, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {param.name}
            </Typography.Text>
          </Tooltip>
        </div>

        {/* Заводское значение */}
        <div style={{ width: C.def, flexShrink: 0, padding: '0 8px', overflow: 'hidden', borderRight: COL_DIVIDER }}>
          <Tooltip title={param.default === undefined ? 'Не задано в шаблоне — это регистр команды/статуса или показание, а не хранимая настройка' : undefined}>
            <Typography.Text
              style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', cursor: param.default === undefined ? 'help' : undefined }}
            >
              {defaultFormatted}
            </Typography.Text>
          </Tooltip>
        </div>

        {/* Значение на устройстве — читать сюда же, отдельным отступом от заводского.
            Текстовая часть — flex:1 (сжимается вместе с шириной колонки), кнопка
            "Читать" — flexShrink:0, поэтому она всегда на одном и том же месте
            от правого края колонки независимо от длины значения в этой строке
            и в соседних (иначе кнопки "гуляют" по горизонтали). Ширина самой
            колонки (C.cur) при этом можно поджимать — узкие значения вроде "—"
            не тянут за собой лишний пустой запас, как было раньше. */}
        <div style={{ width: C.cur, flexShrink: 0, marginLeft: 20, paddingRight: 8, display: 'flex', alignItems: 'center', gap: 6, borderRight: COL_DIVIDER }}>
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
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
          <Button size="small" onClick={handleRead} disabled={!modbusConnected || !!onWrite} loading={reading} style={{ flexShrink: 0 }}>
            Читать
          </Button>
        </div>

        {/* Значение для записи — та же логика: поле ввода flex:1, кнопка
            "Записать" flexShrink:0 сразу после него на одном месте. Для
            нередактируемых/битовых параметров место остаётся пустым, но
            зарезервированным — колонка не "прыгает". */}
        <div style={{ width: C.write, flexShrink: 0, marginLeft: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
          {canWrite && !isBitmask && (
            <>
              {param.type === 'enum' ? (
                <Select
                  size="small"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder="Выбрать"
                  popupMatchSelectWidth={false}
                  value={editValue ?? undefined}
                  options={normalizeOptions(param.options)}
                  onChange={val => { setEditValue(val); onPendingWriteChange?.(param.id, val) }}
                />
              ) : (
                <InputNumber
                  size="small"
                  style={{ flex: 1, minWidth: 0 }}
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
                  style={{ flexShrink: 0 }}
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

export default memo(ParamRow)
