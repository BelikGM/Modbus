import { useState, useEffect } from 'react'
import { Space, Typography, Tag, Alert, message, Tabs, Table, Button, Tooltip, Popconfirm, Progress } from 'antd'
import { CloseOutlined, ClearOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import socket from '../socket'
import ParamGroups from './ParamGroups'
import BulkMonitor from './BulkMonitor'
import ValuePresets from './ValuePresets'
import { useDeviceSettings } from '../useDeviceSettings'
import { formatParamValue } from '../paramFormat'
import { downloadCsv } from '../csv'

// Pump-Full и Pump-OWN — один и тот же физический ПЧ, у OWN просто урезанный
// (но регистрово идентичный) набор параметров — сверено вручную: все параметры
// OWN присутствуют в Full с теми же номерами регистров. Групповые операции между
// ними безопасны, поэтому они считаются одним "семейством". VL — другая карта
// регистров, отдельное семейство.
function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
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
  return <span>{formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits)}</span>
}

const TAB_LABELS = { params: 'Параметры', templates: 'Шаблоны' }

export default function BulkPanel({ devices, modbusConnected, onDeselect, activeTab, onActiveTabChange }) {
  const templateIds = [...new Set(devices.map(d => d.templateId))]
  const families = [...new Set(devices.map(d => deviceFamily(d.templateId)))]
  const sameType = families.length === 1
  // Устройство с наибольшим числом параметров в выборке (напр. Full среди Full+OWN) —
  // используется как эталон для отображения групп, чтобы не потерять группы,
  // которых нет у "урезанного" варианта.
  const templateDevice = devices.reduce((best, d) => (
    d.groups.flatMap(g => g.params).length > best.groups.flatMap(g => g.params).length ? d : best
  ), devices[0])

  const [deviceSettings, saveDeviceSettings] = useDeviceSettings(sameType ? templateDevice.templateId : '__mixed__')
  const [visibleGroupIds, setVisibleGroupIds] = useState(new Set())
  const [bulkReadResults, setBulkReadResults] = useState({}) // { [deviceId]: { [paramId]: { value/error, unit, name } } }
  const [writeProgress, setWriteProgress] = useState(null) // { done, total } — прогресс «Записать подготовленное во все»

  useEffect(() => {
    if (!sameType || deviceSettings === null) return
    setVisibleGroupIds(
      deviceSettings.visibleGroups
        ? new Set(deviceSettings.visibleGroups)
        : new Set(templateDevice.groups.map(g => g.id)),
    )
  }, [deviceSettings, sameType])

  const deviceIds = devices.map(d => d.id)

  // Разные типы ПЧ вперемешку — групповая настройка параметров лишена смысла
  // (разные карты регистров), но мониторинг каждого по своей карте — вполне
  // безопасен и полезен, поэтому доступна только вкладка "Мониторинг".
  useEffect(() => {
    if (!sameType && activeTab !== 'monitor') onActiveTabChange('monitor')
  }, [sameType])

  function handleTabChange(key) {
    if (!sameType && key !== 'monitor') {
      message.warning('При выборе ПЧ разных типов доступен только мониторинг — параметры и шаблоны требуют устройств одного семейства (Pump или VL)')
      return
    }
    onActiveTabChange(key)
  }

  // Сбрасываем накопленные результаты чтения при смене состава выбранных устройств
  useEffect(() => {
    setBulkReadResults({})
  }, [deviceIds.join(',')])

  // Групповое чтение теперь целиком выполняется внутри ParamGroups через
  // WebSocket (bulk:read:start) — сюда прилетают те же самые прогресс-события
  // просто чтобы построить таблицу "по устройствам" отдельно от собственного
  // (одноколоночного) отображения ParamGroups.
  useEffect(() => {
    function onProgress(p) {
      if (p.kind !== 'read' || !deviceIds.includes(p.deviceId)) return
      setBulkReadResults(prev => ({
        ...prev,
        [p.deviceId]: {
          ...prev[p.deviceId],
          [p.paramId]: p.error
            ? { error: p.error, name: p.name }
            : { value: p.value, unit: p.unit, name: p.name, type: p.type, options: p.options, bits: p.bits },
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
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>Адрес {d.connection.slaveId}</Typography.Text>
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

  // Экспорт всей таблицы группового чтения (все выбранные устройства сразу) —
  // по колонке на каждый ПЧ, строки-заголовки групп сохраняются. Это то, чего
  // не даёт per-device "Скачать CSV" на вкладке "Параметры" (тот выгружает
  // только одно устройство).
  function exportGroupCsv() {
    const header = ['Параметр', 'Название', ...devices.map(d => `${d.name} (Адрес ${d.connection.slaveId})`)]
    const rows = []
    let lastGroup = null
    for (const paramId of readResultRows) {
      const groupName = paramToGroup.get(paramId)?.name ?? ''
      if (groupName !== lastGroup) {
        rows.push([groupName, '', ...devices.map(() => '')])
        lastGroup = groupName
      }
      const name = devices.map(d => bulkReadResults[d.id]?.[paramId]?.name).find(Boolean) ?? paramId
      const cells = devices.map(d => {
        const entry = bulkReadResults[d.id]?.[paramId]
        if (!entry) return ''
        if (entry.error) return 'ошибка'
        return String(formatParamValue(entry.type, entry.value, entry.unit, entry.options, entry.bits))
      })
      rows.push([paramId, name, ...cells])
    }
    // Имя файла = какие группы считаны + семейство + адреса всех выбранных ПЧ:
    // "F0-EMD-PUMP-1-4", "F0-F3-EMD-PUMP-1-4", "All-Param-EMD-PUMP-1-4".
    const presentGroups = templateDevice.groups
      .filter(g => g.params.some(p => readResultRows.includes(p.id)))
      .map(g => g.id)
    const groupPart = presentGroups.length === templateDevice.groups.length
      ? 'All-Param'
      : (presentGroups.join('-') || 'params')
    const familyLabel = families[0] === 'vl' ? 'EMD-VL' : 'EMD-PUMP'
    const nums = devices.map(d => d.connection.slaveId).join('-')
    downloadCsv(
      `${groupPart}-${familyLabel}-${nums}.csv`,
      header,
      rows,
    )
  }

  // Одна кнопка «Записать подготовленное во все выбранные ПЧ»: каждый ПЧ пишет
  // СВОИ подготовленные значения (колонка «Значение для записи» / pendingWrites),
  // независимо от того, Pump это или VL — сервер берёт pendingWrites каждого
  // устройства по его собственной карте регистров. Работает и для смешанного
  // выбора Pump+VL, поэтому кнопка живёт над вкладками и доступна всегда.
  function writeAllPrepared() {
    setWriteProgress({ done: 0, total: 0 })
    let done = 0
    function onTotal(t) { if (t.kind === 'write') setWriteProgress(() => ({ done, total: t.total })) }
    function onProgress(p) {
      if (p.kind !== 'write' || !deviceIds.includes(p.deviceId)) return
      done++
      setWriteProgress(prev => ({ done, total: prev?.total ?? done }))
    }
    function cleanup() {
      socket.off('bulk:op:total', onTotal)
      socket.off('bulk:op:progress', onProgress)
      socket.off('bulk:op:done', onDone)
      socket.off('bulk:op:error', onError)
      setWriteProgress(null)
    }
    function onDone(d) {
      if (d.kind !== 'write') return
      cleanup()
      if (d.total === 0) message.info('Ни у одного выбранного ПЧ нет подготовленных значений для записи')
      else if (d.cancelled) message.warning(`Остановлено: записано ${d.ok} из ${d.total}`)
      else message.success(`Записано ${d.ok} из ${d.total} подготовленных значений (${deviceIds.length} ПЧ)`)
    }
    function onError(e) { cleanup(); message.error(e?.message ?? 'Групповая операция уже выполняется') }
    socket.on('bulk:op:total', onTotal)
    socket.on('bulk:op:progress', onProgress)
    socket.on('bulk:op:done', onDone)
    socket.on('bulk:op:error', onError)
    socket.emit('bulk:write:start', { deviceIds, usePending: true })
  }

  // BulkPanel не имеет вкладок "Устройство"/"Журнал" (это данные конкретного
  // ПЧ, не группы) — если пришли сюда из одиночного просмотра, откатываемся на
  // "Параметры".
  const tabKey = ['params', 'monitor', 'templates'].includes(activeTab) ? activeTab : 'params'

  const items = [
    {
      key: 'params',
      label: <span style={{ opacity: sameType ? 1 : 0.4 }}>{TAB_LABELS.params}</span>,
      children: !sameType ? null : (
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
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={exportGroupCsv}
                  title="Скачать всю таблицу группового чтения (все выбранные ПЧ) в CSV"
                >
                  Скачать CSV группы
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
            devices={devices}
            modbusConnected={modbusConnected}
            visibleGroupIds={visibleGroupIds}
            onVisibleGroupIdsChange={handleVisibleGroupIdsChange}
          />
        </Space>
      ),
    },
    {
      key: 'monitor',
      label: 'Мониторинг',
      children: <BulkMonitor devices={devices} modbusConnected={modbusConnected} sameType={sameType} />,
    },
    {
      key: 'templates',
      label: <span style={{ opacity: sameType ? 1 : 0.4 }}>{TAB_LABELS.templates}</span>,
      children: !sameType ? null : <ValuePresets device={templateDevice} devices={devices} />,
    },
  ]

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
              {d.name} · Адрес {d.connection.slaveId}
            </Tag>
          ))}
        </Space>
      </div>

      {/* Главная кнопка сценария «на объекте»: выбрал все ПЧ — записал всё
          подготовленное одним нажатием, даже если Pump и VL вперемешку. */}
      <div style={{ marginBottom: 16 }}>
        <Space wrap>
          <Popconfirm
            title="Записать подготовленные значения"
            description={`Каждый из ${devices.length} выбранных ПЧ получит СВОИ подготовленные значения (колонка «Значение для записи»). Идёт реальная запись регистров в устройства.`}
            okText="Записать"
            cancelText="Отмена"
            okButtonProps={{ danger: true }}
            disabled={!modbusConnected || !!writeProgress}
            onConfirm={writeAllPrepared}
          >
            <Button
              type="primary"
              icon={<UploadOutlined />}
              disabled={!modbusConnected || !!writeProgress}
              loading={!!writeProgress}
            >
              Записать подготовленное во все выбранные ({devices.length})
            </Button>
          </Popconfirm>
          {writeProgress && (
            <Button danger onClick={() => socket.emit('bulk:op:cancel')}>Остановить</Button>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Каждый ПЧ пишет свои подготовленные значения — работает и для смешанного выбора Pump + VL
          </Typography.Text>
        </Space>
        {writeProgress && (
          <Progress
            style={{ marginTop: 8 }}
            size="small"
            status="active"
            percent={writeProgress.total > 0 ? Math.round((writeProgress.done / writeProgress.total) * 100) : 0}
            format={() => `${writeProgress.done} из ${writeProgress.total} параметров`}
          />
        )}
      </div>

      {!sameType && tabKey !== 'monitor' && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="Выбраны ПЧ разных типов — доступен только мониторинг"
          description={`Выбраны устройства разных семейств (${templateIds.join(', ')}) — у них разные карты регистров, групповое чтение/запись параметров и шаблоны для них не имеют смысла и могут записать не те значения не в те регистры. Мониторинг при этом доступен — на вкладке «Мониторинг» показания каждого семейства выводятся отдельным блоком по своей карте параметров. Pump-Full и Pump-OWN между собой совместимы — это один и тот же ПЧ с урезанным набором параметров.`}
        />
      )}

      <Tabs activeKey={tabKey} onChange={handleTabChange} items={items} />
    </div>
  )
}
