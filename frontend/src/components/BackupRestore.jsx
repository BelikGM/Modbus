import { useState, useRef } from 'react'
import {
  Button, Progress, Space, Typography, Alert, Tag,
} from 'antd'
import AppModal from './AppModal'
import {
  SaveOutlined, FolderOpenOutlined, CheckOutlined, CloseOutlined,
} from '@ant-design/icons'
import api from '../api'
import { addLog } from '../log'
import { isParamWritable } from '../access'

// Params to backup: all writable, excluding the 'control' group (CMD/FSET are runtime, not config)
function getRwParams(device) {
  return device.groups
    .filter(g => g.id !== 'control')
    .flatMap(g =>
      g.params
        .filter(p => isParamWritable(device, p))
        .map(p => ({ ...p, groupId: g.id, groupName: g.name })),
    )
}

export default function BackupRestore({ device, modbusConnected }) {
  const [phase, setPhase] = useState('idle')
  // idle | reading | restore-preview | writing | summary
  const [progress, setProgress] = useState({ current: 0, total: 0, label: '' })
  const [backupData, setBackupData] = useState(null)
  const [writeResults, setWriteResults] = useState([])
  const fileRef = useRef(null)

  const rwParams = getRwParams(device)

  // ── Backup ──────────────────────────────────────────────────────────────────

  async function handleBackup() {
    setPhase('reading')
    setProgress({ current: 0, total: rwParams.length, label: '' })

    const parameters = []
    let failCount = 0

    for (let i = 0; i < rwParams.length; i++) {
      const param = rwParams[i]
      setProgress({ current: i + 1, total: rwParams.length, label: param.name })
      try {
        const { data } = await api.post('/modbus/read', {
          deviceId: device.id,
          paramId: param.id,
        })
        parameters.push({
          paramId: param.id,
          groupId: param.groupId,
          name: param.name,
          value: data.value,
          unit: param.unit ?? '',
        })
      } catch {
        failCount++
      }
    }

    const backup = {
      version: 1,
      deviceId: device.id,
      deviceName: device.name,
      slaveId: device.connection.slaveId ?? 1,
      createdAt: new Date().toISOString(),
      readCount: parameters.length,
      failCount,
      parameters,
    }

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${device.id}_backup_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)

    addLog(
      failCount === 0 ? 'success' : 'warning',
      `Резервная копия: ${parameters.length} параметров сохранено, ${failCount} ошибок — ${device.name}`,
    )
    setPhase('idle')
  }

  // ── Restore ─────────────────────────────────────────────────────────────────

  // В desktop-версии — родной диалог с началом в папке данных (см. тот же приём
  // при импорте проекта); в браузере остаётся скрытый input.
  async function handleRestoreClick() {
    if (window.modbusDesktop?.pickFile) {
      const picked = await window.modbusDesktop.pickFile({
        title: 'Выберите файл резервной копии',
        filterName: 'Резервная копия',
        extensions: ['json'],
      })
      if (picked) loadBackupText(picked.content)
      return
    }
    fileRef.current.click()
  }

  function loadBackupText(text) {
    try {
      const data = JSON.parse(text)
      if (!data.parameters || !Array.isArray(data.parameters)) throw new Error('bad format')
      setBackupData(data)
      setPhase('restore-preview')
    } catch {
      addLog('error', 'Файл резервной копии повреждён или имеет неверный формат')
    }
  }

  function handleFileLoad(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => loadBackupText(evt.target.result)
    reader.readAsText(file)
    e.target.value = ''
  }

  async function handleWrite() {
    if (!backupData) return

    const currentIds = new Set(rwParams.map(p => p.id))
    const toWrite = backupData.parameters.filter(p => currentIds.has(p.paramId))
    const results = []

    setPhase('writing')
    setProgress({ current: 0, total: toWrite.length, label: '' })

    for (let i = 0; i < toWrite.length; i++) {
      const p = toWrite[i]
      setProgress({ current: i + 1, total: toWrite.length, label: p.name })
      try {
        await api.post('/modbus/write', {
          deviceId: device.id,
          paramId: p.paramId,
          value: p.value,
        })
        results.push({ ...p, success: true })
      } catch (err) {
        results.push({ ...p, success: false, error: err.response?.data?.message ?? 'Ошибка записи' })
      }
    }

    const ok = results.filter(r => r.success).length
    const fail = results.filter(r => !r.success).length
    addLog(
      fail === 0 ? 'success' : 'warning',
      `Восстановление завершено: ${ok} записано, ${fail} ошибок — ${device.name}`,
    )
    setWriteResults(results)
    setPhase('summary')
  }

  function reset() {
    setPhase('idle')
    setBackupData(null)
    setWriteResults([])
  }

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  // сколько параметров из файла есть в текущей конфигурации
  const matchCount = backupData
    ? backupData.parameters.filter(p => rwParams.some(r => r.id === p.paramId)).length
    : 0

  return (
    <>
      {/* Скрытый file input */}
      <input
        type="file"
        accept=".json"
        ref={fileRef}
        style={{ display: 'none' }}
        onChange={handleFileLoad}
      />

      <Space>
        <Button
          icon={<SaveOutlined />}
          disabled={!modbusConnected || rwParams.length === 0}
          onClick={handleBackup}
        >
          Резервная копия
        </Button>
        <Button
          icon={<FolderOpenOutlined />}
          disabled={!modbusConnected}
          onClick={handleRestoreClick}
        >
          Восстановить
        </Button>
      </Space>

      {/* Прогресс чтения */}
      <AppModal
        title="Создание резервной копии…"
        open={phase === 'reading'}
        footer={null}
        closable={false}
        width={420}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Progress percent={pct} status="active" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {progress.current} / {progress.total} — {progress.label}
          </Typography.Text>
        </Space>
      </AppModal>

      {/* Предпросмотр восстановления */}
      <AppModal
        title="Восстановление из резервной копии"
        open={phase === 'restore-preview'}
        /* Enter здесь выключен: кнопка ЗАПИСЫВАЕТ параметры в ПЧ */
        enterSubmit={false}
        okText={`Записать ${matchCount} параметров`}
        okButtonProps={{ danger: true, disabled: matchCount === 0 }}
        cancelText="Отмена"
        onOk={handleWrite}
        onCancel={reset}
        width={480}
      >
        {backupData && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Alert
              type="warning"
              showIcon
              message="Текущие параметры устройства будут перезаписаны значениями из файла"
            />

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                <tr>
                  <td style={{ color: '#888', padding: '3px 0', width: 160 }}>Устройство в файле</td>
                  <td><strong>{backupData.deviceName}</strong></td>
                </tr>
                <tr>
                  <td style={{ color: '#888', padding: '3px 0' }}>Дата создания</td>
                  <td>{new Date(backupData.createdAt).toLocaleString('ru-RU')}</td>
                </tr>
                <tr>
                  <td style={{ color: '#888', padding: '3px 0' }}>Параметров в файле</td>
                  <td>{backupData.parameters.length}</td>
                </tr>
                <tr>
                  <td style={{ color: '#888', padding: '3px 0' }}>Будет записано</td>
                  <td>
                    <Tag color={matchCount > 0 ? 'blue' : 'orange'}>{matchCount}</Tag>
                    {matchCount < backupData.parameters.length && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        &nbsp;({backupData.parameters.length - matchCount} не найдено в конфиге)
                      </Typography.Text>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            {backupData.deviceId !== device.id && (
              <Alert
                type="error"
                showIcon
                message={`Файл создан для "${backupData.deviceId}", текущее устройство — "${device.id}"`}
              />
            )}
          </Space>
        )}
      </AppModal>

      {/* Прогресс записи */}
      <AppModal
        title="Запись параметров в устройство…"
        open={phase === 'writing'}
        footer={null}
        closable={false}
        width={420}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Progress percent={pct} status="active" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {progress.current} / {progress.total} — {progress.label}
          </Typography.Text>
        </Space>
      </AppModal>

      {/* Итоги */}
      <AppModal
        title="Результат восстановления"
        open={phase === 'summary'}
        onEnter={reset}
        footer={<Button onClick={reset}>Закрыть</Button>}
        onCancel={reset}
        width={500}
      >
        <WriteSummary results={writeResults} />
      </AppModal>
    </>
  )
}

function WriteSummary({ results }) {
  const ok = results.filter(r => r.success)
  const fail = results.filter(r => !r.success)

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space>
        <Tag color="success" icon={<CheckOutlined />}>{ok.length} записано</Tag>
        {fail.length > 0 && <Tag color="error" icon={<CloseOutlined />}>{fail.length} ошибок</Tag>}
      </Space>

      {fail.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            Параметры с ошибками:
          </Typography.Text>
          {fail.map(r => (
            <div
              key={r.paramId}
              style={{
                display: 'flex',
                gap: 8,
                fontSize: 12,
                padding: '3px 0',
                borderBottom: '1px solid #f5f5f5',
              }}
            >
              <Typography.Text code style={{ fontSize: 11 }}>{r.paramId}</Typography.Text>
              <span style={{ flex: 1, color: '#555' }}>{r.name}</span>
              <span style={{ color: '#ff4d4f' }}>{r.error}</span>
            </div>
          ))}
        </div>
      )}

      {fail.length === 0 && (
        <Alert type="success" message="Все параметры успешно записаны в устройство" showIcon />
      )}
    </Space>
  )
}
