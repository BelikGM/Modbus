import { useState } from 'react'
import { List, Typography, Badge, Avatar, Tag, Button, Modal, Form, Input, InputNumber, Select, Popconfirm, Tooltip, Checkbox, Collapse, Space } from 'antd'
import { LinkOutlined, DisconnectOutlined, PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import api from '../api'

const PARITY_OPTIONS = [
  { value: 'none', label: 'none' },
  { value: 'even', label: 'even' },
  { value: 'odd',  label: 'odd' },
]

const BAUD_OPTIONS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(v => ({ value: v, label: String(v) }))

function deviceType(device) {
  return (device.templateId ?? device.id ?? '').toLowerCase().includes('vh') ? 'vh' : 'pump'
}

export default function DeviceList({ devices, selectedIds, onSelectionChange, connected, hasProject, sidebarWidth = 270 }) {
  const [addOpen, setAddOpen]       = useState(false)
  const [editDevice, setEditDevice] = useState(null)
  const [templates, setTemplates]   = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [addForm]                   = Form.useForm()
  const [editForm]                  = Form.useForm()
  const [visibleTypes, setVisibleTypes] = useState(new Set(['pump', 'vh']))

  async function openAdd() {
    const { data } = await api.get('/devices/templates')
    setTemplates(data)
    addForm.resetFields()
    setAddOpen(true)
  }

  async function handleAdd(values) {
    setSubmitting(true)
    try {
      await api.post('/devices', values)
      setAddOpen(false)
    } catch (e) {
      const msg = e?.response?.data?.message ?? 'Ошибка создания устройства'
      addForm.setFields([{ name: 'slaveId', errors: [msg] }])
    } finally {
      setSubmitting(false)
    }
  }

  function openEdit(device, e) {
    e.stopPropagation()
    setEditDevice(device)
    editForm.setFieldsValue({
      name:     device.name,
      slaveId:  device.connection.slaveId,
      baudRate: device.connection.baudRate,
      dataBits: device.connection.dataBits,
      stopBits: device.connection.stopBits,
      parity:   device.connection.parity,
    })
  }

  async function handleEdit(values) {
    setSubmitting(true)
    try {
      await api.patch(`/devices/${editDevice.id}`, values)
      setEditDevice(null)
    } catch (e) {
      const msg = e?.response?.data?.message ?? 'Ошибка сохранения'
      editForm.setFields([{ name: 'slaveId', errors: [msg] }])
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(device, e) {
    e.stopPropagation()
    try {
      await api.delete(`/devices/${device.id}`)
      const next = new Set(selectedIds)
      next.delete(device.id)
      onSelectionChange(next)
    } catch (e) {
      console.error(e)
    }
  }

  function toggleSelection(device) {
    const next = new Set(selectedIds)
    if (next.has(device.id)) next.delete(device.id)
    else next.add(device.id)
    onSelectionChange(next)
  }

  function toggleType(type, checked) {
    setVisibleTypes(prev => {
      const next = new Set(prev)
      if (checked) next.add(type)
      else next.delete(type)
      return next
    })
  }

  const Icon = connected ? LinkOutlined : DisconnectOutlined
  const iconColor = connected ? '#52c41a' : '#ff4d4f'
  const allDevices = devices.filter(d => !d.template)
  const hasPump = allDevices.some(d => deviceType(d) === 'pump')
  const hasVh   = allDevices.some(d => deviceType(d) === 'vh')
  const visibleDevices = allDevices.filter(d => visibleTypes.has(deviceType(d)))

  const allVisibleSelected = visibleDevices.length > 0 && visibleDevices.every(d => selectedIds.has(d.id))
  function toggleSelectAllVisible() {
    const next = new Set(selectedIds)
    if (allVisibleSelected) visibleDevices.forEach(d => next.delete(d.id))
    else visibleDevices.forEach(d => next.add(d.id))
    onSelectionChange(next)
  }

  // Responsive-режимы в зависимости от ширины сайдбара (тянется мышью в App.jsx):
  // compact — только иконка/фото, без текста и кнопок (узкая полоса);
  // narrow  — фото + имя, без описания и кнопок редактирования;
  // иначе   — полный вид.
  const compact = sidebarWidth < 100
  const narrow  = sidebarWidth < 180
  const avatarSize = compact ? Math.max(28, sidebarWidth - 20) : (narrow ? 32 : 44)

  return (
    <>
      <div style={{ padding: compact ? '8px 6px 4px' : '8px 16px 4px' }}>
        <Tooltip
          title={!hasProject ? 'Сначала выберите или создайте проект в шапке приложения' : 'Добавить устройство'}
        >
          <Button
            type="dashed"
            icon={<PlusOutlined />}
            size="small"
            block
            onClick={openAdd}
            disabled={!hasProject}
          >
            {!compact && 'Добавить устройство'}
          </Button>
        </Tooltip>
      </div>

      {hasProject && allDevices.length > 0 && !compact && (
        <div style={{ padding: '0 16px 8px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
          <Space size={10} wrap>
            <Checkbox
              checked={visibleTypes.size === 2}
              onChange={e => setVisibleTypes(e.target.checked ? new Set(['pump', 'vh']) : new Set())}
              style={{ fontSize: 12 }}
            >
              <span style={{ fontSize: 12 }}>Все</span>
            </Checkbox>
            <Checkbox
              checked={visibleTypes.has('pump')}
              disabled={!hasPump}
              onChange={e => toggleType('pump', e.target.checked)}
            >
              <span style={{ fontSize: 12 }}>Pump</span>
            </Checkbox>
            <Checkbox
              checked={visibleTypes.has('vh')}
              disabled={!hasVh}
              onChange={e => toggleType('vh', e.target.checked)}
            >
              <span style={{ fontSize: 12 }}>VH</span>
            </Checkbox>
          </Space>
          {visibleDevices.length > 0 && (
            <Button
              size="small"
              color={allVisibleSelected ? 'red' : 'green'}
              variant="link"
              style={{ padding: 0, fontSize: 12, height: 'auto' }}
              onClick={toggleSelectAllVisible}
            >
              {allVisibleSelected ? 'Снять выделение' : `Выбрать все (${visibleDevices.length})`}
            </Button>
          )}
        </div>
      )}

      {!hasProject ? (
        <div style={{ padding: '24px 16px', textAlign: 'center' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Выберите проект в шапке приложения или создайте новый — затем можно будет добавлять устройства
          </Typography.Text>
        </div>
      ) : allDevices.length === 0 ? (
        <Typography.Text type="secondary" style={{ display: 'block', padding: '16px' }}>
          Нет устройств
        </Typography.Text>
      ) : visibleDevices.length === 0 ? (
        <Typography.Text type="secondary" style={{ display: 'block', padding: '16px' }}>
          Нет устройств выбранного типа
        </Typography.Text>
      ) : (
        <List
          dataSource={visibleDevices}
          renderItem={device => {
            const isSelected = selectedIds.has(device.id)
            const modelLabel = deviceType(device) === 'vh' ? 'VH' : 'Pump'
            const avatar = device.images?.device
              ? (
                <Badge dot status={connected ? 'success' : 'error'} offset={compact ? [-2, 2] : [-4, 4]}>
                  <Avatar
                    src={`/api/devices/images/${device.images.device}`}
                    size={avatarSize}
                    shape="square"
                    style={{ borderRadius: 6 }}
                  />
                </Badge>
              )
              : (
                <Badge dot status={connected ? 'success' : 'error'} offset={[-2, 2]}>
                  <Icon style={{ fontSize: Math.min(avatarSize, 28), color: iconColor, marginTop: 2 }} />
                </Badge>
              )

            return (
              <Tooltip key={device.id} title={compact ? `${device.name} · ${modelLabel} · ID ${device.connection.slaveId ?? 1}` : ''} placement="right">
                <div
                  onClick={() => toggleSelection(device)}
                  style={{
                    position: 'relative',
                    cursor: 'pointer',
                    padding: compact ? '8px 4px' : '8px 12px 8px 8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: compact ? 'center' : 'flex-start',
                    gap: 8,
                    background: isSelected ? '#e6f4ff' : 'transparent',
                    borderLeft: isSelected ? '3px solid #1677ff' : '3px solid transparent',
                    borderBottom: '1px solid #f5f5f5',
                  }}
                >
                  {!compact && (
                    <Checkbox
                      checked={isSelected}
                      onClick={e => e.stopPropagation()}
                      onChange={() => toggleSelection(device)}
                    />
                  )}

                  {avatar}

                  {!compact && (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: narrow ? 0 : 48 }}>
                        {device.name}
                      </div>
                      {!narrow && (
                        <span style={{ fontSize: 12 }}>
                          <Tag style={{ fontSize: 11, padding: '0 4px', marginRight: 4 }}>
                            ID {device.connection.slaveId ?? 1}
                          </Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{modelLabel}</Typography.Text>
                        </span>
                      )}
                    </div>
                  )}

                  {!compact && !narrow && (
                    <div
                      onClick={e => e.stopPropagation()}
                      style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 2, background: isSelected ? '#e6f4ff' : '#fff' }}
                    >
                      <Tooltip title="Редактировать">
                        <Button
                          size="small"
                          type="text"
                          icon={<EditOutlined />}
                          onClick={e => openEdit(device, e)}
                        />
                      </Tooltip>
                      <Popconfirm
                        title="Удалить устройство?"
                        description="Файл конфига будет удалён безвозвратно."
                        okText="Удалить"
                        cancelText="Отмена"
                        okButtonProps={{ danger: true }}
                        onConfirm={e => handleDelete(device, e ?? { stopPropagation: () => {} })}
                        onPopupClick={e => e.stopPropagation()}
                      >
                        <Tooltip title="Удалить устройство">
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                        </Tooltip>
                      </Popconfirm>
                    </div>
                  )}
                </div>
              </Tooltip>
            )
          }}
        />
      )}

      {/* Модалка добавления */}
      <Modal
        title="Добавить устройство"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => addForm.submit()}
        okText="Добавить"
        cancelText="Отмена"
        confirmLoading={submitting}
      >
        <Form form={addForm} layout="vertical" onFinish={handleAdd} style={{ marginTop: 16 }}>
          <Form.Item name="templateId" label="Тип устройства (шаблон)" rules={[{ required: true, message: 'Выберите шаблон' }]}>
            <Select placeholder="Выберите шаблон" popupMatchSelectWidth={false} options={templates.map(t => ({ value: t.id, label: t.name }))} />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Введите название' }]}>
            <Input placeholder="Например: Насос 1" />
          </Form.Item>
          <Form.Item name="slaveId" label="Slave ID (адрес на шине)" rules={[{ required: true, message: 'Введите Slave ID' }]}>
            <InputNumber min={1} max={247} style={{ width: '100%' }} placeholder="1–247" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Модалка редактирования */}
      <Modal
        title={`Редактировать: ${editDevice?.name}`}
        open={!!editDevice}
        onCancel={() => setEditDevice(null)}
        onOk={() => editForm.submit()}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={submitting}
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Введите название' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="slaveId" label="Slave ID (адрес на шине)" rules={[{ required: true, message: 'Введите Slave ID' }]}>
            <InputNumber min={1} max={247} style={{ width: '100%' }} />
          </Form.Item>
          <Collapse
            size="small"
            style={{ marginTop: 8 }}
            items={[{
              key: 'conn',
              label: 'Параметры подключения',
              children: (
                <>
                  <Form.Item name="baudRate" label="Скорость (baud rate)">
                    <Select options={BAUD_OPTIONS} popupMatchSelectWidth={false} />
                  </Form.Item>
                  <Form.Item name="dataBits" label="Биты данных">
                    <Select options={[7, 8].map(v => ({ value: v, label: String(v) }))} popupMatchSelectWidth={false} />
                  </Form.Item>
                  <Form.Item name="stopBits" label="Стоп-биты">
                    <Select options={[1, 2].map(v => ({ value: v, label: String(v) }))} popupMatchSelectWidth={false} />
                  </Form.Item>
                  <Form.Item name="parity" label="Чётность (parity)" style={{ marginBottom: 0 }}>
                    <Select options={PARITY_OPTIONS} popupMatchSelectWidth={false} />
                  </Form.Item>
                </>
              ),
            }]}
          />
        </Form>
      </Modal>
    </>
  )
}
