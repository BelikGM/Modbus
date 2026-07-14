import { useState, useEffect } from 'react'
import { Space, Typography, Tag, Alert, message, Tabs } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import api from '../api'
import ParamGroups from './ParamGroups'
import BulkMonitor from './BulkMonitor'
import { isParamWritable } from '../access'
import { useDeviceSettings } from '../useDeviceSettings'

export default function BulkPanel({ devices, modbusConnected, onDeselect }) {
  const templateIds = [...new Set(devices.map(d => d.templateId))]
  const sameType = templateIds.length === 1

  const [deviceSettings, saveDeviceSettings] = useDeviceSettings(sameType ? devices[0].templateId : '__mixed__')
  const [visibleGroupIds, setVisibleGroupIds] = useState(new Set())

  useEffect(() => {
    if (!sameType || deviceSettings === null) return
    setVisibleGroupIds(
      deviceSettings.visibleGroups
        ? new Set(deviceSettings.visibleGroups)
        : new Set(devices[0].groups.map(g => g.id)),
    )
  }, [deviceSettings, sameType])

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

  async function handleBulkReadGroup(group) {
    let ok = 0
    const total = devices.length * group.params.length
    for (const device of devices) {
      for (const param of group.params) {
        try {
          await api.post('/modbus/read', { deviceId: device.id, paramId: param.id })
          ok++
        } catch {}
      }
    }
    message.success(`Группа «${group.name}» прочитана: ${ok} из ${total} (${devices.length} устройств)`)
  }

  async function handleBulkWriteGroup(group, pendingWrites) {
    const toWrite = group.params.filter(
      p => isParamWritable(devices[0], p) && pendingWrites[p.id] != null,
    )
    if (toWrite.length === 0) {
      message.info(`В группе «${group.name}» нет значений для записи`)
      return
    }
    let ok = 0
    for (const device of devices) {
      for (const param of toWrite) {
        try {
          await api.post('/modbus/write', { deviceId: device.id, paramId: param.id, value: pendingWrites[param.id] })
          ok++
        } catch {}
      }
    }
    message.success(`Группа «${group.name}» записана: ${ok} из ${toWrite.length * devices.length} (${devices.length} устройств)`)
  }

  async function handleBulkResetGroup(group) {
    const toWrite = group.params.filter(
      p => isParamWritable(devices[0], p) && p.default !== undefined && p.default !== null,
    )
    if (toWrite.length === 0) {
      message.info(`В группе «${group.name}» нет параметров с заводскими значениями`)
      return
    }
    let ok = 0
    for (const device of devices) {
      for (const param of toWrite) {
        try {
          await api.post('/modbus/write', { deviceId: device.id, paramId: param.id, value: param.default })
          ok++
        } catch {}
      }
    }
    message.success(`Группа «${group.name}» сброшена: ${ok} из ${toWrite.length * devices.length} (${devices.length} устройств)`)
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
          description={`Выбраны устройства разных шаблонов (${templateIds.join(', ')}) — у них разные карты регистров, групповое чтение/запись для них не имеют смысла и могут записать не те значения не в те регистры. Выберите только однотипные устройства (снимите лишние галочки в списке слева).`}
        />
      ) : (
        <Tabs
          defaultActiveKey="params"
          items={[
            {
              key: 'params',
              label: 'Параметры',
              children: (
                <ParamGroups
                  device={devices[0]}
                  modbusConnected={modbusConnected}
                  onWrite={handleBulkWrite}
                  onReadGroup={handleBulkReadGroup}
                  onWriteGroup={handleBulkWriteGroup}
                  onResetGroup={handleBulkResetGroup}
                  visibleGroupIds={visibleGroupIds}
                  onVisibleGroupIdsChange={handleVisibleGroupIdsChange}
                />
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
