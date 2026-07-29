import { useState, useEffect, useRef } from 'react'
import { List, Button, Input, Checkbox, InputNumber, Select, Typography, Space, Popconfirm, message, Empty, Collapse, Tag, Table } from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined, SaveOutlined, ThunderboltOutlined, DownloadOutlined, UploadOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import api from '../api'
import { formatParamValue, normalizeOptions } from '../paramFormat'
import { isParamWritable } from '../access'
import { downloadCsv, parseCsv } from '../csv'

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
  const [expandedId, setExpandedId] = useState(null) // раскрытая карточка шаблона (показ всех регистров)
  const importInputRef = useRef(null)

  function load() {
    setLoading(true)
    api.get('/presets', { params: { family } })
      .then(({ data }) => setPresets(data))
      .catch(() => setPresets([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [family])

  // Шаблон может быть создан из другого места (кнопка «Создать шаблон из
  // избранного» на вкладке «Параметры») — перечитываем список по событию,
  // иначе он появлялся здесь только после перезагрузки страницы.
  useEffect(() => {
    function onPresetsChanged() { load() }
    window.addEventListener('presets:changed', onPresetsChanged)
    return () => window.removeEventListener('presets:changed', onPresetsChanged)
  }, [family])

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

  // Экспорт/импорт CSV — тот же формат (колонки "Параметр"/"Значение"), что и
  // экспорт "Текущие параметры" на вкладке "Параметры" (ParamGroups.jsx), поэтому
  // считанные с реального ПЧ значения можно сохранить как заготовку шаблона.
  function exportPresetCsv(preset) {
    const rows = Object.entries(preset.values).map(([paramId, val]) => {
      const p = allParamsById.get(paramId)
      return [paramId, p?.name ?? '', val, p?.unit ?? '']
    })
    downloadCsv(
      `preset_${preset.name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.csv`,
      ['Параметр', 'Название', 'Значение', 'Единица'],
      rows,
    )
  }

  function triggerImport() {
    importInputRef.current?.click()
  }

  function handleImportFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const rows = parseCsv(String(reader.result))
      if (rows.length === 0) { message.error('Пустой CSV-файл'); return }
      const header = rows[0].map(h => h.trim().toLowerCase())
      const idIdx = header.findIndex(h => h === 'параметр' || h === 'id')
      const valIdx = header.findIndex(h => h === 'значение' || h === 'value')
      if (idIdx === -1 || valIdx === -1) {
        message.error('В CSV не найдены колонки "Параметр" и "Значение"')
        return
      }
      const parsed = {}
      let skipped = 0
      for (const row of rows.slice(1)) {
        const paramId = row[idIdx]?.trim()
        const rawVal = row[valIdx]?.trim()
        if (!paramId || !rawVal) continue
        const param = allParamsById.get(paramId)
        const num = Number(rawVal)
        // Пропускаем параметры не из этой модели ПЧ, нечисловые значения и
        // параметры, недоступные для записи (например, считанные показания
        // датчиков) — шаблон нужен для записи в устройство, а не для чтения.
        if (!param || Number.isNaN(num) || !isParamWritable(device, param)) { skipped++; continue }
        parsed[paramId] = num
      }
      if (Object.keys(parsed).length === 0) {
        message.error('В CSV не найдено ни одного параметра, доступного для записи у этой модели ПЧ')
        return
      }
      const name = file.name.replace(/\.csv$/i, '')
      setEditing({ id: null, name, family, values: parsed })
      setNameInput(name)
      setValues(parsed)
      message.success(`Импортировано ${Object.keys(parsed).length} параметров${skipped ? `, пропущено ${skipped}` : ''} — проверьте и сохраните шаблон`)
    }
    reader.onerror = () => message.error('Не удалось прочитать файл')
    reader.readAsText(file, 'utf-8')
  }

  // Группы делятся на «используемые» (хотя бы один параметр входит в шаблон) и
  // «неиспользуемые». Группы без записываемых параметров в редакторе не нужны.
  const editableGroups = (device.groups ?? []).filter(g => g.params.some(p => p.access !== 'read'))
  const usedGroups = editableGroups.filter(g => groupSomeInPreset(g))
  const unusedGroups = editableGroups.filter(g => !groupSomeInPreset(g))

  // Панель одной группы. dim=true — неиспользуемая: тускло-серая, а значения
  // показываются ЗАВОДСКИЕ (именно они уйдут в ПЧ при записи, если группу так и
  // не добавить в шаблон).
  function groupPanel(group, dim) {
    const writableParams = group.params.filter(p => p.access !== 'read')
    const inPreset = writableParams.filter(p => values[p.id] !== undefined)
    const color = dim ? '#8c8c8c' : undefined
    return {
      key: group.id,
      style: dim ? { background: 'transparent' } : undefined,
      label: (
        <Space onClick={e => e.stopPropagation()}>
          <Checkbox
            checked={groupAllInPreset(group)}
            indeterminate={groupSomeInPreset(group) && !groupAllInPreset(group)}
            onChange={e => toggleGroup(group, e.target.checked)}
          />
          <span style={{ color }}>{group.name}</span>
          {inPreset.length > 0
            ? <Tag color="blue">{inPreset.length} в шаблоне</Tag>
            : <Tag style={{ color: '#8c8c8c' }}>{writableParams.length} рег. — заводские</Tag>}
        </Space>
      ),
      children: dim ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            Группа не входит в шаблон. При записи в эти регистры будут записаны заводские значения —
            отметьте группу галочкой выше, чтобы задать свои.
          </Typography.Text>
          <Space direction="vertical" style={{ width: '100%' }} size={2}>
            {writableParams.map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#8c8c8c' }}>
                <Typography.Text code style={{ fontSize: 11, width: 70, flexShrink: 0, color: '#8c8c8c' }}>{p.id}</Typography.Text>
                <Typography.Text style={{ fontSize: 12, width: 260, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8c8c8c' }}>
                  {p.name}
                </Typography.Text>
                <Typography.Text style={{ fontSize: 12, color: '#8c8c8c' }}>
                  {formatParamValue(p.type, p.default, p.unit, p.options, p.bits)}
                </Typography.Text>
              </div>
            ))}
          </Space>
        </>
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
  }

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

        {/* Используемые группы шаблона — ярким цветом, раскрываются по клику
            (сначала только названия групп, параметры внутри — вторым уровнем). */}
        <Collapse
          defaultActiveKey={['used']}
          style={{ marginBottom: 12 }}
          items={[{
            key: 'used',
            label: (
              <Space>
                <Typography.Text strong>Используемые группы шаблона</Typography.Text>
                <Tag color="blue">{usedGroups.length}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  эти значения шаблон задаёт явно
                </Typography.Text>
              </Space>
            ),
            children: usedGroups.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Пока ни одна группа не входит в шаблон — отметьте нужные ниже, в списке неиспользуемых
              </Typography.Text>
            ) : (
              <Collapse items={usedGroups.map(group => groupPanel(group, false))} />
            ),
          }]}
        />

        {/* Неиспользуемые группы — тускло-серым. Их параметры шаблон не задаёт,
            поэтому при записи в них уйдут ЗАВОДСКИЕ значения (показаны внутри). */}
        <Collapse
          items={[{
            key: 'unused',
            label: (
              <Space>
                <Typography.Text style={{ color: '#8c8c8c' }}>Неиспользуемые группы</Typography.Text>
                <Tag>{unusedGroups.length}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  шаблон их не задаёт — при записи получат заводские значения
                </Typography.Text>
              </Space>
            ),
            children: unusedGroups.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Все группы уже входят в шаблон
              </Typography.Text>
            ) : (
              <Collapse items={unusedGroups.map(group => groupPanel(group, true))} />
            ),
          }]}
        />
      </div>
    )
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>
          Создать шаблон
        </Button>
        <Button icon={<UploadOutlined />} onClick={triggerImport}>
          Импорт из CSV
        </Button>
        <input
          ref={importInputRef}
          type="file"
          accept=".csv"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
      </Space>
      {presets.length === 0 && !loading ? (
        <Empty description={`Нет шаблонов для ${family === 'vl' ? 'VL' : 'Pump'}`} />
      ) : (
        <List
          loading={loading}
          bordered
          dataSource={presets}
          renderItem={preset => (
            // Не используем стандартный `actions` List.Item — при 4 кнопках
            // (в т.ч. одной с длинным текстом) и многострочных тегах описания
            // он может наезжать текстом на кнопки на узких экранах. Свой
            // flex-ряд с flexWrap переносит кнопки на отдельную строку вместо
            // наложения, если места не хватает.
            <List.Item>
              <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <List.Item.Meta
                style={{ flex: '1 1 260px', minWidth: 0 }}
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
              <Space wrap size={4} style={{ flexShrink: 0 }}>
                <Button
                  size="small"
                  icon={expandedId === preset.id ? <UpOutlined /> : <DownOutlined />}
                  disabled={Object.keys(preset.values).length === 0}
                  onClick={() => setExpandedId(expandedId === preset.id ? null : preset.id)}
                >
                  {expandedId === preset.id ? 'Свернуть' : 'Подробнее'}
                </Button>
                <Popconfirm
                  title={`Применить шаблон «${preset.name}»?`}
                  description={`Подготовленные значения обновятся у ${targetDevices.length} выбранных устройств (${targetDevices.map(d => d.name).join(', ')}). Сама запись в ПЧ не произойдёт — только подготовка черновика.`}
                  okText="Применить"
                  cancelText="Отмена"
                  disabled={targetDevices.length === 0 || Object.keys(preset.values).length === 0}
                  onConfirm={() => applyPreset(preset)}
                >
                  <Button
                    size="small"
                    type="primary"
                    icon={<ThunderboltOutlined />}
                    loading={applyingId === preset.id}
                    disabled={targetDevices.length === 0 || Object.keys(preset.values).length === 0}
                    title={targetDevices.length === 0 ? 'Нет выбранных устройств этого типа' : undefined}
                  >
                    Применить для выбранных ПЧ ({targetDevices.length})
                  </Button>
                </Popconfirm>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  disabled={Object.keys(preset.values).length === 0}
                  onClick={() => exportPresetCsv(preset)}
                >
                  CSV
                </Button>
                <Button size="small" icon={<EditOutlined />} onClick={() => startEdit(preset)}>Изменить</Button>
                <Popconfirm title="Удалить шаблон?" okText="Удалить" cancelText="Отмена" okButtonProps={{ danger: true }} onConfirm={() => remove(preset)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>Удалить</Button>
                </Popconfirm>
              </Space>
              </div>
              {expandedId === preset.id && (
                <div style={{ marginTop: 12 }}>
                  <Table
                    size="small"
                    pagination={false}
                    scroll={{ y: 320 }}
                    dataSource={Object.entries(preset.values).map(([paramId, val]) => {
                      const p = allParamsById.get(paramId)
                      return {
                        key: paramId,
                        id: paramId,
                        name: p?.name ?? '— нет в текущей модели',
                        value: p ? formatParamValue(p.type, val, p.unit, p.options) : val,
                      }
                    })}
                    columns={[
                      { title: 'Параметр', dataIndex: 'id', width: 100 },
                      { title: 'Название', dataIndex: 'name' },
                      { title: 'Значение', dataIndex: 'value', width: 180 },
                    ]}
                    locale={{ emptyText: 'Шаблон пуст' }}
                  />
                </div>
              )}
              </div>
            </List.Item>
          )}
        />
      )}
    </div>
  )
}
