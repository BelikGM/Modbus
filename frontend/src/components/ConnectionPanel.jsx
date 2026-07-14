import { useState, useEffect, useRef } from 'react'
import { Button, Select, AutoComplete, Space, Tag, Modal, Form, message, Tooltip, Collapse, Row, Col } from 'antd'
import { ReloadOutlined, ScanOutlined, LoadingOutlined } from '@ant-design/icons'
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
        addLog('info', `Подключение к порту ${values.portPath}, ${values.baudRate} бод, ${values.dataBits}${values.parity[0].toUpperCase()}${values.stopBits}`)
        setOpen(false)
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
        onCancel={() => setOpen(false)}
        footer={[
          <Tooltip key="scan" title="Находит USB→RS-485 адаптер по идентификатору производителя (Silicon Labs, FTDI, CH340 и др.)">
            <Button
              icon={<ScanOutlined />}
              onClick={handleScan}
              loading={scanning}
            >
              Автопоиск
            </Button>
          </Tooltip>,
          <Button key="cancel" onClick={() => setOpen(false)} disabled={connecting}>
            Отмена
          </Button>,
          <Button key="connect" type="primary" loading={connecting} onClick={() => form.submit()}>
            Подключить
          </Button>,
        ]}
      >
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
