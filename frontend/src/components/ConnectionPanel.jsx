import { useState, useEffect, useRef } from 'react'
import { Button, Select, AutoComplete, Space, Tag, Modal, Form, message, Tooltip, Collapse, Row, Col, Alert } from 'antd'
import { ReloadOutlined, ScanOutlined, LoadingOutlined, ThunderboltOutlined } from '@ant-design/icons'
import socket from '../socket'
import api from '../api'
import { addLog } from '../log'

export default function ConnectionPanel({ connected, reconnecting, reconnectAttempt, connectedPort, waitingPort }) {
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [ports, setPorts] = useState([])
  const [loadingPorts, setLoadingPorts] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detectStage, setDetectStage] = useState('')
  const prevReconnecting = useRef(false)

  useEffect(() => {
    if (reconnecting && !prevReconnecting.current) {
      addLog('warning', 'Соединение потеряно. Запуск авто-переподключения...')
    }
    if (!reconnecting && prevReconnecting.current && connected) {
      addLog('success', 'Соединение восстановлено')
    }
    prevReconnecting.current = reconnecting
  }, [reconnecting, connected])

  async function fetchPorts() {
    setLoadingPorts(true)
    try {
      const { data } = await api.get('/modbus/ports')
      setPorts(data)
    } catch {
      message.error('Не удалось получить список портов')
    } finally {
      setLoadingPorts(false)
    }
  }

  function handleOpen() {
    setOpen(true)
    fetchPorts()
  }

  async function handleScan() {
    setScanning(true)
    try {
      const baudRate = form.getFieldValue('baudRate') ?? undefined
      const { data } = await api.post('/modbus/scan', { baudRate })
      form.setFieldsValue({ portPath: data.portPath, baudRate: data.baudRate })
      message.success(`Найдено: ${data.portPath} — ${data.baudRate} бод`)
    } catch {
      message.error('Адаптер USB→RS-485 не найден. Проверьте, подключён ли он к компьютеру.')
    } finally {
      setScanning(false)
    }
  }

  function handleConnect(values) {
    setConnecting(true)
    socket.emit('connect:port', {
      portPath: values.portPath,
      baudRate: values.baudRate,
      dataBits: values.dataBits,
      stopBits: values.stopBits,
      parity: values.parity,
    }, (res) => {
      setConnecting(false)
      if (res?.success) {
        setOpen(false)
        const parityLetter = (values.parity ?? 'none')[0].toUpperCase()
        addLog('info', `Подключение к порту ${values.portPath}, ${values.baudRate} бод, ${values.dataBits ?? 8}${parityLetter}${values.stopBits ?? 1}`)
      } else {
        const msg = res?.error ?? 'Не удалось подключиться к порту'
        message.error(msg)
        addLog('error', `Ошибка подключения: ${msg}`)
      }
    })
  }

  function handleDisconnect() {
    socket.emit('disconnect:port')
    addLog('info', 'Отключение от порта')
  }

  // У COM-порта нет «скорости», которую можно просто прочитать — обе стороны
  // должны заранее договориться. Поэтому «определить скорость» = перебрать
  // типовые сочетания скорость×чётность×стоп-биты и посмотреть, на каком из них
  // устройство отвечает валидным Modbus-ответом. Это делает бэкенд
  // (bus:autodetect:start): как только что-то ответило — он оставляет порт
  // открытым с этой конфигурацией и сохраняет её для проекта.
  function handleAutoDetectSpeed() {
    const portPath = form.getFieldValue('portPath')
    if (!portPath) { message.warning('Сначала выберите COM порт'); return }
    setDetecting(true)
    setDetectStage('Перебор скоростей…')

    function cleanup() {
      socket.off('bus:autodetect:progress', onProgress)
      socket.off('bus:autodetect:found', onFound)
      socket.off('bus:autodetect:notfound', onNotFound)
      socket.off('bus:autodetect:error', onError)
      setDetecting(false)
      setDetectStage('')
    }
    function onProgress(p) {
      const c = p.combo
      if (c) setDetectStage(`Пробую ${c.baudRate} бод, ${c.dataBits ?? 8}${(c.parity ?? 'none')[0].toUpperCase()}${c.stopBits ?? 1}… (${p.comboIndex + 1}/${p.totalCombos})`)
    }
    function onFound({ combo }) {
      cleanup()
      form.setFieldsValue({
        portPath: combo.portPath, baudRate: combo.baudRate,
        dataBits: combo.dataBits, stopBits: combo.stopBits, parity: combo.parity,
      })
      const parityLetter = (combo.parity ?? 'none')[0].toUpperCase()
      message.success(`Скорость определена: ${combo.baudRate} бод, ${combo.dataBits ?? 8}${parityLetter}${combo.stopBits ?? 1}. Порт подключён.`)
      addLog('success', `Автоопределение: ${combo.portPath}, ${combo.baudRate} бод, ${combo.dataBits ?? 8}${parityLetter}${combo.stopBits ?? 1}`)
      setOpen(false) // бэкенд уже подключил порт с этим сочетанием
    }
    function onNotFound() {
      cleanup()
      message.error('Не удалось определить скорость — ни одно устройство не ответило. Проверьте адреса ПЧ и провода A/B, либо задайте скорость вручную.')
    }
    function onError(e) { cleanup(); message.error(e?.message ?? 'Ошибка автоопределения') }

    socket.on('bus:autodetect:progress', onProgress)
    socket.on('bus:autodetect:found', onFound)
    socket.on('bus:autodetect:notfound', onNotFound)
    socket.on('bus:autodetect:error', onError)
    socket.emit('bus:autodetect:start', { portPath })
  }

  function cancelDetect() {
    socket.emit('bus:autodetect:cancel')
  }

  const portOptions = ports.map(p => ({
    value: p.path,
    disabled: p.busy,
    label: (
      <Space>
        <span style={{ color: p.busy ? '#999' : undefined }}>
          {p.manufacturer ? `${p.path} — ${p.manufacturer}` : p.path}
        </span>
        {p.busy && <Tag color="red" style={{ margin: 0, fontSize: 11 }}>занят</Tag>}
      </Space>
    ),
  }))

  const portDetails = connectedPort
    ? `${connectedPort.portPath} · ${connectedPort.baudRate} бод · ${connectedPort.dataBits ?? 8}${(connectedPort.parity ?? 'none')[0].toUpperCase()}${connectedPort.stopBits ?? 1}`
    : undefined

  const statusTag = connected ? (
    <Tooltip title={portDetails}>
      <Tag color="green" style={{ margin: 0, cursor: connectedPort ? 'default' : undefined }}>
        Подключено{connectedPort ? ` · ${connectedPort.portPath}` : ''}
      </Tag>
    </Tooltip>
  ) : reconnecting ? (
    <Tag color="orange" icon={<LoadingOutlined spin />} style={{ margin: 0 }}>
      Переподключение… попытка {reconnectAttempt}
    </Tag>
  ) : waitingPort ? (
    <Tooltip title="Порт недоступен, ожидаем подключения устройства">
      <Tag color="processing" icon={<LoadingOutlined spin />} style={{ margin: 0 }}>
        Ожидание {waitingPort}…
      </Tag>
    </Tooltip>
  ) : (
    <Tag color="red" style={{ margin: 0 }}>Не подключено</Tag>
  )

  return (
    <Space>
      {statusTag}

      {connected ? (
        <Button size="small" danger onClick={handleDisconnect}>
          Отключить
        </Button>
      ) : reconnecting ? (
        <Button size="small" onClick={handleDisconnect}>
          Отменить
        </Button>
      ) : (
        <Button size="small" type="primary" onClick={handleOpen}>
          Подключить
        </Button>
      )}

      <Modal
        title="Подключение к устройству"
        open={open}
        onCancel={() => { if (detecting) cancelDetect(); setOpen(false) }}
        footer={[
          <Tooltip key="scan" title="Находит USB→RS-485 адаптер по идентификатору производителя (Silicon Labs, FTDI, CH340 и др.)">
            <Button
              icon={<ScanOutlined />}
              onClick={handleScan}
              loading={scanning}
              disabled={detecting}
            >
              Найти адаптер
            </Button>
          </Tooltip>,
          <Tooltip key="detect" title="Перебирает скорость/чётность/стоп-биты на выбранном порту и подключается, как только ПЧ ответит. Скорость COM-порта нельзя «прочитать» — её можно только подобрать по ответу устройства.">
            {detecting ? (
              <Button danger onClick={cancelDetect}>Остановить подбор</Button>
            ) : (
              <Button icon={<ThunderboltOutlined />} onClick={handleAutoDetectSpeed}>
                Определить скорость
              </Button>
            )}
          </Tooltip>,
          <Button key="cancel" onClick={() => { if (detecting) cancelDetect(); setOpen(false) }} disabled={connecting}>
            Отмена
          </Button>,
          <Button key="connect" type="primary" loading={connecting} onClick={() => form.submit()} disabled={detecting}>
            Подключить
          </Button>,
        ]}
      >
        {detecting && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Автоопределение скорости"
            description={detectStage || 'Идёт подбор параметров связи…'}
          />
        )}
        <Form
          form={form}
          onFinish={handleConnect}
          layout="vertical"
          initialValues={{ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' }}
        >
          <Form.Item
            name="portPath"
            label={
              <Space>
                COM порт
                <Tooltip title="Обновить список портов">
                  <Button
                    size="small"
                    type="text"
                    icon={<ReloadOutlined spin={loadingPorts} />}
                    onClick={fetchPorts}
                  />
                </Tooltip>
              </Space>
            }
            rules={[{ required: true, message: 'Укажите порт' }]}
            extra="Не видите нужный порт в списке? Впишите его имя вручную, например COM6"
          >
            <AutoComplete
              options={portOptions}
              placeholder="Выберите или впишите порт, напр. COM6"
              notFoundContent={loadingPorts ? 'Загрузка...' : 'Порты не найдены'}
              filterOption={(input, option) =>
                String(option.value).toLowerCase().includes(input.toLowerCase())
              }
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item
            name="baudRate"
            label="Скорость (бод)"
            extra="Все устройства на одной шине RS-485 должны работать на одной скорости"
          >
            <Select style={{ width: '100%' }} options={[
              { value: 1200,   label: '1200' },
              { value: 2400,   label: '2400' },
              { value: 4800,   label: '4800' },
              { value: 9600,   label: '9600' },
              { value: 19200,  label: '19200' },
              { value: 38400,  label: '38400' },
              { value: 57600,  label: '57600' },
              { value: 115200, label: '115200' },
            ]} />
          </Form.Item>

          <Collapse
            ghost
            size="small"
            items={[{
              key: 'advanced',
              label: <span style={{ color: '#999', fontSize: 12 }}>Дополнительно (8N1 по умолчанию)</span>,
              children: (
                <Row gutter={8}>
                  <Col span={8}>
                    <Form.Item name="dataBits" label="Биты данных">
                      <Select options={[
                        { value: 8, label: '8' },
                        { value: 7, label: '7' },
                      ]} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="stopBits" label="Стоп-биты">
                      <Select options={[
                        { value: 1, label: '1' },
                        { value: 2, label: '2' },
                      ]} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="parity" label="Чётность">
                      <Select options={[
                        { value: 'none',  label: 'None'  },
                        { value: 'even',  label: 'Even'  },
                        { value: 'odd',   label: 'Odd'   },
                        { value: 'mark',  label: 'Mark'  },
                        { value: 'space', label: 'Space' },
                      ]} />
                    </Form.Item>
                  </Col>
                </Row>
              ),
            }]}
          />
        </Form>
      </Modal>
    </Space>
  )
}
