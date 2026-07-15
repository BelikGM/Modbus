import { useState, useEffect } from 'react'
import { Space, Typography, Tag, Alert, message, Tabs, Table, Button, Tooltip } from 'antd'
import { CloseOutlined, ClearOutlined } from '@ant-design/icons'
import api from '../api'
import socket from '../socket'
import ParamGroups from './ParamGroups'
import BulkMonitor from './BulkMonitor'
import { useDeviceSettings } from '../useDeviceSettings'
import { formatParamValue } from '../paramFormat'

// Pump-Full и Pump-OWN — один и тот же физический ПЧ, у OWN просто урезанный
// (но регистрово идентичный) набор параметров — сверено вручную: все параметры
// OWN присутствуют в Full с теми же номерами регистров. Групповые операции между
// ними безопасны, поэтому они считаются одним "семейством". VH — другая карта
// регистров, отдельное семейство.
function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vh') ? 'vh' : 'pump'
}

function formatResult(entry) {
  if (!entry) return <span style={{ color: '#bbb' }}>—</span>
  if (entry.error) {
    return (
      <Tooltip title={entry.error}>
        <span style={{ color: '#ff4d4f', fontSize: 12, cursor: 'help', textDecoration: 'underline dotted' }}>ошибка</span>
      </Tooltip>
    )
  }
  return <span>{formatParamValue(entry.type, entry.value, entry.unit, entry.options)}</span>
}

export default function BulkPanel({ devices, modbusConnected, onDeselect }) {
  const templateIds = [...new Set(devices.map(d => d.templateId))]
  const families = [...new Set(devices.map(d => deviceFamily(d.templateId)))]
  const sameType = families.length === 1
  // Устройство с наибольшим числом параметров в выборке (напр. Full среди Full+OWN) —
  // используется как эталон для отображения групп, чтобы не потерять группы,
  // которых нет у "урезанного" варианта.
  const templateDevice = sameType
    ? devices.reduce((best, d) => (
        d.groups.flatMap(g => g.params).length > best.groups.flatMap(g => g.params).length ? d : best
      ), devices[0])
    : devices[0]

  const [deviceSettings, saveDeviceSettings] = useDeviceSettings(sameType ? templateDevice.templateId : '__mixed__')
  const [visibleGroupIds, setVisibleGroupIds] = useState(new Set())
  const [bulkReadResults, setBulkReadResults] = useState({}) // { [deviceId]: { [paramId]: { value/error, unit, name } } }

  useEffect(() => {
    if (!sameType || deviceSettings === null) return
    setVisibleGroupIds(
      deviceSettings.visibleGroups
        ? new Set(deviceSettings.visibleGroups)
        : new Set(templateDevice.groups.map(g => g.id)),
    )
  }, [deviceSettings, sameType])

  const deviceIds = devices.map(d => d.id)

  // Сбрасываем накопленные результаты чтения при смене состава выбранных устройств
  useEffect(() => {
    setBulkReadResults({})
  }, [deviceIds.join(',')])

  // Групповое чтение/запись теперь целиком выполняется внутри ParamGroups через
  // WebSocket (bulk:read:start/bulk:write:start) — сюда прилетают те же самые
  // прогресс-события просто чтобы построить таблицу "по устройствам", отдельно
  // от собственного (одноколоночного) отображения ParamGroups.
  useEffect(() => {
    function onProgress(p) {
      if (p.kind !== 'read' || !deviceIds.includes(p.deviceId)) return
      setBulkReadResults(prev => ({
        ...prev,
        [p.deviceId]: {
          ...prev[p.deviceId],
          [p.paramId]: p.error
            ? { error: p.error, name: p.name }
            : { value: p.value, unit: p.unit, name: p.name, type: p.type, options: p.options },
        },
      }))
    }
    socket.on('bulk:op:progress', onProgress)
    return () => socket.off('bulk:op:progress', onProgress)
  }, [deviceIds.join(',')])

  function handleVisibleGroupIdsChange(next) {
    setVisibleGroupIds(next)
    saveDeviceSettings({ visibleGroups: Array.from(next) })
    // При любом изменении набора отображаемых групп таблицу результатов чтения
    // очищаем целиком — даже если это та же самая единственная группа, что и
    // была, старые значения не должны "мелькать" до нового чтения.
    setBulkReadResults({})
  }

  async function handleBulkWrite(paramId, value) {
    let ok = 0
    for (const device of devices) {
      try {
        await api.post('/modbus/write', { deviceId: device.id, paramId, value })
        ok++
      } catch {}
    }
    message.success(`Записано на ${ok} из ${devices.length} устройств`)
  }

  const paramToGroup = new Map() // paramId -> { id, name }
  if (sameType) {
    for (const g of templateDevice.groups) {
      for (const p of g.params) paramToGroup.set(p.id, { id: g.id, name: g.name })
    }
  }

  // Показываем только параметры групп, которые СЕЙЧАС отмечены галочками —
  // если группу сняли с отображения (или она уже не в выборке), её старые
  // результаты чтения пропадают из таблицы сами, без явной очистки состояния
  // (что удобно: если галочку вернуть обратно, кэш уже тут).
  const readResultParamIds = [...new Set(devices.flatMap(d => Object.keys(bulkReadResults[d.id] ?? {})))]
    .filter(paramId => visibleGroupIds.has(paramToGroup.get(paramId)?.id))
  const templateParamOrder = sameType ? templateDevice.groups.flatMap(g => g.params.map(p => p.id)) : []
  const readResultRows = readResultParamIds
    .slice()
    .sort((a, b) => templateParamOrder.indexOf(a) - templateParamOrder.indexOf(b))

  const readResultsColumns = [
    {
      title: 'Параметр',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 220,
      render: (name, row) => row.isGroupHeader
        ? <Typography.Text strong style={{ fontSize: 12 }}>{row.groupName}</Typography.Text>
        : name,
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
      render: (_, row) => (row.isGroupHeader ? null : formatResult(bulkReadResults[d.id]?.[row.paramId])),
    })),
  ]

  const readResultsDataSource = []
  let lastGroupName = null
  for (const paramId of readResultRows) {
    const groupName = paramToGroup.get(paramId)?.name ?? ''
    if (groupName !== lastGroupName) {
      readResultsDataSource.push({ key: `group-header-${groupName || paramId}`, isGroupHeader: true, groupName })
      lastGroupName = groupName
    }
    const name = devices.map(d => bulkReadResults[d.id]?.[paramId]?.name).find(Boolean) ?? paramId
    readResultsDataSource.push({ key: paramId, paramId, name })
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Typography.Text strong>Выбрано:</Typography.Text>
        <Space wrap size={4}>
          {devices.map(d => (
            <Tag
              key={d.id}
              color={sameType ? 'blue' : 'orange'}
              closable
              closeIcon={<CloseOutlined />}
              onClose={() => onDeselect(d.id)}
            >
              {d.name} · ID {d.connection.slaveId}
            </Tag>
          ))}
        </Space>
      </div>

      {!sameType ? (
        <Alert
          type="warning"
          showIcon
          message="Недопустима групповая работа с ПЧ разных типов"
          description={`Выбраны устройства разных семейств (${templateIds.join(', ')}) — у них разные карты регистров, групповое чтение/запись для них не имеют смысла и могут записать не те значения не в те регистры. Выберите только однотипные устройства (снимите лишние галочки в списке слева). Pump-Full и Pump-OWN между собой совместимы — это один и тот же ПЧ с урезанным набором параметров.`}
        />
      ) : (
        <Tabs
          defaultActiveKey="params"
          items={[
            {
              key: 'params',
              label: 'Параметры',
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  {readResultRows.length > 0 && (
                    <div>
                      <Space style={{ marginBottom: 8 }}>
                        <Typography.Text strong style={{ fontSize: 12 }}>Результаты группового чтения</Typography.Text>
                        <Button
                          size="small"
                          icon={<ClearOutlined />}
                          onClick={() => setBulkReadResults({})}
                        >
                          Очистить
                        </Button>
                      </Space>
                      <Table
                        size="small"
                        pagination={false}
                        bordered
                        scroll={{ x: 'max-content', y: 'calc(100vh - 280px)' }}
                        rowClassName={row => (row.isGroupHeader ? 'group-header-row' : '')}
                        columns={readResultsColumns}
                        dataSource={readResultsDataSource}
                      />
                    </div>
                  )}
                  <ParamGroups
                    device={templateDevice}
                    deviceIds={deviceIds}
                    modbusConnected={modbusConnected}
                    onWrite={handleBulkWrite}
                    visibleGroupIds={visibleGroupIds}
                    onVisibleGroupIdsChange={handleVisibleGroupIdsChange}
                  />
                </Space>
              ),
            },
            {
              key: 'monitor',
              label: 'Монитор',
              children: <BulkMonitor devices={devices} modbusConnected={modbusConnected} />,
            },
          ]}
        />
      )}
    </div>
  )
}
