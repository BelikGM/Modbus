import { useState, useEffect, useRef } from 'react'
import {
  Button, Table, Input, Select, InputNumber, Space, Typography, Tag, message, Popconfirm, Alert, Collapse, Checkbox, Divider, Tooltip,
} from 'antd'
import AppModal from './AppModal'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ApartmentOutlined, CopyOutlined,
  UndoOutlined, RedoOutlined,
} from '@ant-design/icons'
import api from '../api'
import { addLog } from '../log'
import { normalizeOptions } from '../paramFormat'
import useUndoHistory from '../useUndoHistory'
import TemplateExtras from './TemplateExtras'

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

// Поля, которые бэкенд проставляет сам при чтении шаблона (признак «свой»,
// списки исполнений из поставки). В файл своего типа они попадать не должны —
// иначе копия штатного типа тащила бы за собой чужую служебную разметку.
const RUNTIME_FIELDS = ['custom', 'template', 'builtinModels', 'builtinFirmwares']

function copyTemplate(t) {
  const copy = JSON.parse(JSON.stringify(t))
  for (const f of RUNTIME_FIELDS) delete copy[f]
  return copy
}

// Ссылки на параметры, которых в типе больше нет, чистим: оповещение по
// несуществующему paramId молча не сработает, а команда заводского сброса
// укажет не на тот регистр — ровно та ошибка, что случается при переносе блока
// alerts между разными моделями.
function pruneToParams(draft) {
  const ids = new Set((draft.groups ?? []).flatMap(g => g.params.map(p => p.id)))
  const next = { ...draft }
  if (next.alerts) next.alerts = next.alerts.filter(a => ids.has(a.paramId))
  if (next.builtinFavorites) next.builtinFavorites = next.builtinFavorites.filter(id => ids.has(id))
  if (next.modelDependentParams) next.modelDependentParams = next.modelDependentParams.filter(id => ids.has(id))
  if (next.factoryReset?.paramId && !ids.has(next.factoryReset.paramId)) next.factoryReset = undefined
  if (next.firmwareOverrides) {
    next.firmwareOverrides = Object.fromEntries(
      Object.entries(next.firmwareOverrides)
        .map(([fw, map]) => [fw, Object.fromEntries(
          Object.entries(map ?? {}).filter(([paramId]) => ids.has(paramId)),
        )])
        .filter(([, map]) => Object.keys(map).length > 0),
    )
  }
  return next
}

// Незаконченный тип переживает закрытие окна и перезапуск программы. Тип на
// полсотни регистров заполняется по бумажному руководству не за один присест, и
// забытое «Сохранить» не должно стоить всей работы. Черновик всегда один: он
// либо превращается в сохранённый тип, либо удаляется руками.
const DRAFT_KEY = 'modbus.templateDraft'

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    const kept = raw ? JSON.parse(raw) : null
    return kept?.draft ? kept : null
  } catch { return null }   // хранилище недоступно или запись битая
}

function writeDraft(kept) {
  try {
    if (kept) localStorage.setItem(DRAFT_KEY, JSON.stringify(kept))
    else localStorage.removeItem(DRAFT_KEY)
  } catch { /* переполнение/приватный режим: черновик просто не переживёт окно */ }
}

function draftSize(d) {
  const groups = d?.groups ?? []
  return { groups: groups.length, params: groups.flatMap(g => g.params ?? []).length }
}

export default function TemplateEditor({ open, onClose }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditingState] = useState(null) // редактируемый тип (черновик)
  const [baseId, setBaseId] = useState(null)   // тип-основа при создании
  const [picked, setPicked] = useState(new Set()) // выбранные paramId из основы
  const [saving, setSaving] = useState(false)
  // Отдельный режим: каталог исполнений (моделей) и список прошивок. Для
  // ШТАТНЫХ типов эти данные хранятся не в файле поставки, а в отдельном файле
  // дополнений — так эталон остаётся нетронутым, а список переживает обновление.
  const [extras, setExtrasState] = useState(null) // { type, models: [], firmwares: [] }
  // Редактор вариантов значения для параметров типа «Перечисление»
  // (пуск/стоп/вперёд/назад и т.п.) — иначе такой параметр пришлось бы
  // дописывать в JSON руками.
  const [optionsEditor, setOptionsEditor] = useState(null)
  const [newFirmware, setNewFirmware] = useState('')
  // Раскрытая группа (режим «гармошки»: открыта всегда одна) и группа под
  // курсором — кнопки правки показываем только при наведении, чтобы список
  // групп оставался читаемым.
  const [openGroup, setOpenGroup] = useState(null)
  const [hoverGroup, setHoverGroup] = useState(null)
  const [renamingGroup, setRenamingGroup] = useState(null)
  // Черновик «как был при открытии формы»: по нему видно, правили ли тип, —
  // чтобы не запоминать пустую заготовку, которую просто открыли и закрыли.
  const draftOpened = useRef(null)
  // Отложенный незаконченный тип (из хранилища) — то, что ждёт в списке типов.
  const [stash, setStash] = useState(readDraft)

  // Отмена действий. Два независимых журнала: правка типа и каталог моделей —
  // это разные экраны, и общая история путала бы шаги между ними. Дальше по
  // коду используются именно обёртки — через них проходит каждое изменение.
  const draftUndo = useUndoHistory(editing, setEditingState, open)
  const extrasUndo = useUndoHistory(extras, setExtrasState, open)
  const setEditing = draftUndo.set
  const setExtras = extrasUndo.set

  // Кнопки «Отменить»/«Вернуть» — одинаковые на обоих экранах
  function undoButtons(h) {
    return [
      <Tooltip key="undo" title={h.canUndo ? `Отменить последнее действие (Ctrl+Z), шагов: ${h.steps}` : 'Отменять нечего'}>
        <Button icon={<UndoOutlined />} disabled={!h.canUndo} onClick={h.undo} />
      </Tooltip>,
      <Tooltip key="redo" title="Вернуть отменённое (Ctrl+Y)">
        <Button icon={<RedoOutlined />} disabled={!h.canRedo} onClick={h.redo} />
      </Tooltip>,
    ]
  }

  function startExtras(t) {
    setExtras({
      type: t,
      models: [...(t.models ?? [])],
      firmwares: [...(t.firmwares ?? [])],
    })
  }

  function addFirmware() {
    const v = newFirmware.trim()
    if (!v) return
    if (extras.firmwares.includes(v)) { message.warning('Такая версия уже есть'); return }
    setExtras({ ...extras, firmwares: [...extras.firmwares, v] })
    setNewFirmware('')
  }

  function removeFirmware(fw) {
    if ((extras.type.builtinFirmwares ?? []).includes(fw)) {
      message.warning('Версия из поставки — её удалить нельзя')
      return
    }
    setExtras({ ...extras, firmwares: extras.firmwares.filter(x => x !== fw) })
  }

  async function saveExtras() {
    setSaving(true)
    try {
      const bad = extras.models.find(m => !String(m.code ?? '').trim())
      if (bad) { message.warning('У исполнения не заполнен артикул'); return }
      await api.patch(`/devices/templates/${encodeURIComponent(extras.type.id)}/extras`, {
        models: extras.models,
        firmwares: extras.firmwares,
      })
      message.success('Модели и прошивки сохранены')
      addLog('success', `Обновлён каталог исполнений типа «${extras.type.name ?? extras.type.id}»: моделей ${extras.models.length}, прошивок ${extras.firmwares.length}`)
      setExtras(null)
      load()
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }


  function load() {
    setLoading(true)
    api.get('/devices/templates')
      .then(({ data }) => setTemplates(data ?? []))
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => { if (open) { load(); setStash(readDraft()) } }, [open])

  // Окно «Типы ПЧ» закрыли целиком — форму сворачиваем, но незаписанный тип
  // откладываем, а не выбрасываем: он ждёт в списке типов.
  useEffect(() => {
    if (open) return
    keepDraft()
    clearForm()
    setExtrasState(null); extrasUndo.reset()
    setNewFirmware('')
  }, [open])

  // Страховка от вылета/закрытия всей программы: черновик пишется не только при
  // выходе из формы, но и сам по себе — с задержкой, чтобы каждая набранная
  // буква не уходила в хранилище.
  useEffect(() => {
    if (!editing) return
    const t = setTimeout(keepDraft, 600)
    return () => clearTimeout(t)
  }, [editing, baseId, picked])

  const base = templates.find(t => t.id === baseId) ?? null

  // ─── Жизненный цикл черновика ──────────────────────────────────────────────
  function beginDraft(draft) {
    draftOpened.current = JSON.stringify(draft)
    setOpenGroup(null); setHoverGroup(null); setRenamingGroup(null); setOptionsEditor(null)
    setEditing(draft)
  }

  // Отложить черновик. Нетронутую заготовку не запоминаем — иначе список типов
  // навсегда обзавёлся бы пустым «незаконченным типом» от одного случайного
  // клика по «Создать с нуля». Чужой отложенный черновик при этом не трогаем.
  function keepDraft() {
    if (!editing || JSON.stringify(editing) === draftOpened.current) return
    const kept = { draft: editing, baseId, picked: [...picked], savedAt: Date.now() }
    writeDraft(kept)
    setStash(kept)
  }

  // Сама форма: закрыть и обнулить экранное состояние (черновик к этому моменту
  // уже отложен либо намеренно выброшен).
  function clearForm() {
    draftOpened.current = null
    setBaseId(null); setPicked(new Set())
    setOpenGroup(null); setHoverGroup(null); setRenamingGroup(null); setOptionsEditor(null)
    setEditing(null)   // заодно чистит историю отмены
  }

  // Выход из формы (крестик, Escape, «Назад к списку») — ничего не теряется.
  function leaveDraft() {
    const kept = editing && JSON.stringify(editing) !== draftOpened.current
    keepDraft()
    clearForm()
    if (kept) message.info('Черновик отложен — вернуться к нему можно кнопкой «Продолжить черновик»')
  }

  // Черновик больше не нужен: тип сохранён или выброшен руками.
  function forgetDraft() {
    writeDraft(null)
    setStash(null)
  }

  // Вернуться к отложенному типу ровно в том виде, в каком его оставили, —
  // вместе с выбранной основой и отметками параметров.
  function resumeDraft() {
    if (!stash) return
    setBaseId(stash.baseId ?? null)
    setPicked(new Set(stash.picked ?? []))
    beginDraft(stash.draft)
  }

  // ─── Создание ──────────────────────────────────────────────────────────────
  // Свободный идентификатор для копии: он же имя файла, и занять чужой нельзя.
  function freeTemplateId(wanted) {
    if (!templates.some(t => t.id === wanted)) return wanted
    let n = 2
    while (templates.some(t => t.id === `${wanted}-${n}`)) n++
    return `${wanted}-${n}`
  }

  // «За основу» — это ПОЛНАЯ копия типа, а не одни лишь группы параметров:
  // название, семейство, описание, фотографии, параметры связи, коды аварий,
  // пороговые оповещения, команда заводского сброса, правила адресации, каталог
  // исполнений — всё на месте сразу, ещё до того как решено, какие параметры
  // оставить. Раньше эти разделы заполнялись только после «Перенести
  // отмеченные», и до первого переноса форма выглядела пустой, хотя основа уже
  // выбрана; заодно терялись поля, которых перенос не знал (addressingRules у
  // VL, familyLabel, примечание к прошивкам).
  // Предупреждение, а не запрет: отложенный черновик один, и начатый заново тип
  // займёт его место — но только когда его действительно начнут править.
  function warnStashReplaced() {
    if (!stash) return
    const name = stash.draft.name || stash.draft.id || 'без названия'
    message.warning(`Отложенный черновик «${name}» будет заменён, как только вы измените этот тип`)
  }

  function startNew(fromId) {
    warnStashReplaced()
    const src = fromId ? templates.find(t => t.id === fromId) : null
    setBaseId(fromId ?? null)
    if (!src) {
      setPicked(new Set())
      beginDraft({
        id: '', name: '', family: '', familyLabel: '',
        connection: { slaveId: 1, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', protocol: 'modbus-rtu' },
        groups: [],
        isNew: true,
      })
      return
    }
    setPicked(new Set(src.groups.flatMap(g => g.params.map(p => p.id))))
    beginDraft({
      ...copyTemplate(src),
      id: freeTemplateId(`${src.id}-copy`),
      name: `${src.name ?? src.id} (копия)`,
      isNew: true,
    })
  }

  function startEdit(t) {
    // Незаконченная правка ЭТОГО же типа — продолжаем её, а не начинаем заново
    // с файла: иначе «Изменить» молча выбрасывало бы отложенную работу.
    if (stash && !stash.draft.isNew && stash.draft.id === t.id) { resumeDraft(); return }
    warnStashReplaced()
    setBaseId(null)
    setPicked(new Set())
    // Работаем с копией — «Отмена» не должна оставлять следов
    beginDraft({ ...copyTemplate(t), isNew: false })
  }

  // Оставить в типе только отмеченные параметры основы. Корневые разделы
  // (фото, коды аварий, связь и т.д.) уже перенесены при выборе основы и здесь
  // НЕ перезаписываются — иначе правки пользователя откатывались бы назад.
  // Зато чистим ссылки на выброшенные параметры.
  function applyPicked() {
    if (!base) return
    const groups = base.groups
      .map(g => ({ ...g, params: g.params.filter(p => picked.has(p.id)) }))
      .filter(g => g.params.length > 0)
    if (groups.length === 0) { message.warning('Отметьте хотя бы один параметр'); return }
    setEditing(prev => pruneToParams({ ...prev, groups }))
    message.success(`В типе оставлено ${groups.flatMap(g => g.params).length} параметров из «${base.name}»`)
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

  // ─── Ручное наполнение: группы и параметры ─────────────────────────────────
  // Без этого тип «с нуля» невозможно было сохранить: параметры брались только
  // из типа-основы, а пустой тип бэкенд справедливо отклонял.
  function addGroup() {
    // Номер ищем свободный, а не «сколько групп + 1»: после удаления средней
    // группы такой счётчик выдал бы уже занятый id, и правка одной группы
    // молча меняла бы другую.
    const used = new Set((editing.groups ?? []).map(g => g.id))
    let n = (editing.groups?.length ?? 0) + 1
    while (used.has(`G${n}`)) n++
    const id = `G${n}`
    setEditing(prev => ({
      ...prev,
      groups: [...(prev.groups ?? []), { id, name: `Группа ${n}`, params: [] }],
    }))
    setOpenGroup(id)
    setRenamingGroup(id)
  }

  function patchGroup(groupId, patch) {
    setEditing(prev => ({
      ...prev,
      groups: prev.groups.map(g => g.id === groupId ? { ...g, ...patch } : g),
    }))
  }

  function removeGroup(groupId) {
    setEditing(prev => ({ ...prev, groups: prev.groups.filter(g => g.id !== groupId) }))
  }

  function addParam(groupId) {
    setOpenGroup(groupId)
    setEditing(prev => ({
      ...prev,
      groups: prev.groups.map(g => {
        if (g.id !== groupId) return g
        const n = g.params.length + 1
        return {
          ...g,
          params: [...g.params, {
            id: `${g.id}.${String(n).padStart(2, '0')}`,
            name: 'Новый параметр',
            register: 0,
            access: 'read-write',
            type: 'integer',
          }],
        }
      }),
    }))
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
    // Пустую группу НЕ удаляем: она создаётся вручную и живёт сама по себе —
    // иначе удаление последнего параметра неожиданно сносило бы и саму группу.
    setEditing(prev => ({
      ...prev,
      groups: prev.groups.map(g => g.id !== groupId ? g : { ...g, params: g.params.filter(p => p.id !== paramId) }),
    }))
  }

  async function save() {
    const d = editing
    if (!d.id?.trim()) { message.warning('Укажите идентификатор типа (латиницей, без пробелов)'); return }
    if (!d.name?.trim()) { message.warning('Укажите название типа'); return }
    // Группы теперь могут быть пустыми (создаются вручную), поэтому считаем
    // сами параметры, а не количество групп.
    const filled = (d.groups ?? []).filter(g => g.params?.length > 0)
    if (filled.length === 0) { message.warning('В типе нет ни одного параметра'); return }
    setSaving(true)
    try {
      // Пустые группы в файл не пишем, а заодно чистим ссылки на параметры,
      // которых в типе не осталось: оповещение или команда сброса по чужому
      // paramId — молчаливая ошибка, которая всплывёт уже на объекте.
      const payload = pruneToParams({ ...d, groups: filled })
      delete payload.isNew
      if (d.isNew) await api.post('/devices/templates', payload)
      else await api.put(`/devices/templates/${encodeURIComponent(d.id)}`, payload)
      message.success(`Тип «${d.name}» сохранён`)
      addLog('success', `${d.isNew ? 'Создан' : 'Изменён'} тип ПЧ «${d.name}» (${d.groups.flatMap(g => g.params).length} параметров)`)
      forgetDraft()   // черновик стал типом — держать его дальше незачем
      clearForm()
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

  // ─── Модели и прошивки ─────────────────────────────────────────────────────
  if (extras) {
    return (
      <AppModal
        title={<Space><ApartmentOutlined />Модели и прошивки: {extras.type.name ?? extras.type.id}</Space>}
        open={open}
        onCancel={() => setExtras(null)}
        onEnter={saveExtras}
        width={780}
        footer={[
          ...undoButtons(extrasUndo),
          <Button key="back" onClick={() => setExtras(null)}>Назад к списку</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveExtras}>Сохранить</Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Дополнять можно и штатные типы"
          description="Эти списки хранятся отдельно от файла поставки, поэтому эталонный шаблон остаётся нетронутым, а ваши добавления переживают обновление программы. Модель влияет на подстановку заводских значений, прошивка — на формат некоторых величин (например температуры)."
        />

        <Typography.Text strong style={{ fontSize: 12 }}>Версии прошивки</Typography.Text>
        <div style={{ marginTop: 6, marginBottom: 14 }}>
          <Space wrap style={{ marginBottom: 8 }}>
            <Input
              size="small"
              style={{ width: 200 }}
              placeholder="например v3.0"
              value={newFirmware}
              onChange={e => setNewFirmware(e.target.value)}
              onPressEnter={addFirmware}
            />
            <Button size="small" icon={<PlusOutlined />} onClick={addFirmware}>
              Добавить прошивку
            </Button>
          </Space>
          <div>
            {extras.firmwares.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>Версий пока нет</Typography.Text>
            )}
            {extras.firmwares.map(fw => {
              const builtin = (extras.type.builtinFirmwares ?? []).includes(fw)
              return (
                <Tag
                  key={fw}
                  color={builtin ? 'default' : 'green'}
                  closable={!builtin}
                  onClose={e => { e.preventDefault(); removeFirmware(fw) }}
                  style={{ marginBottom: 4 }}
                >
                  {fw}{builtin && ' · из поставки'}
                </Tag>
              )
            })}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Версии из поставки удалить нельзя — убрать можно только добавленные вами.
          </Typography.Text>
        </div>

        <Space style={{ marginBottom: 8 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>Модель (мощность)</Typography.Text>
          <Button size="small" icon={<PlusOutlined />} onClick={() => setExtras({
            ...extras, models: [...extras.models, { code: '', powerKw: 0, supply: '3~380В' }],
          })}>Добавить модель</Button>
        </Space>
        <Table
          size="small"
          pagination={{ pageSize: 8, size: 'small' }}
          rowKey={(_, i) => i}
          dataSource={extras.models}
          locale={{ emptyText: 'Исполнений пока нет' }}
          columns={[
            {
              title: 'Артикул', render: (_, m, i) => (
                <Input size="small" value={m.code} placeholder="EMD-PUMP-0037 T"
                  onChange={e => setExtras({
                    ...extras,
                    models: extras.models.map((x, j) => j === i ? { ...x, code: e.target.value } : x),
                  })} />
              ),
            },
            {
              title: 'Мощность, кВт', width: 140, render: (_, m, i) => (
                <InputNumber size="small" step={0.1} value={m.powerKw} style={{ width: '100%' }}
                  onChange={v => setExtras({
                    ...extras,
                    models: extras.models.map((x, j) => j === i ? { ...x, powerKw: v } : x),
                  })} />
              ),
            },
            {
              title: 'Питание', width: 130, render: (_, m, i) => (
                <Input size="small" value={m.supply ?? ''} placeholder="3~380В"
                  onChange={e => setExtras({
                    ...extras,
                    models: extras.models.map((x, j) => j === i ? { ...x, supply: e.target.value } : x),
                  })} />
              ),
            },
            {
              title: '', width: 60, render: (_, m, i) => {
                const builtin = (extras.type.builtinModels ?? []).some(b => b.code === m.code)
                return builtin
                  ? <Tooltip title="Модель из поставки — удалить нельзя"><Tag style={{ margin: 0 }}>штат.</Tag></Tooltip>
                  : <Button size="small" type="text" danger icon={<DeleteOutlined />}
                      onClick={() => setExtras({ ...extras, models: extras.models.filter((_, j) => j !== i) })} />
              },
            },
          ]}
        />
      </AppModal>
    )
  }

  // ─── Список типов ──────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <AppModal
        title={<Space><ApartmentOutlined />Типы ПЧ</Space>}
        open={open}
        onCancel={onClose}
        onEnter={onClose}
        width={820}
        footer={[
          // Пока есть отложенный тип, эта кнопка возвращает к нему, а не
          // открывает пустую форму: забытое «Сохранить» не должно означать
          // «начинай заново». Начать с чистого листа — из панели черновика.
          stash
            ? <Button key="new" icon={<EditOutlined />} onClick={resumeDraft}>Продолжить черновик</Button>
            : <Button key="new" icon={<PlusOutlined />} onClick={() => startNew(null)}>Создать с нуля</Button>,
          <Button key="close" type="primary" onClick={onClose}>Закрыть</Button>,
        ]}
      >
        {stash && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`Незаконченный тип: ${stash.draft.name || stash.draft.id || 'без названия'}`}
            description={(
              <>
                Групп: {draftSize(stash.draft).groups}, параметров: {draftSize(stash.draft).params}.
                Отложен {new Date(stash.savedAt).toLocaleString('ru-RU')} — переживает закрытие окна и
                перезапуск программы. Исчезнет, когда вы сохраните тип или удалите черновик.
              </>
            )}
            action={(
              <Space direction="vertical" size={4}>
                <Button size="small" type="primary" onClick={resumeDraft}>Продолжить</Button>
                <Popconfirm
                  title="Удалить черновик?"
                  description="Заполненные поля, созданные группы и параметры будут потеряны безвозвратно."
                  okText="Удалить" cancelText="Отмена" okButtonProps={{ danger: true }}
                  onConfirm={() => { forgetDraft(); message.success('Черновик удалён') }}
                >
                  <Button size="small" danger>Удалить</Button>
                </Popconfirm>
              </Space>
            )}
          />
        )}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Свои типы ПЧ можно создавать прямо здесь"
          description="Типы из поставки менять нельзя — возьмите такой за основу, отберите нужные группы и параметры и сохраните под своим именем. Файл появится в папке devices/templates и подхватится сразу, переустановка не нужна."
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
                    ? <Tag color="green">личный</Tag>
                    : <Tag>из поставки</Tag>}
                  <div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{t.id}</Typography.Text></div>
                </span>
              ),
            },
            { title: 'Групп', width: 70, render: (_, t) => t.groups?.length ?? 0 },
            { title: 'Параметров', width: 100, render: (_, t) => (t.groups ?? []).flatMap(g => g.params).length },
            {
              title: '', width: 250, render: (_, t) => (
                <Space size={4}>
                  <Tooltip title="Каталог исполнений и версии прошивки — можно дополнять и у штатных типов">
                    <Button size="small" onClick={() => startExtras(t)}>Модели</Button>
                  </Tooltip>
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
      </AppModal>
    )
  }

  // ─── Форма создания/правки ─────────────────────────────────────────────────
  const draftParams = editing.groups.flatMap(g => g.params.map(p => ({ ...p, __group: g.id, __groupName: g.name })))

  return (
    <AppModal
      title={<Space><ApartmentOutlined />{editing.isNew ? 'Новый тип ПЧ' : `Правка типа: ${editing.name}`}</Space>}
      open={open}
      onCancel={leaveDraft}
      onEnter={save}
      width={1100}
      footer={[
        ...undoButtons(draftUndo),
        <Tooltip key="back" title="Незаписанный тип не пропадёт: он отложится и будет ждать в списке типов">
          <Button onClick={leaveDraft}>Назад к списку</Button>
        </Tooltip>,
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
      <Input
        addonBefore="Описание"
        placeholder="Преобразователь частоты ..."
        value={editing.description ?? ""}
        onChange={e => setEditing({ ...editing, description: e.target.value })}
        style={{ width: "100%", marginBottom: 8 }}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -4 }}>
        Идентификатор — латиницей, без пробелов, он же имя файла и его нельзя поменять позже.
        Семейство определяет, с какими типами разрешены групповые операции: у одного семейства
        должна быть совместимая карта регистров.
      </Typography.Paragraph>

      {/* Остальные разделы JSON-типа: фотографии, связь, коды аварий,
          оповещения, команда сброса. Свёрнуты, чтобы не заслонять параметры. */}
      <TemplateExtras draft={editing} onChange={setEditing} />

      {editing.isNew && base && (
        <>
          <Divider orientation="left" style={{ margin: '8px 0' }}>
            Что взять из «{base.name}»
          </Divider>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Тип уже скопирован целиком — все параметры отмечены. Снимите лишние и нажмите
            «Применить отбор», чтобы оставить в своём типе только нужное. Оповещения и команда
            сброса, ссылавшиеся на убранные параметры, при этом тоже убираются.
          </Typography.Paragraph>
          <Space style={{ marginBottom: 8 }} wrap>
            <Button size="small" onClick={() => setPicked(new Set(base.groups.flatMap(g => g.params.map(p => p.id))))}>
              Отметить всё
            </Button>
            <Button size="small" onClick={() => setPicked(new Set())}>Снять всё</Button>
            <Button size="small" type="primary" onClick={applyPicked}>
              Применить отбор ({picked.size})
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
      <Space wrap style={{ marginBottom: 8 }}>
        <Tooltip title="Создать новую группу параметров">
          <Button size="small" icon={<PlusOutlined />} onClick={addGroup}>Создать группу</Button>
        </Tooltip>
      </Space>
      {editing.groups.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          message="Параметров пока нет"
          description={editing.isNew && base
            ? 'Отметьте нужные выше и нажмите «Применить отбор».'
            : 'Нажмите «Создать группу», затем «+» на её заголовке — и заполните параметры. Либо вернитесь в список и создайте тип на основе имеющегося: так карта регистров получится готовой.'}
        />
      ) : (
        // Гармошка по группам: открыта всегда одна — так карта регистров даже
        // на сотню параметров остаётся обозримой. Плоская таблица со столбцом
        // «Группа» этого не давала.
        <Collapse
          accordion
          size="small"
          activeKey={openGroup ? [openGroup] : []}
          onChange={k => setOpenGroup(Array.isArray(k) ? (k[0] ?? null) : (k ?? null))}
          items={editing.groups.map(g => ({
            key: g.id,
            label: (
              <div
                onMouseEnter={() => setHoverGroup(g.id)}
                onMouseLeave={() => setHoverGroup(null)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}
              >
                {renamingGroup === g.id ? (
                  <Input
                    size="small"
                    autoFocus
                    value={g.name}
                    style={{ width: 240 }}
                    onClick={e => e.stopPropagation()}
                    onChange={e => patchGroup(g.id, { name: e.target.value })}
                    onPressEnter={() => setRenamingGroup(null)}
                    onBlur={() => setRenamingGroup(null)}
                  />
                ) : (
                  <span style={{ fontWeight: 500 }}>{g.name}</span>
                )}
                <Tag style={{ margin: 0 }}>{g.params.length}</Tag>
                {/* visibility, а не условный рендер: место под кнопки
                    зарезервировано, поэтому заголовок не «дёргается». */}
                <span
                  style={{ marginLeft: 'auto', visibility: hoverGroup === g.id ? 'visible' : 'hidden' }}
                  onClick={e => e.stopPropagation()}
                >
                  <Space size={2}>
                    <Tooltip title="Добавить параметр в эту группу">
                      <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => addParam(g.id)} />
                    </Tooltip>
                    <Tooltip title="Переименовать группу">
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setRenamingGroup(g.id)} />
                    </Tooltip>
                    <Popconfirm
                      title="Удалить группу?"
                      description={g.params.length > 0 ? `Вместе с ней исчезнут ${g.params.length} параметров.` : 'Группа пустая.'}
                      okText="Удалить" cancelText="Отмена" okButtonProps={{ danger: true }}
                      onConfirm={() => removeGroup(g.id)}
                    >
                      <Tooltip title="Удалить группу целиком">
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                      </Tooltip>
                    </Popconfirm>
                  </Space>
                </span>
              </div>
            ),
            children: g.params.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Группа пустая — нажмите «+» в её заголовке, чтобы добавить параметр.
              </Typography.Text>
            ) : (
              <Table
                size="small"
                pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }}
                rowKey={r => `${r.__group}:${r.id}`}
                dataSource={g.params.map(p => ({ ...p, __group: g.id }))}
                columns={[
                  {
              title: 'Код', width: 100,
              render: (_, r) => (
                <Input size="small" value={r.id}
                  onChange={e => patchParam(r.__group, r.id, { id: e.target.value })} />
              ),
            },
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
              title: 'Варианты', width: 110,
              render: (_, r) => r.type !== 'enum' ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>—</Typography.Text> : (
                <Button size="small" onClick={() => setOptionsEditor({ groupId: r.__group, paramId: r.id, list: normalizeOptions(r.options) })}>
                  {normalizeOptions(r.options).length || 0} шт.
                </Button>
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
            ),
          }))}
        />
      )}

      {/* Варианты значения для «Перечисления»: пары «число -> подпись». Именно
          так они хранятся в наших шаблонах (пуск/стоп/вперёд/назад и т.п.). */}
      <AppModal
        title="Варианты значения"
        open={!!optionsEditor}
        onCancel={() => setOptionsEditor(null)}
        onOk={() => {
          const list = optionsEditor.list.filter(o => String(o.label ?? '').trim() !== '')
          patchParam(optionsEditor.groupId, optionsEditor.paramId, { options: list })
          setOptionsEditor(null)
        }}
        okText="Применить"
        cancelText="Отмена"
        width={520}
      >
        <Space style={{ marginBottom: 8 }}>
          <Button size="small" icon={<PlusOutlined />} onClick={() => setOptionsEditor({
            ...optionsEditor,
            list: [...optionsEditor.list, { value: optionsEditor.list.length, label: '' }],
          })}>Добавить вариант</Button>
        </Space>
        <Table
          size="small"
          pagination={false}
          rowKey={(_, i) => i}
          dataSource={optionsEditor?.list ?? []}
          locale={{ emptyText: 'Вариантов пока нет' }}
          columns={[
            {
              title: 'Значение', width: 110, render: (_, o, i) => (
                <InputNumber size="small" value={o.value} style={{ width: '100%' }}
                  onChange={v => setOptionsEditor({
                    ...optionsEditor,
                    list: optionsEditor.list.map((x, j) => j === i ? { ...x, value: v } : x),
                  })} />
              ),
            },
            {
              title: 'Подпись', render: (_, o, i) => (
                <Input size="small" value={o.label} placeholder="например: ПУСК"
                  onChange={e => setOptionsEditor({
                    ...optionsEditor,
                    list: optionsEditor.list.map((x, j) => j === i ? { ...x, label: e.target.value } : x),
                  })} />
              ),
            },
            {
              title: '', width: 40, render: (_, __, i) => (
                <Button size="small" type="text" danger icon={<DeleteOutlined />}
                  onClick={() => setOptionsEditor({
                    ...optionsEditor, list: optionsEditor.list.filter((_, j) => j !== i),
                  })} />
              ),
            },
          ]}
        />
      </AppModal>
    </AppModal>
  )
}
