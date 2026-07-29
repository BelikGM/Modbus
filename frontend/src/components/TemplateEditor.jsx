import { useState, useEffect } from 'react'
import {
  Modal, Button, Table, Input, Select, InputNumber, Space, Typography, Tag,
  message, Popconfirm, Alert, Collapse, Checkbox, Divider, Tooltip,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ApartmentOutlined, CopyOutlined } from '@ant-design/icons'
import api from '../api'
import { addLog } from '../log'

// Редактор типов ПЧ (шаблонов).
//
// Смысл: на объекте может встретиться ПЧ, которого нет в поставке — урезанная
// версия знакомой модели или вообще другой производитель. Раньше для этого
// пришлось бы править JSON руками и ждать новый инсталлятор. Здесь тип можно
// собрать в программе: с нуля или на основе имеющихся, отобрав нужные группы и
// отдельные параметры, а затем поправив у них имя, регистр, тип и пределы.
//
// Штатные типы защищены от правки на бэкенде — их можно только взять за основу.

const PARAM_TYPES = [
  { value: 'integer', label: 'Целое' },
  { value: 'float', label: 'Дробное' },
  { value: 'enum', label: 'Перечисление' },
  { value: 'bitmask', label: 'Битовая маска' },
]

const ACCESS_OPTIONS = [
  { value: 'read-write', label: 'Чтение и запись' },
  { value: 'read', label: 'Только чтение' },
  { value: 'write', label: 'Только запись' },
]

export default function TemplateEditor({ open, onClose }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null) // редактируемый тип (черновик)
  const [baseId, setBaseId] = useState(null)   // тип-основа при создании
  const [picked, setPicked] = useState(new Set()) // выбранные paramId из основы
  const [saving, setSaving] = useState(false)

  function load() {
    setLoading(true)
    api.get('/devices/templates')
      .then(({ data }) => setTemplates(data ?? []))
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => { if (open) load() }, [open])

  const base = templates.find(t => t.id === baseId) ?? null

  // ─── Создание ──────────────────────────────────────────────────────────────
  function startNew(fromId) {
    setBaseId(fromId ?? null)
    setPicked(new Set())
    setEditing({
      id: '', name: '', family: '', familyLabel: '',
      connection: { slaveId: 1, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', protocol: 'modbus-rtu' },
      groups: [],
      isNew: true,
    })
  }

  function startEdit(t) {
    setBaseId(null)
    setPicked(new Set())
    // Работаем с копией — «Отмена» не должна оставлять следов
    setEditing(JSON.parse(JSON.stringify({ ...t, isNew: false })))
  }

  // Перенос отмеченных параметров из основы в черновик
  function applyPicked() {
    if (!base) return
    const groups = base.groups
      .map(g => ({ ...g, params: g.params.filter(p => picked.has(p.id)) }))
      .filter(g => g.params.length > 0)
    if (groups.length === 0) { message.warning('Отметьте хотя бы один параметр'); return }
    setEditing(prev => ({
      ...prev,
      // подтягиваем и служебные поля основы — их обычно хотят сохранить
      connection: base.connection,
      access_legend: base.access_legend,
      errorCodes: base.errorCodes,
      groups,
    }))
    message.success(`Перенесено ${groups.flatMap(g => g.params).length} параметров из «${base.name}»`)
  }

  function toggleParam(id, on) {
    setPicked(prev => { const n = new Set(prev); on ? n.add(id) : n.delete(id); return n })
  }
  function toggleGroup(group, on) {
    setPicked(prev => {
      const n = new Set(prev)
      for (const p of group.params) on ? n.add(p.id) : n.delete(p.id)
      return n
    })
  }

  // ─── Правка параметров черновика ───────────────────────────────────────────
  function patchParam(groupId, paramId, patch) {
    setEditing(prev => ({
      ...prev,
      groups: prev.groups.map(g => g.id !== groupId ? g : {
        ...g,
        params: g.params.map(p => p.id !== paramId ? p : { ...p, ...patch }),
      }),
    }))
  }
  function removeParam(groupId, paramId) {
    setEditing(prev => ({
      ...prev,
      groups: prev.groups
        .map(g => g.id !== groupId ? g : { ...g, params: g.params.filter(p => p.id !== paramId) })
        .filter(g => g.params.length > 0),
    }))
  }

  async function save() {
    const d = editing
    if (!d.id?.trim()) { message.warning('Укажите идентификатор типа (латиницей, без пробелов)'); return }
    if (!d.name?.trim()) { message.warning('Укажите название типа'); return }
    if (!d.groups?.length) { message.warning('В типе нет ни одного параметра'); return }
    setSaving(true)
    try {
      const payload = { ...d }
      delete payload.isNew
      if (d.isNew) await api.post('/devices/templates', payload)
      else await api.put(`/devices/templates/${encodeURIComponent(d.id)}`, payload)
      message.success(`Тип «${d.name}» сохранён`)
      addLog('success', `${d.isNew ? 'Создан' : 'Изменён'} тип ПЧ «${d.name}» (${d.groups.flatMap(g => g.params).length} параметров)`)
      setEditing(null)
      load()
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Не удалось сохранить тип')
    } finally {
      setSaving(false)
    }
  }

  async function remove(t) {
    try {
      await api.delete(`/devices/templates/${encodeURIComponent(t.id)}`)
      message.success(`Тип «${t.name}» удалён`)
      addLog('warning', `Удалён тип ПЧ «${t.name}»`)
      load()
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Не удалось удалить тип')
    }
  }

  // ─── Список типов ──────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <Modal
        title={<Space><ApartmentOutlined />Типы ПЧ</Space>}
        open={open}
        onCancel={onClose}
        width={820}
        footer={[
          <Button key="new" icon={<PlusOutlined />} onClick={() => startNew(null)}>Создать с нуля</Button>,
          <Button key="close" type="primary" onClick={onClose}>Закрыть</Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Свои типы ПЧ можно создавать прямо здесь"
          description="Штатные типы менять нельзя — возьмите такой за основу, отберите нужные группы и параметры и сохраните под своим именем. Файл появится в папке devices/templates и подхватится сразу, переустановка не нужна."
        />
        <Table
          size="small"
          loading={loading}
          pagination={false}
          rowKey="id"
          dataSource={templates}
          columns={[
            {
              title: 'Тип', render: (_, t) => (
                <span>
                  <b>{t.name ?? t.id}</b>{' '}
                  {t.custom
                    ? <Tag color="green">свой</Tag>
                    : <Tag>штатный</Tag>}
                  <div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{t.id}</Typography.Text></div>
                </span>
              ),
            },
            { title: 'Групп', width: 70, render: (_, t) => t.groups?.length ?? 0 },
            { title: 'Параметров', width: 100, render: (_, t) => (t.groups ?? []).flatMap(g => g.params).length },
            {
              title: '', width: 250, render: (_, t) => (
                <Space size={4}>
                  <Tooltip title="Создать свой тип на основе этого">
                    <Button size="small" icon={<CopyOutlined />} onClick={() => startNew(t.id)}>За основу</Button>
                  </Tooltip>
                  {t.custom && (
                    <>
                      <Button size="small" icon={<EditOutlined />} onClick={() => startEdit(t)}>Изменить</Button>
                      <Popconfirm
                        title="Удалить тип?"
                        description="Файл шаблона будет удалён. Устройства этого типа сначала нужно перевести на другой."
                        okText="Удалить" cancelText="Отмена" okButtonProps={{ danger: true }}
                        onConfirm={() => remove(t)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    )
  }

  // ─── Форма создания/правки ─────────────────────────────────────────────────
  const draftParams = editing.groups.flatMap(g => g.params.map(p => ({ ...p, __group: g.id, __groupName: g.name })))

  return (
    <Modal
      title={<Space><ApartmentOutlined />{editing.isNew ? 'Новый тип ПЧ' : `Правка типа: ${editing.name}`}</Space>}
      open={open}
      onCancel={() => setEditing(null)}
      width={1100}
      footer={[
        <Button key="back" onClick={() => setEditing(null)}>Назад к списку</Button>,
        <Button key="save" type="primary" loading={saving} onClick={save}>Сохранить тип</Button>,
      ]}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Input
          addonBefore="Идентификатор"
          placeholder="My-Pump-Lite"
          value={editing.id}
          disabled={!editing.isNew}
          onChange={e => setEditing({ ...editing, id: e.target.value })}
          style={{ width: 300 }}
        />
        <Input
          addonBefore="Название"
          placeholder="Мой ПЧ"
          value={editing.name}
          onChange={e => setEditing({ ...editing, name: e.target.value })}
          style={{ width: 300 }}
        />
        <Input
          addonBefore="Семейство"
          placeholder="pump / vl / delphi"
          value={editing.family}
          onChange={e => setEditing({ ...editing, family: e.target.value })}
          style={{ width: 260 }}
        />
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -4 }}>
        Идентификатор — латиницей, без пробелов, он же имя файла и его нельзя поменять позже.
        Семейство определяет, с какими типами разрешены групповые операции: у одного семейства
        должна быть совместимая карта регистров.
      </Typography.Paragraph>

      {editing.isNew && base && (
        <>
          <Divider orientation="left" style={{ margin: '8px 0' }}>
            Что взять из «{base.name}»
          </Divider>
          <Space style={{ marginBottom: 8 }} wrap>
            <Button size="small" onClick={() => setPicked(new Set(base.groups.flatMap(g => g.params.map(p => p.id))))}>
              Отметить всё
            </Button>
            <Button size="small" onClick={() => setPicked(new Set())}>Снять всё</Button>
            <Button size="small" type="primary" onClick={applyPicked}>
              Перенести отмеченные ({picked.size})
            </Button>
          </Space>
          <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 12 }}>
            <Collapse
              size="small"
              items={base.groups.map(g => {
                const inG = g.params.filter(p => picked.has(p.id)).length
                return {
                  key: g.id,
                  label: (
                    <Space>
                      <span onClick={e => e.stopPropagation()}>
                        <Checkbox
                          checked={inG === g.params.length && inG > 0}
                          indeterminate={inG > 0 && inG < g.params.length}
                          onChange={e => toggleGroup(g, e.target.checked)}
                        />
                      </span>
                      <span>{g.name}</span>
                      {inG > 0 && <Tag color="blue">{inG}</Tag>}
                    </Space>
                  ),
                  children: (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      {g.params.map(p => (
                        <Checkbox key={p.id} checked={picked.has(p.id)} onChange={e => toggleParam(p.id, e.target.checked)}>
                          <Typography.Text code style={{ fontSize: 11 }}>{p.id}</Typography.Text>{' '}
                          <span style={{ fontSize: 12 }}>{p.name}</span>
                        </Checkbox>
                      ))}
                    </Space>
                  ),
                }
              })}
            />
          </div>
        </>
      )}

      <Divider orientation="left" style={{ margin: '8px 0' }}>
        Параметры типа ({draftParams.length})
      </Divider>
      {draftParams.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          message="Параметров пока нет"
          description={editing.isNew && base
            ? 'Отметьте нужные выше и нажмите «Перенести отмеченные».'
            : 'Создайте тип на основе имеющегося — так проще всего получить готовую карту регистров.'}
        />
      ) : (
        <Table
          size="small"
          pagination={{ pageSize: 8, size: 'small' }}
          rowKey={r => `${r.__group}:${r.id}`}
          dataSource={draftParams}
          columns={[
            { title: 'Группа', dataIndex: '__groupName', width: 130, ellipsis: true },
            { title: 'Код', dataIndex: 'id', width: 80 },
            {
              title: 'Название', width: 220,
              render: (_, r) => (
                <Input size="small" value={r.name}
                  onChange={e => patchParam(r.__group, r.id, { name: e.target.value })} />
              ),
            },
            {
              title: 'Регистр', width: 100,
              render: (_, r) => (
                <InputNumber size="small" min={0} max={65535} value={r.register} style={{ width: '100%' }}
                  onChange={v => patchParam(r.__group, r.id, { register: v })} />
              ),
            },
            {
              title: 'Тип', width: 130,
              render: (_, r) => (
                <Select size="small" value={r.type} options={PARAM_TYPES} style={{ width: '100%' }}
                  onChange={v => patchParam(r.__group, r.id, { type: v })} />
              ),
            },
            {
              title: 'Масштаб', width: 90,
              render: (_, r) => (
                <InputNumber size="small" step={0.01} value={r.scale ?? 1} style={{ width: '100%' }}
                  onChange={v => patchParam(r.__group, r.id, { scale: v })} />
              ),
            },
            {
              title: 'Ед.', width: 70,
              render: (_, r) => (
                <Input size="small" value={r.unit ?? ''}
                  onChange={e => patchParam(r.__group, r.id, { unit: e.target.value })} />
              ),
            },
            {
              title: 'Мин', width: 80,
              render: (_, r) => (
                <InputNumber size="small" value={r.min} style={{ width: '100%' }}
                  onChange={v => patchParam(r.__group, r.id, { min: v })} />
              ),
            },
            {
              title: 'Макс', width: 80,
              render: (_, r) => (
                <InputNumber size="small" value={r.max} style={{ width: '100%' }}
                  onChange={v => patchParam(r.__group, r.id, { max: v })} />
              ),
            },
            {
              title: 'Заводское', width: 90,
              render: (_, r) => (
                <InputNumber size="small" value={typeof r.default === 'number' ? r.default : undefined}
                  style={{ width: '100%' }}
                  onChange={v => patchParam(r.__group, r.id, { default: v })} />
              ),
            },
            {
              title: 'Доступ', width: 140,
              render: (_, r) => (
                <Select size="small" value={r.access} options={ACCESS_OPTIONS} style={{ width: '100%' }}
                  onChange={v => patchParam(r.__group, r.id, { access: v })} />
              ),
            },
            {
              title: '', width: 40,
              render: (_, r) => (
                <Tooltip title="Убрать параметр из типа">
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}
                    onClick={() => removeParam(r.__group, r.id)} />
                </Tooltip>
              ),
            },
          ]}
          scroll={{ x: 'max-content' }}
        />
      )}
    </Modal>
  )
}
