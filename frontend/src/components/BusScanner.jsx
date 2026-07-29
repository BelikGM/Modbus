import { useState, useEffect } from 'react'
import {
  Button, Modal, InputNumber, Progress, Space,
  Tag, Typography, Alert, Row, Col, Divider, Tooltip, List, Spin, AutoComplete,
} from 'antd'
import { ApartmentOutlined, CloseCircleOutlined, PlusCircleOutlined, CheckCircleOutlined, ExclamationCircleOutlined, LoadingOutlined, InfoCircleOutlined, ThunderboltOutlined, RedoOutlined } from '@ant-design/icons'
import socket from '../socket'
import api from '../api'
import { addLog } from '../log'

const PARITY_LETTER = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }
function formatCombo(c) {
  return `${c.baudRate} бод, ${c.dataBits}${PARITY_LETTER[c.parity] ?? c.parity}${c.stopBits}`
}

export default function BusScanner({ connected }) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [from, setFrom] = useState(1)
  // 1..247 — весь допустимый диапазон Modbus RTU slave-адресов (0 —
  // широковещательный адрес, 248..255 зарезервированы); бэкенд и так
  // ограничивает "до" этим значением (см. modbus.gateway.ts), так что по
  // умолчанию сразу сканируем всё, а не только первые 32 адреса.
  const [to, setTo] = useState(247)
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(0)
  const [found, setFound] = useState([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)
  const [identifying, setIdentifying] = useState(false)
  const [identifyResults, setIdentifyResults] = useState([]) // { slaveId, model, deviceId?, name?, error? }
  const [identifyDone, setIdentifyDone] = useState(false)
  const [retryingIds, setRetryingIds] = useState(new Set()) // slaveId'ы, для которых сейчас идёт повторное определение
  const [probeModal, setProbeModal] = useState(null) // { slaveId, loading, data }

  const [ports, setPorts] = useState([])
  const [loadingPorts, setLoadingPorts] = useState(false)
  const [selectedPort, setSelectedPort] = useState(null)
  const [sweeping, setSweeping] = useState(false)
  const [sweepProgress, setSweepProgress] = useState(null) // { comboIndex, totalCombos, combo }
  const [sweepResult, setSweepResult] = useState(null) // null | 'notfound' | combo


  useEffect(() => {
    function onProgress({ current, total: t, found: f }) {
      setProgress(current)
      setTotal(t)
      setFound(f)
    }
    function onDone({ found: f }) {
      setRunning(false)
      setDone(true)
      setFound(f)
      addLog(
        f.length > 0 ? 'success' : 'info',
        f.length > 0
          ? `Сканирование завершено. Найдено ${f.length} устройств: Slave ID ${f.join(', ')}`
          : 'Сканирование завершено. Устройства не найдены.',
      )
    }
    function onError({ message: msg }) {
      setRunning(false)
      setError(msg)
      addLog('error', `Ошибка сканирования шины: ${msg}`)
    }
    function onIdentifyProgress(result) {
      // При повторной попытке для уже известного slaveId — заменяем старую
      // строку результата новой, а не добавляем ещё одну (иначе один и тот
      // же адрес задваивался бы в списке после "Определить снова").
      setIdentifyResults(prev => {
        const idx = prev.findIndex(r => r.slaveId === result.slaveId)
        if (idx === -1) return [...prev, result]
        const next = [...prev]
        next[idx] = result
        return next
      })
      setRetryingIds(prev => {
        if (!prev.has(result.slaveId)) return prev
        const next = new Set(prev)
        next.delete(result.slaveId)
        return next
      })
    }
    function onIdentifyDone() {
      setIdentifying(false)
      setIdentifyDone(true)
    }
    function onAutoProgress(p) {
      setSweepProgress(p)
    }
    function onAutoFound({ combo }) {
      setSweeping(false)
      setSweepResult(combo)
      setRunning(true) // сразу за этим сервер начинает bus:scan по диапазону
      addLog('success', `Настройки шины подобраны: ${formatCombo(combo)} (${combo.portPath})`)
    }
    function onAutoNotFound() {
      setSweeping(false)
      setSweepResult('notfound')
      addLog('warning', 'Не удалось подобрать рабочие настройки порта')
    }
    function onAutoError({ message: msg }) {
      setSweeping(false)
      setError(msg)
      addLog('error', `Ошибка умного автопоиска: ${msg}`)
    }

    socket.on('bus:scan:progress', onProgress)
    socket.on('bus:scan:done', onDone)
    socket.on('bus:scan:error', onError)
    socket.on('bus:identify:progress', onIdentifyProgress)
    socket.on('bus:identify:done', onIdentifyDone)
    socket.on('bus:autodetect:progress', onAutoProgress)
    socket.on('bus:autodetect:found', onAutoFound)
    socket.on('bus:autodetect:notfound', onAutoNotFound)
    socket.on('bus:autodetect:error', onAutoError)
    return () => {
      socket.off('bus:scan:progress', onProgress)
      socket.off('bus:scan:done', onDone)
      socket.off('bus:scan:error', onError)
      socket.off('bus:identify:progress', onIdentifyProgress)
      socket.off('bus:identify:done', onIdentifyDone)
      socket.off('bus:autodetect:progress', onAutoProgress)
      socket.off('bus:autodetect:found', onAutoFound)
      socket.off('bus:autodetect:notfound', onAutoNotFound)
      socket.off('bus:autodetect:error', onAutoError)
    }
  }, [])

  useEffect(() => {
    if (!open || connected) return
    setLoadingPorts(true)
    api.get('/modbus/ports')
      .then(({ data }) => setPorts(data))
      .catch(() => {})
      .finally(() => setLoadingPorts(false))
  }, [open, connected])

  function handleOpen() {
    setOpen(true)
    reset()
  }

  function reset() {
    setProgress(0)
    setTotal(0)
    setFound([])
    setDone(false)
    setError(null)
    setRunning(false)
    setIdentifying(false)
    setIdentifyResults([])
    setIdentifyDone(false)
    setRetryingIds(new Set())
    setSweeping(false)
    setSweepProgress(null)
    setSweepResult(null)
  }

  async function handleProbe(slaveId) {
    setProbeModal({ slaveId, loading: true, data: null })
    try {
      const { data } = await api.post('/modbus/probe', { slaveId })
      setProbeModal({ slaveId, loading: false, data })
    } catch (e) {
      setProbeModal({ slaveId, loading: false, data: { error: e?.response?.data?.message ?? e.message } })
    }
  }

  function handleIdentify() {
    setIdentifying(true)
    setIdentifyResults([])
    setIdentifyDone(false)
    socket.emit('bus:identify:start', { slaveIds: found })
    addLog('info', `Определение моделей устройств: Slave ID ${found.join(', ')}`)
  }

  // Повтор определения для ОДНОГО адреса — на реальной шине модель иногда не
  // определяется с первого раза (та же природа, что и у нестабильного скана:
  // устройство не успевает ответить в срок). Кнопка появляется только у строк
  // с ошибкой (см. renderItem) и не трогает остальные уже определённые устройства.
  function handleRetryIdentify(slaveId) {
    setRetryingIds(prev => new Set(prev).add(slaveId))
    socket.emit('bus:identify:start', { slaveIds: [slaveId] })
    addLog('info', `Повторное определение модели: Slave ID ${slaveId}`)
  }

  function handleStart() {
    reset()
    setTotal(to - from + 1)
    setRunning(true)
    socket.emit('bus:scan:start', { from, to })
    addLog('info', `Запуск сканирования шины Modbus: адреса ${from}–${to}`)
  }

  function handleCancel() {
    socket.emit('bus:scan:cancel')
    socket.emit('bus:autodetect:cancel')
    setRunning(false)
    setSweeping(false)
    addLog('info', 'Поиск отменён')
  }

  function handleAutoDetect() {
    if (!selectedPort) return
    reset()
    setSweeping(true)
    setTotal(to - from + 1)
    socket.emit('bus:autodetect:start', { portPath: selectedPort, from, to })
    addLog('info', `Умный автопоиск на ${selectedPort}: перебор скорости/чётности/стоп-бит, адреса ${from}–${to}`)
  }

  function handleClose() {
    if (running || sweeping) handleCancel()
    setOpen(false)
  }

  const estSec = Math.ceil((to - from + 1) * 0.15)
  const percent = total > 0 ? Math.round((progress / total) * 100) : 0
  const currentAddr = running && total > 0 ? from + progress - 1 : null

  return (
    <>
      <Tooltip title="Поиск устройств на шине RS-485 (работает и без подключения — подберёт настройки порта)">
        <Button
          icon={<ApartmentOutlined />}
          onClick={handleOpen}
          style={{
            background: 'transparent',
            borderColor: '#ffffff40',
            color: '#fff',
          }}
        >
          Автообнаружение ПЧ
        </Button>
      </Tooltip>

      <Modal
        title={
          <Space>
            <InfoCircleOutlined />
            {`Сырая идентификация — Slave ID ${probeModal?.slaveId}`}
          </Space>
        }
        open={!!probeModal}
        onCancel={() => setProbeModal(null)}
        footer={<Button onClick={() => setProbeModal(null)}>Закрыть</Button>}
        width={620}
        destroyOnHidden
      >
        {probeModal?.loading
          ? <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { key: 'mei1', label: 'MEI Basic (code=1)' },
                { key: 'mei2', label: 'MEI Regular (code=2)' },
                { key: 'mei3', label: 'MEI Extended (code=3)' },
                { key: 'fc17', label: 'FC17 Report Server ID' },
              ].map(({ key, label }) => (
                <div key={key}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
                  <pre style={{
                    background: '#1a1a1a',
                    color: probeModal?.data?.[key]?.error ? '#ff7875' : '#d4d4d4',
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 13,
                    overflow: 'auto',
                    maxHeight: 160,
                    margin: '4px 0 0',
                  }}>
                    {JSON.stringify(probeModal?.data?.[key], null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )
        }
      </Modal>

      <Modal
        title={
          <Space>
            <ApartmentOutlined />
            Поиск и определение ПЧ на шине
          </Space>
        }
        open={open}
        onCancel={handleClose}
        footer={null}
        width={640}
        destroyOnHidden={false}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size={16}>

          {!connected && (
            <>
              <AutoComplete
                placeholder="Выберите или впишите COM-порт, например COM6"
                style={{ width: '100%' }}
                value={selectedPort}
                onChange={setSelectedPort}
                disabled={sweeping || running}
                notFoundContent={loadingPorts ? 'Загрузка...' : 'Порты не найдены'}
                options={ports.map(p => ({
                  value: p.path,
                  label: p.busy
                    ? `${p.path} — занят`
                    : (p.manufacturer ? `${p.path} — ${p.manufacturer}` : p.path),
                }))}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Порт не подключён — сначала переберём скорость/чётность/стоп-биты (8 скоростей × варианты чётности и стоп-бит),
                как только что-то ответит на одном из первых адресов диапазона — останемся на этих настройках и просканируем весь диапазон.
                Не видите нужный порт в списке? Впишите имя порта вручную.
              </Typography.Text>
            </>
          )}

          {/* Настройка диапазона */}
          <Row gutter={12} align="middle">
            <Col>
              <Space>
                <Typography.Text>Адреса с</Typography.Text>
                <InputNumber
                  min={1} max={to - 1} value={from}
                  onChange={v => v && setFrom(v)}
                  disabled={running || sweeping}
                  style={{ width: 70 }}
                />
                <Typography.Text>по</Typography.Text>
                <InputNumber
                  min={from + 1} max={247} value={to}
                  onChange={v => v && setTo(v)}
                  disabled={running || sweeping}
                  style={{ width: 70 }}
                />
              </Space>
            </Col>
            <Col>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ≈ {estSec} сек{!connected ? ' на комбинацию настроек' : ''}
              </Typography.Text>
            </Col>
          </Row>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Программа последовательно обращается к каждому адресу. Устройство, которое откликнулось — добавляется в список.
          </Typography.Text>

          {/* Перебор настроек порта (умный автопоиск) */}
          {sweeping && (
            <div>
              <Progress
                percent={sweepProgress ? Math.round(((sweepProgress.comboIndex + 1) / sweepProgress.totalCombos) * 100) : 0}
                status="active"
                format={() => sweepProgress ? `${sweepProgress.comboIndex + 1} / ${sweepProgress.totalCombos}` : '…'}
              />
              {sweepProgress && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Пробуем: {formatCombo(sweepProgress.combo)}…
                </Typography.Text>
              )}
            </div>
          )}
          {sweepResult === 'notfound' && (
            <Alert
              type="warning"
              showIcon
              message="Не удалось подобрать рабочие настройки"
              description="Ни одна комбинация скорости/чётности/стоп-бит не дала ответа в этом диапазоне адресов. Проверьте, что устройства подключены и запитаны, либо расширьте диапазон адресов."
            />
          )}
          {sweepResult && sweepResult !== 'notfound' && (
            <Alert
              type="success"
              showIcon
              message={`Настройки найдены: ${formatCombo(sweepResult)}`}
              description={`Порт ${sweepResult.portPath} подключён с этими настройками, сейчас сканируем адреса устройств.`}
            />
          )}

          {/* Прогресс */}
          {(running || done) && (
            <div>
              <Progress
                percent={percent}
                status={running ? 'active' : 'success'}
                format={() =>
                  running
                    ? `${progress} / ${total}`
                    : `${total} адресов проверено`
                }
              />
              {running && currentAddr !== null && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Проверяется адрес {currentAddr}…
                </Typography.Text>
              )}
            </div>
          )}

          {/* Ошибка */}
          {error && <Alert type="error" message={error} showIcon />}

          {/* Результаты */}
          {found.length > 0 && (
            <>
              <Divider style={{ margin: '4px 0' }} />
              <div>
                <Typography.Text strong style={{ marginRight: 8 }}>
                  Найдено {found.length}:
                </Typography.Text>
                <Space wrap size={4}>
                  {found.map(id => (
                    <Space key={id} size={2}>
                      <Tag color="blue" style={{ fontSize: 13, padding: '2px 8px' }}>
                        Slave ID {id}
                      </Tag>
                      <Tooltip title="Диагностика: спросить у устройства его паспорт стандартными функциями Modbus (43/MEI «Read Device Identification» и 17/FC17 «Report Server ID»). ELHART их не поддерживает, поэтому обычно приходит ошибка — модель определяется по характерным регистрам. Нужно только для разбора нестандартных устройств.">
                        <Button
                          size="small"
                          type="text"
                          icon={<InfoCircleOutlined />}
                          onClick={() => handleProbe(id)}
                          style={{ color: '#1677ff' }}
                        />
                      </Tooltip>
                    </Space>
                  ))}
                </Space>
              </div>
            </>
          )}

          {done && found.length === 0 && !error && (
            <Space>
              <CloseCircleOutlined style={{ color: '#faad14' }} />
              <Typography.Text type="secondary">
                В диапазоне {from}–{to} устройства не найдены
              </Typography.Text>
            </Space>
          )}

          {/* Identify block */}
          {done && found.length > 0 && !identifying && !identifyDone && (
            <>
              <Divider style={{ margin: '4px 0' }} />
              <Button
                color="green"
                variant="solid"
                icon={<PlusCircleOutlined />}
                onClick={handleIdentify}
              >
                Определить и добавить устройства
              </Button>
            </>
          )}

          {(identifying || identifyDone) && identifyResults.length > 0 && (
            <>
              <Divider style={{ margin: '4px 0' }} />
              <List
                size="small"
                dataSource={identifyResults}
                renderItem={r => (
                  <List.Item style={{ padding: '4px 0' }}>
                    {/* Фиксированные колонки (иконка / адрес / модель), а не Space —
                        иначе текст ошибки у Pump и VL начинался в разных местах
                        (тег "EMD-PUMP" шире "EMD-VL") и переносился в 3 строки
                        вместо 2 из-за нехватки места. */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%' }}>
                      <div style={{ flexShrink: 0, paddingTop: 2 }}>
                        {r.error
                          ? <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
                          : <CheckCircleOutlined style={{ color: '#52c41a' }} />
                        }
                      </div>
                      <Tag color="blue" style={{ flexShrink: 0, width: 68, textAlign: 'center' }}>Адрес {r.slaveId}</Tag>
                      <Tag
                        color={r.model === 'vl' ? 'purple' : r.model === 'pump' ? 'green' : 'orange'}
                        style={{ flexShrink: 0, width: 92, textAlign: 'center' }}
                      >
                        {r.model === 'unknown' ? 'Неизвестно' : `EMD-${r.model?.toUpperCase()}`}
                      </Tag>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {r.name && <Typography.Text strong>{r.name}</Typography.Text>}
                        {r.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>}
                      </div>
                      {r.error && (
                        <Button
                          size="small"
                          icon={<RedoOutlined />}
                          loading={retryingIds.has(r.slaveId)}
                          onClick={() => handleRetryIdentify(r.slaveId)}
                          style={{ flexShrink: 0 }}
                        >
                          Определить снова
                        </Button>
                      )}
                    </div>
                  </List.Item>
                )}
              />
              {identifying && (
                <Space>
                  <LoadingOutlined />
                  <Typography.Text type="secondary">Определение устройств...</Typography.Text>
                </Space>
              )}
            </>
          )}

          {/* Кнопки управления */}
          <Space>
            {(running || sweeping) ? (
              <Button danger onClick={handleCancel}>
                Отменить
              </Button>
            ) : connected ? (
              <Button type={done ? 'default' : 'primary'} onClick={handleStart}>
                {done ? 'Сканировать снова' : 'Начать сканирование'}
              </Button>
            ) : (
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleAutoDetect} disabled={!selectedPort}>
                Умный автопоиск
              </Button>
            )}
            <Button onClick={handleClose}>Закрыть</Button>
          </Space>

        </Space>
      </Modal>
    </>
  )
}
