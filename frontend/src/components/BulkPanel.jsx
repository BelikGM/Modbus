import { useState, useEffect } from 'react'
import { Space, Typography, Tag, Alert, message, Tabs, Table, Button } from 'antd'
import { CloseOutlined, ClearOutlined } from '@ant-design/icons'
import api from '../api'
import ParamGroups from './ParamGroups'
import BulkMonitor from './BulkMonitor'
import { isParamWritable } from '../access'
import { useDeviceSettings } from '../useDeviceSettings'

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
  if (entry.error) return <span style={{ color: '#ff4d4f', fontSize: 12 }}>ошибка</span>
  const v = entry.value
  const formatted = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v
  return <span>{formatted}{entry.unit ? ` ${entry.unit}` : ''}</span>
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

  // Сбрасываем накопленные результаты чтения при смене состава выбранных устройств
  useEffect(() => {
    setBulkReadResults({})
  }, [devices.map(d => d.id).join(',')])

  function handleVisibleGroupIdsChange(next) {
    setVisibleGroupIds(next)
    saveDeviceSettings({ visibleGroups: Array.from(next) })
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

  async function handleBulkReadGroup(group, isCancelled = () => false) {
    let ok = 0
    const total = devices.length * group.params.length
    outer:
    for (const device of devices) {
      for (const param of group.params) {
        if (isCancelled()) break outer
        try {
          const { data } = await api.post('/modbus/read', { deviceId: device.id, paramId: param.id })
          ok++
          setBulkReadResults(prev => ({
            ...prev,
            [device.id]: { ...prev[device.id], [param.id]: { value: data.value, unit: param.unit, name: param.name } },
          }))
        } catch (e) {
          setBulkReadResults(prev => ({
            ...prev,
            [device.id]: { ...prev[device.id], [param.id]: { error: e?.response?.data?.message ?? 'ошибка', name: param.name } },
          }))
        }
      }
    }
    if (isCancelled()) message.info(`Остановлено: группа «${group.name}» прочитана частично`)
    else message.success(`Группа «${group.name}» прочитана: ${ok} из ${total} (${devices.length} устройств)`)
  }

  async function handleBulkWriteGroup(group, pendingWrites, isCancelled = () => false) {
    const toWrite = group.params.filter(
      p => isParamWritable(templateDevice, p) && pendingWrites[p.id] != null,
    )
    if (toWrite.length === 0) {
      message.info(`В группе «${group.name}» нет значений для записи`)
      return
    }
    let ok = 0
    outer:
    for (const device of devices) {
      for (const param of toWrite) {
        if (isCancelled()) break outer
        try {
          await api.post('/modbus/write', { deviceId: device.id, paramId: param.id, value: pendingWrites[param.id] })
          ok++
        } catch {}
      }
    }
    if (isCancelled()) message.info(`Остановлено: группа «${group.name}» записана частично (${ok})`)
    else message.success(`Группа «${group.name}» записана: ${ok} из ${toWrite.length * devices.length} (${devices.length} устройств)`)
  }

  async function handleBulkResetGroup(group, isCancelled = () => false) {
    const toWrite = group.params.filter(
      p => isParamWritable(templateDevice, p) && p.default !== undefined && p.default !== null,
    )
    if (toWrite.length === 0) {
      message.info(`В группе «${group.name}» нет параметров с заводскими значениями`)
      return
    }
    let ok = 0
    outer:
    for (const device of devices) {
      for (const param of toWrite) {
        if (isCancelled()) break outer
        try {
          await api.post('/modbus/write', { deviceId: device.id, paramId: param.id, value: param.default })
          ok++
        } catch {}
      }
    }
    if (isCancelled()) message.info(`Остановлено: группа «${group.name}» сброшена частично (${ok})`)
    else message.success(`Группа «${group.name}» сброшена: ${ok} из ${toWrite.length * devices.length} (${devices.length} устройств)`)
  }

  const readResultParamIds = [...new Set(devices.flatMap(d => Object.keys(bulkReadResults[d.id] ?? {})))]
  const templateParamOrder = sameType ? templateDevice.groups.flatMap(g => g.params.map(p => p.id)) : []
  const readResultRows = readResultParamIds
    .slice()
    .sort((a, b) => templateParamOrder.indexOf(a) - templateParamOrder.indexOf(b))

  const paramToGroupName = new Map()
  if (sameType) {
    for (const g of templateDevice.groups) {
      for (const p of g.params) paramToGroupName.set(p.id, g.name)
    }
  }

  const readResultsColumns = [
    {
      title: 'Параметр',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 220,
      onCell: row => (row.isGroupHeader ? { colSpan: devices.length + 1, style: { background: '#fafafa' } } : {}),
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
      onCell: row => (row.isGroupHeader ? { colSpan: 0 } : {}),
      render: (_, row) => (row.isGroupHeader ? null : formatResult(bulkReadResults[d.id]?.[row.paramId])),
    })),
  ]

  const readResultsDataSource = []
  let lastGroupName = null
  for (const paramId of readResultRows) {
    const groupName = paramToGroupName.get(paramId) ?? ''
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
                        scroll={{ x: 'max-content' }}
                        sticky={{ getContainer: () => document.getElementById('app-scroll-content') || window }}
                        columns={readResultsColumns}
                        dataSource={readResultsDataSource}
                      />
                    </div>
                  )}
                  <ParamGroups
                    device={templateDevice}
                    modbusConnected={modbusConnected}
                    onWrite={handleBulkWrite}
                    onReadGroup={handleBulkReadGroup}
                    onWriteGroup={handleBulkWriteGroup}
                    onResetGroup={handleBulkResetGroup}
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
