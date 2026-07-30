import { useState, useRef } from 'react'
import {
  Typography, Badge, Avatar, Tag, Button, Form, Input, InputNumber, Select, Popconfirm, Tooltip, Checkbox, Space, message,
} from 'antd'
import AppModal from './AppModal'
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
import { ALL_DEVICES } from './ParamGroups'

import { deviceFamily as deviceType, familyLabel } from '../family'

function SortableDeviceRow({ id, compact, mirrored, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, position: 'relative' }}
    >
      {!compact && (
        // На правой стороне экрана точки перетаскивания переезжают к правому
        // краю строки (зеркально левому варианту).
        <div
          {...attributes}
          {...listeners}
          title="Перетащить — изменить порядок"
          style={{
            position: 'absolute', [mirrored ? 'right' : 'left']: 2, top: 0, bottom: 0, width: 14,
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

export default function DeviceList({ devices, selectedIds, onSelectionChange, connected, liveness = {}, hasProject, activeProjectId, sidebarWidth = 270, deviceOrder, onDeviceOrderChange, focusedDeviceId, onFocusDevice, mirrored = false, locked = false, lockLabel = '', templateErrors = [] }) {
  const [addOpen, setAddOpen]       = useState(false)
  const [editDevice, setEditDevice] = useState(null)
  const [templates, setTemplates]   = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [addForm]                   = Form.useForm()
  const [editForm]                  = Form.useForm()
  // null = «показаны все» (в т.ч. семейства, появившиеся после создания типа)
  const [visibleTypes, setVisibleTypes] = useState(null)
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
    // Список типов нужен и здесь — тип можно сменить (например добавили свой
    // шаблон в папку devices/templates рядом с приложением)
    api.get("/devices/templates").then(({ data }) => setTemplates(data)).catch(() => {})
    editForm.setFieldsValue({
      name:    device.name,
      slaveId: device.connection.slaveId,
      model:   device.model,
      firmware: device.firmware,
      templateId: device.templateId,
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
  // Пока идёт длительная операция, список ПЧ заблокирован. Молча игнорировать
  // клик нельзя — выглядит как «подвисло»; поэтому объясняем, что происходит.
  function warnLocked() {
    message.warning(`Идёт ${lockLabel || 'операция'} — дождитесь завершения или нажмите «Остановить»`)
  }

  function toggleSelection(device) {
    if (locked) { warnLocked(); return }
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
    if (locked) { warnLocked(); return } // идёт операция — не сбиваем текущий просмотр
    // Просмотр ПЧ не меняет состав группы: галочки остаются как были, даже если
    // просматриваемый ПЧ в группу не входит.
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
    setVisibleTypes(checked ? null : new Set())
    if (!checked && selectedIds.size > 0) {
      onSelectionChange(new Set())
    }
  }

  // Клик по названию типа — «показать только его»: остальные типы снимаются,
  // а выделение с их устройств убирается (иначе в группе остались бы невидимые
  // сейчас ПЧ, что потом путает в групповых операциях).
  function showOnlyType(type) {
    setVisibleTypes(new Set([type]))
    const hiddenIds = new Set(allDevices.filter(d => deviceType(d) !== type).map(d => d.id))
    if ([...selectedIds].some(id => hiddenIds.has(id))) {
      onSelectionChange(new Set([...selectedIds].filter(id => !hiddenIds.has(id))))
    }
  }

  function toggleType(type, checked) {
    // Важно: onSelectionChange (setState родителя App) вызывается ЗДЕСЬ, в теле
    // обработчика, а не внутри апдейтера setVisibleTypes — вызов чужого setState
    // из апдейтера нарушает правила React ("Cannot update a component while
    // rendering a different component") и реально ронял приложение.
    // из «показаны все» разворачиваем в явный список, иначе снятие одной
    // галочки не с чего было бы вычитать
    const next = new Set(visibleTypes ?? families.map(f => f.id))
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
  // Семейства собираем по фактическим устройствам проекта: их может быть больше
  // двух, если созданы свои типы ПЧ.
  const families = []
  for (const d of allDevices) {
    const f = deviceType(d)
    if (!families.some(x => x.id === f)) families.push({ id: f, label: familyLabel(d) })
  }
  families.sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  // visibleTypes === null означает «показаны все» — так новое семейство,
  // появившееся после создания типа, не оказывается скрытым по умолчанию.
  const isFamilyVisible = f => visibleTypes === null || visibleTypes.has(f)
  const allFamiliesVisible = visibleTypes === null || families.every(f => visibleTypes.has(f.id))
  const visibleDevices = allDevices.filter(d => isFamilyVisible(deviceType(d)))
  // ПЧ без указанной модели — только те, у чьей модели вообще есть каталог
  // исполнений (иначе указывать нечего).
  const devicesWithoutModel = allDevices.filter(d => !d.model && (d.models?.length ?? 0) > 0)
  // То же для прошивки: от неё зависит формат некоторых значений (температура),
  // поэтому неуказанная версия — не мелочь.
  const devicesWithoutFirmware = allDevices.filter(d => !d.firmware && (d.firmwares?.length ?? 0) > 0)

  function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = visibleDevices.findIndex(d => d.id === active.id)
    const newIndex = visibleDevices.findIndex(d => d.id === over.id)
    const newVisibleOrder = arrayMove(visibleDevices, oldIndex, newIndex).map(d => d.id)
    // Устройства, скрытые сейчас фильтром типа, не участвовали в перетаскивании —
    // сохраняем их в конце в прежнем относительном порядке.
    const hiddenIds = allDevices.filter(d => !isFamilyVisible(deviceType(d))).map(d => d.id)
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

  // Порядок «жертв» при сжатии сайдбара — от наименее важного к самому важному.
  // Галочка (в группе/нет) и адрес ПЧ нужны всегда, поэтому уходят последними:
  //   <180  — прячем метку модели (Pump/VL)
  //   <150  — прячем название устройства (обычно самое длинное)
  //   <110  — прячем фото
  //    <76  — от «Адрес N» оставляем только номер
  // Уже галочки+номера панель не сжимается (SIDER_MIN_WIDTH в App.jsx).
  const showModelLabel = sidebarWidth >= 180
  const showName       = sidebarWidth >= 150
  // Промежуточная ступень перед полным скрытием имени: убираем приставку
  // «EMD-» («EMD-PUMP-1» -> «PUMP-1») — она одинаковая у всех и места занимает
  // больше всего.
  const shortenName    = sidebarWidth < 210
  const showAvatar     = sidebarWidth >= 110
  const showAddrWord   = sidebarWidth >= 76
  // Кнопки правки/удаления требуют места и появляются только в полном виде.
  const showRowActions = sidebarWidth >= 180
  const compact = !showAvatar && !showName
  const avatarSize = showName ? (showModelLabel ? 44 : 32) : 32
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

      {/* Модель (мощность) по шине не определяется — её задают вручную. Пока
          хотя бы у одного ПЧ она не указана, заводские значения для таких
          параметров подставить нельзя, поэтому коротко предупреждаем. */}
      {/* Битый файл шаблона раньше отбрасывался молча — и новый тип ПЧ просто
          не появлялся в списке без объяснения причин. */}
      {!compact && templateErrors.length > 0 && (
        <div style={{
          margin: '0 16px 8px', padding: '4px 8px', borderRadius: 4,
          background: '#fff2f0', border: '1px solid #ffccc7',
        }}>
          <Tooltip title={
            <>
              {templateErrors.map(e => (
                <div key={e.file} style={{ marginBottom: 4 }}><b>{e.file}</b>: {e.message}</div>
              ))}
              Исправьте файл в папке devices/templates — он перечитается автоматически.
            </>
          }>
            <Typography.Text style={{ fontSize: 11, color: '#cf1322', cursor: 'help' }}>
              ⛔ Не удалось прочитать файл шаблона ({templateErrors.length}) — тип ПЧ не появится в списке
            </Typography.Text>
          </Tooltip>
        </div>
      )}

      {hasProject && !compact && (devicesWithoutModel.length > 0 || devicesWithoutFirmware.length > 0) && (
        <div style={{
          margin: '0 16px 8px', padding: '4px 8px', borderRadius: 4,
          background: '#fffbe6', border: '1px solid #ffe58f',
        }}>
          <Tooltip title={
            <>
              {devicesWithoutModel.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <b>Без модели:</b> {devicesWithoutModel.map(d => d.name).join(', ')}.
                  {' '}Без неё нельзя подставить заводские значения параметров, зависящих от мощности.
                </div>
              )}
              {devicesWithoutFirmware.length > 0 && (
                <div>
                  <b>Без прошивки:</b> {devicesWithoutFirmware.map(d => d.name).join(', ')}.
                  {' '}От версии зависит формат значений — например температура: v2.0 отдаёт десятые доли
                  (380 = 38.0 °C), v1.2 целые градусы. Без указания версия не подставляется, и температура
                  может читаться в 10 раз больше.
                </div>
              )}
              {' '}Откройте карточку ПЧ (кнопка «Изменить») и заполните поля.
            </>
          }>
            <Typography.Text style={{ fontSize: 11, color: '#ad6800', cursor: 'help' }}>
              ⚠ Не указано{devicesWithoutModel.length > 0 ? ` — модель: ${devicesWithoutModel.length}` : ''}
              {devicesWithoutFirmware.length > 0 ? `${devicesWithoutModel.length > 0 ? ',' : ' —'} прошивка: ${devicesWithoutFirmware.length}` : ''}
              {' '}ПЧ, задайте вручную
            </Typography.Text>
          </Tooltip>
        </div>
      )}

      {hasProject && allDevices.length > 0 && !compact && (
        <div style={{ padding: '0 16px 8px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {/* Фильтр семейств. До 6 семейств — привычные чекбоксы (клик по
                квадратику включает/выключает, клик по названию оставляет только
                его). Больше 6 — список превращается в выпадающее меню, иначе
                колонка фильтров занимала бы весь сайдбар. */}
            {families.length <= 6 ? (
              <Space direction="vertical" size={4}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Checkbox
                    checked={allFamiliesVisible}
                    indeterminate={!allFamiliesVisible && visibleTypes !== null && visibleTypes.size > 0}
                    onChange={e => setAllTypesVisible(e.target.checked)}
                  />
                  <span
                    onClick={() => setAllTypesVisible(!allFamiliesVisible)}
                    style={{ fontSize: 12, cursor: 'pointer' }}
                    title={allFamiliesVisible ? 'Снять все' : 'Показать все типы'}
                  >
                    Все
                  </span>
                </span>
                {families.map(f => (
                  <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Checkbox
                      checked={isFamilyVisible(f.id)}
                      onChange={e => toggleType(f.id, e.target.checked)}
                    />
                    <span
                      onClick={() => showOnlyType(f.id)}
                      style={{ fontSize: 12, cursor: 'pointer' }}
                      title={`Показать только ${f.label}`}
                    >
                      {f.label}
                    </span>
                  </span>
                ))}
              </Space>
            ) : (
              <Select
                mode="multiple"
                size="small"
                style={{ minWidth: 160, maxWidth: 220 }}
                placeholder="Типы ПЧ"
                value={families.filter(f => isFamilyVisible(f.id)).map(f => f.id)}
                onChange={vals => setVisibleTypes(new Set(vals))}
                maxTagCount={1}
                maxTagPlaceholder={omitted => `+${omitted.length}`}
                options={families.map(f => ({ value: f.id, label: f.label }))}
              />
            )
            }
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
            </Space>
          </div>

          {/* Удаление ПЧ вынесено ОТДЕЛЬНОЙ строкой под фильтрами и никогда не
              появляется прямо под кнопкой «Выбрать все»: на медленной машине
              кнопка срабатывала с задержкой, пользователь жал повторно — и
              вторым кликом попадал уже по возникшей на этом месте «Удалить».
              Здесь она в другом ряду, с отступом и подтверждением. */}
          {selectedIds.size > 0 && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #f0f0f0', display: 'flex', justifyContent: 'flex-start' }}>
              <Popconfirm
                title="Удалить выбранные устройства?"
                description={`Будет удалено устройств: ${selectedIds.size}. Файлы конфигов удаляются безвозвратно.`}
                okText="Удалить"
                cancelText="Отмена"
                okButtonProps={{ danger: true }}
                onConfirm={handleBulkDelete}
              >
                <Button size="small" danger type="text" icon={<DeleteOutlined />}>
                  Удалить выбранные ({selectedIds.size})
                </Button>
              </Popconfirm>
            </div>
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleDevices.map(d => d.id)} strategy={verticalListSortingStrategy}>
            {visibleDevices.map(device => {
              const isSelected = selectedIds.has(device.id)
              // Членство в группе (галочка) и «сейчас просматривается» — два
              // независимых состояния. Группу показывает ТОЛЬКО галочка, без
              // подсветки строки; подсвечивается лишь просматриваемый ПЧ (он
              // может быть и вне группы). В режиме «Все выбранные ПЧ — править
              // разом» (ALL_DEVICES) просматриваются сразу все отмеченные.
              const isFocused = focusedDeviceId === device.id ||
                (focusedDeviceId === ALL_DEVICES && isSelected && selectedIds.size > 1)
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

              // На правой стороне экрана строка зеркалится целиком: порядок
              // элементов (точки → текст, картинка, галочка при row-reverse —
              // main-start у row-reverse это правый край, поэтому justifyContent
              // flex-start сам прижимает группу к правому краю без доп. правок),
              // отступы под точки/кнопки редактирования и цветная полоска
              // выделения — всё меняется местами.
              const rowPadding = compact ? '8px 4px' : (mirrored ? '8px 20px 8px 12px' : '8px 12px 8px 20px')
              const accentSide = mirrored ? 'borderRight' : 'borderLeft'
              const accentColor = isFocused ? '3px solid #1677ff' : '3px solid transparent'

              return (
                <SortableDeviceRow key={device.id} id={device.id} compact={compact} mirrored={mirrored}>
                  <Tooltip title={compact ? `${device.name} · ${modelLabel} · Адрес ${device.connection.slaveId ?? 1}` : ''} placement={mirrored ? 'left' : 'right'}>
                    <div
                      onClick={() => handleRowClick(device)}
                      onDoubleClick={() => handleRowDoubleClick(device)}
                      className={isFocused ? 'device-row device-row-focused' : 'device-row'}
                      style={{
                        position: 'relative',
                        cursor: 'pointer',
                        padding: rowPadding,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: compact ? 'center' : 'flex-start',
                        flexDirection: mirrored ? 'row-reverse' : 'row',
                        gap: 8,
                        background: isFocused ? '#bae0ff' : 'transparent',
                        [accentSide]: accentColor,
                        borderBottom: '1px solid #f5f5f5',
                        // Во время операции строки заметно тускнеют — сразу
                        // видно, что список сейчас недоступен, а не «подвис».
                        opacity: locked ? 0.45 : 1,
                        filter: locked ? 'grayscale(0.7)' : 'none',
                        transition: 'opacity 0.15s, filter 0.15s',
                      }}
                    >
                      {/* Галочка (членство в группе) не прячется никогда — вместе
                          с адресом это последнее, что остаётся при сжатии. */}
                      <span
                        onClick={e => e.stopPropagation()}
                        onDoubleClick={e => e.stopPropagation()}
                        style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 6px', margin: '-4px 0', flexShrink: 0 }}
                        title="Добавить/убрать из группового выбора"
                      >
                        <Checkbox
                          checked={isSelected}
                          onChange={() => toggleSelection(device)}
                          style={{ transform: 'scale(1.35)' }}
                        />
                      </span>

                      {showAvatar && avatar}

                      {/* Текстовый блок. Слева flex:1 (растёт от нуля) тянет его
                          на всю оставшуюся ширину — текст идёт сразу после
                          картинки. В зеркальном виде текст стоит ДО картинки, и
                          такая растяжка отодвинула бы его к дальнему краю; там
                          flex:'0 1 auto' + minWidth держит блок вплотную к
                          картинке, а фиксированная minWidth выравнивает начало
                          строк у разных моделей (EMD-PUMP-1 длиннее EMD-VL-2 —
                          без неё текст начинался бы с разных позиций). */}
                      <div style={{
                        flex: mirrored ? '0 1 auto' : 1,
                        minWidth: mirrored ? 112 : 0,
                        textAlign: 'left',
                      }}>
                        {showName && (
                          <div style={{
                            fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            // Резерв под кнопки правки/удаления нужен только там,
                            // где текст реально дотягивается до их угла.
                            paddingRight: (!mirrored && showRowActions) ? 48 : 0,
                          }}>
                            {shortenName ? device.name.replace(/^EMD[-\s]?/i, '') : device.name}
                          </div>
                        )}
                        <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                          <Tag style={{ fontSize: 11, padding: '0 4px', margin: 0 }}>
                            {showAddrWord ? `Адрес ${device.connection.slaveId ?? 1}` : (device.connection.slaveId ?? 1)}
                          </Tag>
                          {showModelLabel && (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              {modelLabel}
                              {/* Исполнение (мощность), если указано в карточке ПЧ */}
                              {device.model && (
                                <> · {(device.models ?? []).find(m => m.code === device.model)?.powerKw ?? ''} кВт</>
                              )}
                            </Typography.Text>
                          )}
                        </span>
                      </div>

                      {showRowActions && (
                        <div
                          onClick={e => e.stopPropagation()}
                          className="device-row-actions"
                          style={{ position: 'absolute', top: 4, [mirrored ? 'left' : 'right']: 4, display: 'flex', gap: 2, background: isFocused ? '#bae0ff' : '#fff' }}
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
      <AppModal
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
      </AppModal>

      {/* Модалка редактирования */}
      <AppModal
        title={`Редактировать: ${editDevice?.name}`}
        open={!!editDevice}
        onCancel={() => setEditDevice(null)}
        onOk={() => editForm.submit()}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={submitting}
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit} style={{ marginTop: 16 }}>
          <Form.Item
            name="templateId"
            label="Тип устройства (шаблон)"
            extra="Список берётся из папки devices/templates рядом с приложением — новые файлы подхватываются на лету, пересобирать программу не нужно. При смене типа модель, прошивка, подготовленные и считанные значения сбрасываются: у другого типа своя карта регистров."
          >
            <Select showSearch optionFilterProp="label" options={templates.map(t => ({ value: t.id, label: t.name ?? t.id }))} />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Введите название' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="slaveId" label="Адрес ПЧ (Slave ID на шине)" rules={[{ required: true, message: 'Введите адрес ПЧ' }]}>
            <InputNumber min={1} max={247} style={{ width: '100%' }} />
          </Form.Item>
          {/* Исполнение выбирается вручную: по шине его не определить — ELHART
              не поддерживает Modbus-функцию идентификации устройства. */}
          <Form.Item
            name="model"
            label="Модель (мощность)"
            extra="Определить по шине нельзя — выберите по шильдику устройства. Влияет на подсказки о диапазонах значений."
          >
            <Select
              allowClear
              showSearch
              placeholder="Не указано"
              optionFilterProp="label"
              options={(editDevice?.models ?? []).map(m => ({
                value: m.code,
                label: `${m.code} — ${m.powerKw} кВт${m.supply ? ` · ${m.supply}` : ''}`,
              }))}
            />
          </Form.Item>
          {(editDevice?.firmwares?.length ?? 0) > 0 && (
            <Form.Item
              name="firmware"
              label="Прошивка"
              extra="Версии отличаются набором параметров и форматом значений (например температура: v2.0 отдаёт десятые доли, v1.2 — целые градусы). Смотрите на пульте ПЧ."
            >
              <Select
                allowClear
                placeholder="Не указана"
                options={(editDevice?.firmwares ?? []).map(v => ({ value: v, label: v }))}
              />
            </Form.Item>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Скорость, чётность, биты данных и стоп-биты — общие настройки порта для всей шины
            (не у каждого устройства свои), их можно изменить в панели «Подключение» в шапке приложения.
          </Typography.Text>
        </Form>
      </AppModal>
    </>
  )
}
