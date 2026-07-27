import { useState, useRef } from 'react'
import { Typography, Badge, Avatar, Tag, Button, Modal, Form, Input, InputNumber, Select, Popconfirm, Tooltip, Checkbox, Space } from 'antd'
import { LinkOutlined, DisconnectOutlined, PlusOutlined, DeleteOutlined, EditOutlined, HolderOutlined } from '@ant-design/icons'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import api from '../api'
import { sortByDeviceOrder } from '../deviceOrder'

function deviceType(device) {
  return (device.templateId ?? device.id ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

function SortableDeviceRow({ id, compact, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, position: 'relative' }}
    >
      {!compact && (
        <div
          {...attributes}
          {...listeners}
          title="Перетащить — изменить порядок"
          style={{
            position: 'absolute', left: 2, top: 0, bottom: 0, width: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'grab', zIndex: 2, color: '#bbb',
          }}
        >
          <HolderOutlined style={{ fontSize: 11 }} />
        </div>
      )}
      {children}
    </div>
  )
}

export default function DeviceList({ devices, selectedIds, onSelectionChange, connected, liveness = {}, hasProject, activeProjectId, sidebarWidth = 270, deviceOrder, onDeviceOrderChange, focusedDeviceId, onFocusDevice }) {
  const [addOpen, setAddOpen]       = useState(false)
  const [editDevice, setEditDevice] = useState(null)
  const [templates, setTemplates]   = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [addForm]                   = Form.useForm()
  const [editForm]                  = Form.useForm()
  const [visibleTypes, setVisibleTypes] = useState(new Set(['pump', 'vl']))
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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
      name:    device.name,
      slaveId: device.connection.slaveId,
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

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    try {
      await Promise.all(ids.map(id => api.delete(`/devices/${id}`)))
    } catch (e) {
      console.error(e)
    } finally {
      onSelectionChange(new Set())
    }
  }

  // Добавить/убрать устройство из группы выделения (мультивыбор). Вызывается
  // галочкой и двойным кликом по строке.
  function toggleSelection(device) {
    const next = new Set(selectedIds)
    if (next.has(device.id)) next.delete(device.id)
    else next.add(device.id)
    onSelectionChange(next)
  }

  // Одиночный клик НЕ разрушает собранную группу:
  //  - ПЧ уже в группе → просто делаем его активным (его значения показываются
  //    справа — то же, что выбор в выпадающем меню на вкладке «Параметры»);
  //  - ПЧ вне группы → показываем его одного (иначе клик по невыбранному
  //    устройству ни к чему бы не приводил).
  function focusDevice(device) {
    if (!selectedIds.has(device.id)) onSelectionChange(new Set([device.id]))
    onFocusDevice?.(device.id)
  }

  // Один и тот же клик по строке порождает и onClick, и (при втором нажатии)
  // onDoubleClick, поэтому одиночное действие откладываем таймером: двойной клик
  // успевает его отменить. Так одиночный = «сделать активным», двойной =
  // «добавить/убрать из группы», и они не срабатывают вместе.
  const clickTimerRef = useRef(null)
  function handleRowClick(device) {
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      focusDevice(device)
    }, 220)
  }
  function handleRowDoubleClick(device) {
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null }
    toggleSelection(device)
  }

  // Снятие галочки "Все" прячет вообще все устройства — ровно как снятие
  // галочки с отдельного типа прячет его устройства, только сразу оба типа.
  // Раньше здесь выделение не снималось: слева список показывал "нет
  // устройств выбранного типа", а справа продолжала висеть панель с давно
  // невидимыми выбранными ПЧ — путаница, идентичная той, что уже была
  // исправлена для отдельных чекбоксов Pump/VL.
  function setAllTypesVisible(checked) {
    setVisibleTypes(checked ? new Set(['pump', 'vl']) : new Set())
    if (!checked && selectedIds.size > 0) {
      onSelectionChange(new Set())
    }
  }

  function toggleType(type, checked) {
    // Важно: onSelectionChange (setState родителя App) вызывается ЗДЕСЬ, в теле
    // обработчика, а не внутри апдейтера setVisibleTypes — вызов чужого setState
    // из апдейтера нарушает правила React ("Cannot update a component while
    // rendering a different component") и реально ронял приложение.
    const next = new Set(visibleTypes)
    if (checked) next.add(type)
    else next.delete(type)
    setVisibleTypes(next)
    // Если тип скрывается из фильтра — снимаем выделение с его устройств,
    // иначе они остаются "выбранными", но невидимыми, и потом путают, откуда
    // взялось сообщение о несовместимости pump/VL в групповых операциях.
    if (!checked) {
      const hiddenIds = new Set(allDevices.filter(d => deviceType(d) === type).map(d => d.id))
      if ([...selectedIds].some(id => hiddenIds.has(id))) {
        onSelectionChange(new Set([...selectedIds].filter(id => !hiddenIds.has(id))))
      }
    }
  }

  const Icon = connected ? LinkOutlined : DisconnectOutlined
  const iconColor = connected ? '#52c41a' : '#ff4d4f'

  // Статус порта (connected) — это только "адаптер открыт", не "это устройство
  // реально отвечает". Реальную связь по каждому устройству бэкенд отдельно
  // проверяет фоновым циклом (device:liveness) — пока порт не подключён, статус
  // всегда красный; после подключения, пока для устройства ещё не пришёл ни один
  // результат проверки, показываем "проверяется" (синий), а не ложный зелёный.
  function deviceLiveStatus(device) {
    if (!connected) return { status: 'error', title: 'Порт не подключён' }
    const online = liveness[device.id]
    if (online === true) return { status: 'success', title: 'Устройство на связи' }
    if (online === false) return { status: 'error', title: 'Устройство не отвечает (нет связи по Slave ID)' }
    return { status: 'processing', title: 'Проверка связи с устройством…' }
  }
  const rawDevices = devices.filter(d => !d.template)
  // Порядок из настроек (drag-n-drop в сайдбаре) — хранится и сохраняется в
  // App.jsx (единый источник, чтобы групповой просмотр наследовал тот же
  // порядок, см. deviceOrder.js).
  const allDevices = sortByDeviceOrder(rawDevices, deviceOrder)
  const hasPump = allDevices.some(d => deviceType(d) === 'pump')
  const hasVl   = allDevices.some(d => deviceType(d) === 'vl')
  const visibleDevices = allDevices.filter(d => visibleTypes.has(deviceType(d)))

  function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = visibleDevices.findIndex(d => d.id === active.id)
    const newIndex = visibleDevices.findIndex(d => d.id === over.id)
    const newVisibleOrder = arrayMove(visibleDevices, oldIndex, newIndex).map(d => d.id)
    // Устройства, скрытые сейчас фильтром типа, не участвовали в перетаскивании —
    // сохраняем их в конце в прежнем относительном порядке.
    const hiddenIds = allDevices.filter(d => !visibleTypes.has(deviceType(d))).map(d => d.id)
    const newOrder = [...newVisibleOrder, ...hiddenIds]
    onDeviceOrderChange(newOrder)
    if (activeProjectId) {
      api.patch(`/settings/device-order/${activeProjectId}`, { order: newOrder }).catch(() => {})
    }
  }

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
  // Полный текст "Добавить устройство" не помещается рядом с иконкой на
  // промежуточных ширинах — короткий вариант между compact и narrow, полный
  // только когда панель уже достаточно широкая.
  const addButtonLabel = sidebarWidth < 170 ? 'Добавить' : 'Добавить устройство'

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
            {!compact && addButtonLabel}
          </Button>
        </Tooltip>
      </div>

      {hasProject && allDevices.length > 0 && !compact && (
        <div style={{ padding: '0 16px 8px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Space direction="vertical" size={4}>
              <Checkbox
                checked={visibleTypes.size === 2}
                onChange={e => setAllTypesVisible(e.target.checked)}
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
                checked={visibleTypes.has('vl')}
                disabled={!hasVl}
                onChange={e => toggleType('vl', e.target.checked)}
              >
                <span style={{ fontSize: 12 }}>VL</span>
              </Checkbox>
            </Space>
            <Space direction="vertical" size={4} style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>
              {visibleDevices.length > 0 && (
                <Button
                  size="small"
                  color={allVisibleSelected ? 'red' : 'green'}
                  variant="solid"
                  onClick={toggleSelectAllVisible}
                >
                  {allVisibleSelected ? 'Снять выделение' : `Выбрать все (${visibleDevices.length})`}
                </Button>
              )}
              {selectedIds.size > 0 && (
                <Popconfirm
                  title="Удалить выбранные устройства?"
                  description={`Будет удалено устройств: ${selectedIds.size}. Файлы конфигов удаляются безвозвратно.`}
                  okText="Удалить"
                  cancelText="Отмена"
                  okButtonProps={{ danger: true }}
                  onConfirm={handleBulkDelete}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    Удалить ({selectedIds.size})
                  </Button>
                </Popconfirm>
              )}
            </Space>
          </div>
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleDevices.map(d => d.id)} strategy={verticalListSortingStrategy}>
            {visibleDevices.map(device => {
              const isSelected = selectedIds.has(device.id)
              // Активный ПЧ внутри группы — тот, чьи значения показаны справа.
              const isFocused = isSelected && selectedIds.size > 1 && focusedDeviceId === device.id
              const modelLabel = deviceType(device) === 'vl' ? 'VL' : 'Pump'
              const liveStatus = deviceLiveStatus(device)
              const avatar = device.images?.device
                ? (
                  <Tooltip title={liveStatus.title}>
                    <Badge dot status={liveStatus.status} offset={compact ? [-2, 2] : [-4, 4]}>
                      <Avatar
                        className="device-avatar"
                        src={`/api/devices/images/${device.images.device}`}
                        size={avatarSize}
                        shape="square"
                        style={{ borderRadius: 6 }}
                      />
                    </Badge>
                  </Tooltip>
                )
                : (
                  <Tooltip title={liveStatus.title}>
                    <Badge dot status={liveStatus.status} offset={[-2, 2]}>
                      <Icon style={{ fontSize: Math.min(avatarSize, 28), color: iconColor, marginTop: 2 }} />
                    </Badge>
                  </Tooltip>
                )

              return (
                <SortableDeviceRow key={device.id} id={device.id} compact={compact}>
                  <Tooltip title={compact ? `${device.name} · ${modelLabel} · Адрес ${device.connection.slaveId ?? 1}` : ''} placement="right">
                    <div
                      onClick={() => handleRowClick(device)}
                      onDoubleClick={() => handleRowDoubleClick(device)}
                      className={isSelected ? 'device-row device-row-selected' : 'device-row'}
                      style={{
                        position: 'relative',
                        cursor: 'pointer',
                        padding: compact ? '8px 4px' : '8px 12px 8px 20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: compact ? 'center' : 'flex-start',
                        gap: 8,
                        background: isFocused ? '#bae0ff' : (isSelected ? '#e6f4ff' : 'transparent'),
                        borderLeft: isFocused
                          ? '3px solid #0958d9'
                          : (isSelected ? '3px solid #1677ff' : '3px solid transparent'),
                        borderBottom: '1px solid #f5f5f5',
                      }}
                    >
                      {!compact && (
                        // Увеличенная галочка и расширенная зона клика по ней —
                        // проще попасть, отделено от «показать этот ПЧ».
                        <span
                          onClick={e => e.stopPropagation()}
                          onDoubleClick={e => e.stopPropagation()}
                          style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 6px', margin: '-4px 0' }}
                          title="Добавить/убрать из группового выбора"
                        >
                          <Checkbox
                            checked={isSelected}
                            onChange={() => toggleSelection(device)}
                            style={{ transform: 'scale(1.35)' }}
                          />
                        </span>
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
                                Адрес {device.connection.slaveId ?? 1}
                              </Tag>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>{modelLabel}</Typography.Text>
                            </span>
                          )}
                        </div>
                      )}

                      {!compact && !narrow && (
                        <div
                          onClick={e => e.stopPropagation()}
                          className="device-row-actions"
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
                </SortableDeviceRow>
              )
            })}
          </SortableContext>
        </DndContext>
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
          <Form.Item name="slaveId" label="Адрес ПЧ (Slave ID на шине)" rules={[{ required: true, message: 'Введите адрес ПЧ' }]}>
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
          <Form.Item name="slaveId" label="Адрес ПЧ (Slave ID на шине)" rules={[{ required: true, message: 'Введите адрес ПЧ' }]}>
            <InputNumber min={1} max={247} style={{ width: '100%' }} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Скорость, чётность, биты данных и стоп-биты — общие настройки порта для всей шины
            (не у каждого устройства свои), их можно изменить в панели «Подключение» в шапке приложения.
          </Typography.Text>
        </Form>
      </Modal>
    </>
  )
}
