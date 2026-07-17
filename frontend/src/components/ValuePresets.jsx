import { useState, useEffect } from 'react'
import { List, Button, Input, Checkbox, InputNumber, Select, Typography, Space, Popconfirm, message, Empty, Collapse, Tag } from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons'
import api from '../api'
import { formatParamValue, normalizeOptions } from '../paramFormat'

function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

// Вкладка "Шаблоны" — именованные наборы подготовленных значений (пресеты) для
// одного семейства ПЧ. Изначально шаблон пуст (0 групп, 0 регистров); галочка
// на группе разом добавляет в шаблон все её регистры с заводскими значениями,
// дальше каждое значение можно поправить или убрать конкретный регистр из
// шаблона отдельно. Применяются такие шаблоны к выбранным устройствам либо
// кнопкой "Подготовить из шаблона" на вкладке "Параметры", либо прямо отсюда
// кнопкой у конкретного шаблона в списке (только если открыто в контексте
// уже выбранных ПЧ этого семейства — `devices`).
export default function ValuePresets({ device, devices }) {
  const family = deviceFamily(device.templateId ?? device.id)
  const targetDevices = devices ?? [device]
  const [presets, setPresets] = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null) // preset object being edited, or { id: null, name: '', family, values: {} } для нового
  const [nameInput, setNameInput] = useState('')
  const [values, setValues] = useState({}) // paramId -> value, черновик редактора
  const [saving, setSaving] = useState(false)
  const [applyingId, setApplyingId] = useState(null)

  function load() {
    setLoading(true)
    api.get('/presets', { params: { family } })
      .then(({ data }) => setPresets(data))
      .catch(() => setPresets([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [family])

  function startCreate() {
    setEditing({ id: null, name: '', family, values: {} })
    setNameInput('')
    setValues({})
  }

  function startEdit(preset) {
    setEditing(preset)
    setNameInput(preset.name)
    setValues({ ...preset.values })
  }

  async function remove(preset) {
    try {
      await api.delete(`/presets/${preset.id}`)
      message.success(`Шаблон «${preset.name}» удалён`)
      load()
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Ошибка удаления')
    }
  }

  // То же самое, что кнопка "Подготовить из шаблона" на вкладке "Параметры",
  // только напрямую отсюда — удобно, когда шаблонов много и хочется применить
  // конкретный, не переключаясь на вкладку. Подтверждение (Popconfirm) — не
  // прямое применение по одному клику, случайное нажатие на реальном
  // оборудовании иначе может тихо испортить черновики сразу нескольким ПЧ.
  async function applyPreset(preset) {
    if (targetDevices.length === 0) return
    setApplyingId(preset.id)
    try {
      await Promise.all(targetDevices.map(d =>
        api.patch(`/devices/${d.id}/pending-writes`, { merge: true, pendingWrites: preset.values }).catch(() => {})
      ))
      message.success(`Шаблон «${preset.name}» применён к ${targetDevices.length} устр. — значения подготовлены к записи на вкладке «Параметры»`)
    } finally {
      setApplyingId(null)
    }
  }

  function groupAllInPreset(group) {
    return group.params.filter(p => p.access !== 'read').every(p => values[p.id] !== undefined)
  }
  function groupSomeInPreset(group) {
    return group.params.some(p => values[p.id] !== undefined)
  }

  function toggleGroup(group, checked) {
    setValues(prev => {
      const next = { ...prev }
      for (const p of group.params) {
        if (p.access === 'read') continue
        if (checked) {
          if (next[p.id] === undefined) {
            next[p.id] = typeof p.default === 'number' ? p.default : (p.min ?? 0)
          }
        } else {
          delete next[p.id]
        }
      }
      return next
    })
  }

  function removeParam(paramId) {
    setValues(prev => {
      const next = { ...prev }
      delete next[paramId]
      return next
    })
  }

  function setParamValue(paramId, val) {
    setValues(prev => ({ ...prev, [paramId]: val }))
  }

  async function save() {
    const trimmed = nameInput.trim()
    if (!trimmed) { message.warning('Введите название шаблона'); return }
    setSaving(true)
    try {
      if (editing.id) {
        await api.patch(`/presets/${editing.id}`, { name: trimmed, values })
        message.success('Шаблон сохранён')
      } else {
        await api.post('/presets', { name: trimmed, family, values })
        message.success('Шаблон создан')
      }
      setEditing(null)
      load()
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  const allParamsById = new Map(device.groups.flatMap(g => g.params).map(p => [p.id, p]))

  if (editing) {
    return (
      <div>
        <Space style={{ marginBottom: 16 }} align="start">
          <Input
            placeholder="Название шаблона"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            style={{ width: 280 }}
          />
          <Tag color={family === 'vl' ? 'purple' : 'green'}>{family === 'vl' ? 'VL' : 'Pump'}</Tag>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            Сохранить шаблон
          </Button>
          <Button onClick={() => setEditing(null)}>Отмена</Button>
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
          Отметьте группы, которые должны войти в шаблон — все их регистры добавятся с заводскими значениями.
          Ненужный регистр можно убрать отдельно, а нужное значение — поправить. В шаблоне сейчас {Object.keys(values).length} регистров.
        </Typography.Text>

        <Collapse
          items={device.groups.map(group => {
            const writableParams = group.params.filter(p => p.access !== 'read')
            if (writableParams.length === 0) return null
            const inPreset = writableParams.filter(p => values[p.id] !== undefined)
            return {
              key: group.id,
              label: (
                <Space onClick={e => e.stopPropagation()}>
                  <Checkbox
                    checked={groupAllInPreset(group)}
                    indeterminate={groupSomeInPreset(group) && !groupAllInPreset(group)}
                    onChange={e => toggleGroup(group, e.target.checked)}
                  />
                  <span>{group.name}</span>
                  {inPreset.length > 0 && <Tag color="blue">{inPreset.length} в шаблоне</Tag>}
                </Space>
              ),
              children: inPreset.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Отметьте группу галочкой выше, чтобы добавить её регистры в шаблон
                </Typography.Text>
              ) : (
                <Space direction="vertical" style={{ width: '100%' }} size={4}>
                  {inPreset.map(p => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Typography.Text code style={{ fontSize: 11, width: 70, flexShrink: 0 }}>{p.id}</Typography.Text>
                      <Typography.Text style={{ fontSize: 12, width: 260, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </Typography.Text>
                      {p.type === 'enum' ? (
                        <Select
                          size="small"
                          style={{ width: 200 }}
                          value={values[p.id]}
                          options={normalizeOptions(p.options)}
                          onChange={v => setParamValue(p.id, v)}
                        />
                      ) : (
                        <InputNumber
                          size="small"
                          style={{ width: 140 }}
                          min={p.min}
                          max={p.max}
                          step={p.step ?? p.scale ?? 1}
                          value={values[p.id]}
                          onChange={v => v != null && setParamValue(p.id, v)}
                          addonAfter={p.unit}
                        />
                      )}
                      <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => removeParam(p.id)} />
                    </div>
                  ))}
                </Space>
              ),
            }
          }).filter(Boolean)}
        />
      </div>
    )
  }

  return (
    <div>
      <Button type="primary" icon={<PlusOutlined />} onClick={startCreate} style={{ marginBottom: 16 }}>
        Создать шаблон
      </Button>
      {presets.length === 0 && !loading ? (
        <Empty description={`Нет шаблонов для ${family === 'vl' ? 'VL' : 'Pump'}`} />
      ) : (
        <List
          loading={loading}
          bordered
          dataSource={presets}
          renderItem={preset => (
            <List.Item
              actions={[
                <Popconfirm
                  key="apply"
                  title={`Применить шаблон «${preset.name}»?`}
                  description={`Подготовленные значения обновятся у ${targetDevices.length} выбранных устройств (${targetDevices.map(d => d.name).join(', ')}). Сама запись в ПЧ не произойдёт — только подготовка черновика.`}
                  okText="Применить"
                  cancelText="Отмена"
                  disabled={targetDevices.length === 0 || Object.keys(preset.values).length === 0}
                  onConfirm={() => applyPreset(preset)}
                >
                  <Button
                    key="apply-btn"
                    size="small"
                    type="primary"
                    icon={<ThunderboltOutlined />}
                    loading={applyingId === preset.id}
                    disabled={targetDevices.length === 0 || Object.keys(preset.values).length === 0}
                    title={targetDevices.length === 0 ? 'Нет выбранных устройств этого типа' : undefined}
                  >
                    Применить для выбранных ({targetDevices.length})
                  </Button>
                </Popconfirm>,
                <Button key="edit" size="small" icon={<EditOutlined />} onClick={() => startEdit(preset)}>Изменить</Button>,
                <Popconfirm key="delete" title="Удалить шаблон?" okText="Удалить" cancelText="Отмена" okButtonProps={{ danger: true }} onConfirm={() => remove(preset)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>Удалить</Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={preset.name}
                description={
                  <Space wrap size={4}>
                    <Tag>{Object.keys(preset.values).length} регистров</Tag>
                    {Object.entries(preset.values).slice(0, 4).map(([paramId, val]) => {
                      const p = allParamsById.get(paramId)
                      return (
                        <Tag key={paramId} style={{ fontSize: 11 }}>
                          {paramId}: {p ? formatParamValue(p.type, val, p.unit, p.options) : val}
                        </Tag>
                      )
                    })}
                    {Object.keys(preset.values).length > 4 && <Tag style={{ fontSize: 11 }}>…</Tag>}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
    </div>
  )
}
