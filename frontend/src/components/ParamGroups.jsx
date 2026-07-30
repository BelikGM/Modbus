import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Collapse, Button, Input, message, Typography, Popconfirm, Space, Checkbox, Progress, Select, Tag, Tooltip, Table, Alert,
} from 'antd'
import AppModal from './AppModal'
import { DownloadOutlined, SearchOutlined, RollbackOutlined, HolderOutlined, UploadOutlined, FileTextOutlined, ToolOutlined } from '@ant-design/icons'
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
import ParamRow from './ParamRow'
import api from '../api'
import socket from '../socket'
import { useDeviceSettings } from '../useDeviceSettings'
import { isParamWritable } from '../access'
import { downloadCsv, groupFileLabel } from '../csv'
import { processStart, processUpdate, processDone, processInfo } from '../notify'
import { addLog } from '../log'
import OverwriteGuard, { collectOverwriteConflicts } from './OverwriteGuard'
import { deviceFamily } from '../family'

// Значение/запись специально не растянуты "с запасом" — короткие значения
// (типично "—" пока не считано, или пара символов/цифр) не должны тянуть за
// собой пустое место и толкать последующие колонки за край экрана. При
// необходимости колонку всегда можно расширить вручную (перетаскиванием).
const DEFAULT_COLS = { id: 90, desc: 220, def: 110, cur: 110, write: 220 }
const MIN_COLS     = { id: 60, desc: 100, def: 70,  cur: 80,  write: 160 }

// Спец-значение переключателя «текущее устройство для правки» — режим «Все
// выбранные ПЧ», правки применяются сразу ко всем. Экспортируется, чтобы
// DeviceList (сайдбар) мог распознать этот же маркер в focusedDeviceId и
// подсветить ВСЕ выбранные строки, а не одну — иначе при переходе в этот режим
// в сайдбаре продолжал ярко гореть тот ПЧ, что был активен раньше.
export const ALL_DEVICES = '__all__'

function SortableCollapseItem({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: 'relative',
      }}
    >
      <div
        {...attributes}
        {...listeners}
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'grab', zIndex: 2, color: '#bbb',
        }}
        title="Перетащить группу"
      >
        <HolderOutlined style={{ fontSize: 12 }} />
      </div>
      {children}
    </div>
  )
}

function HeaderCell({ label, width, onResizeStart, marginLeft, divider = true }) {
  return (
    <div style={{
      position: 'relative', width, flexShrink: 0, paddingRight: 10, paddingLeft: 4,
      boxSizing: 'border-box', marginLeft,
      borderRight: divider ? '1px solid rgba(120,120,120,0.2)' : 'none',
    }}>
      <Typography.Text style={{
        fontSize: 11, color: '#888', fontWeight: 600, userSelect: 'none',
        display: 'block', textAlign: 'center', lineHeight: 1.3,
      }}>
        {label}
      </Typography.Text>
      <div
        onMouseDown={onResizeStart}
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 5,
          cursor: 'col-resize',
          borderRight: '2px solid transparent',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderRightColor = '#1677ff' }}
        onMouseLeave={e => { e.currentTarget.style.borderRightColor = 'transparent' }}
      />
    </div>
  )
}

function ParamTableHeader({ cols, onResizeStart }) {
  return (
    <div className="param-table-header" style={{
      display: 'flex', alignItems: 'center',
      padding: '6px 4px',
      minHeight: 40,
      background: '#fafafa',
      borderBottom: '2px solid #e8e8e8',
      borderTop: '1px solid #e8e8e8',
      position: 'sticky', top: 0, zIndex: 1,
    }}>
      <HeaderCell label="Параметр / Адрес"      width={cols.id}    onResizeStart={onResizeStart('id')} />
      <HeaderCell label="Описание параметра"     width={cols.desc}  onResizeStart={onResizeStart('desc')} />
      <HeaderCell label="Заводское значение"     width={cols.def}   onResizeStart={onResizeStart('def')} />
      <HeaderCell label="Значение на устройстве" width={cols.cur}   onResizeStart={onResizeStart('cur')} marginLeft={20} />
      <HeaderCell label="Значение для записи"    width={cols.write} onResizeStart={onResizeStart('write')} marginLeft={20} divider={false} />
    </div>
  )
}

export default function ParamGroups({
  device, devices, modbusConnected, deviceRunning, onWrite,
  visibleGroupIds: controlledVisibleGroupIds, onVisibleGroupIdsChange,
  focusedDeviceId, onFocusDevice,
  // Просматриваемый ПЧ может быть ВНЕ группы (галочками отмечены одни, а
  // одиночным кликом смотрим другой) — тогда его показываем в переключателе
  // отдельным пунктом, а групповые операции блокируем.
  focusedDevice,
  // false — просматриваемый ПЧ не входит в группу (не отмечен галочкой):
  // массовые операции по группе к нему не относятся и блокируются.
  groupOpsEnabled = true,
  // Смешанный выбор Pump+VL: список ПЧ для переключателя. Работаем всегда с
  // ОДНИМ устройством (пункта «все разом» нет — карты регистров разные),
  // но переключаться между ними можно прямо здесь.
  mixedSelectable,
}) {
  const outOfGroupHint = 'ПЧ не отмечен галочкой — групповые операции недоступны'
  // В одиночном режиме (DeviceDetail) `devices` не передаётся — работаем с одним
  // `device`. В групповом (BulkPanel) `devices` — полный список выбранных ПЧ
  // одного семейства; `device` при этом — "эталон" с самой полной картой
  // регистров (для отображения групп/параметров), а подготовленные значения у
  // каждого устройства свои — редактируются по одному через переключатель ниже.
  const effectiveDevices = devices ?? [device]
  const effectiveDeviceIds = effectiveDevices.map(d => d.id)
  const isBulk = effectiveDevices.length > 1
  const [activeDeviceId, setActiveDeviceId] = useState(effectiveDeviceIds[0])
  const isAllMode = isBulk && activeDeviceId === ALL_DEVICES
  // Просматриваемый ПЧ вне группы — его тоже можно выбрать в переключателе
  // (пункт помечен «вне группы»), но групповые кнопки при этом заблокированы.
  const outsideDevice = focusedDevice && !effectiveDeviceIds.includes(focusedDevice.id) ? focusedDevice : null
  const selectableDevices = outsideDevice ? [...effectiveDevices, outsideDevice] : effectiveDevices
  useEffect(() => {
    if (activeDeviceId !== ALL_DEVICES && !selectableDevices.some(d => d.id === activeDeviceId)) {
      setActiveDeviceId(effectiveDeviceIds[0])
    }
    setBulkResults({}) // сменился состав выборки — старые групповые результаты не актуальны
  }, [effectiveDeviceIds.join(',')])

  // Клик по строке в сайдбаре делает ПЧ активным — переключатель ниже следует
  // за ним (и наоборот: выбор в переключателе подсвечивает строку слева).
  useEffect(() => {
    if (focusedDeviceId && focusedDeviceId !== activeDeviceId &&
        (focusedDeviceId === ALL_DEVICES || selectableDevices.some(d => d.id === focusedDeviceId))) {
      setActiveDeviceId(focusedDeviceId)
    }
  }, [focusedDeviceId, outsideDevice?.id])

  function changeActiveDevice(id) {
    setActiveDeviceId(id)
    // Прокидываем и ALL_DEVICES — DeviceList распознаёт этот маркер и
    // подсвечивает ВСЕ выбранные строки, а не гасит подсветку/оставляет
    // старую от ранее активного устройства.
    onFocusDevice?.(id)
  }
  // В режиме «Все» показываем как образец эталонное устройство (с самой полной
  // картой), а правки пишем во все; в обычном — выбранное устройство.
  const activeDevice = isAllMode ? device : (selectableDevices.find(d => d.id === activeDeviceId) ?? effectiveDevices[0])
  const displayDeviceId = isAllMode ? device.id : activeDeviceId
  // Групповые операции идут по отмеченной галочками группе — если сейчас
  // просматривается ПЧ вне неё, кнопки «…все» блокируются.
  const viewingOutsideGroup = !!outsideDevice && activeDeviceId === outsideDevice.id
  const groupOpsAllowed = groupOpsEnabled && !viewingOutsideGroup

  const [readingGroup, setReadingGroup] = useState(null)
  const [groupValues, setGroupValues]   = useState({})
  const [search, setSearch]             = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [groupProgress, setGroupProgress] = useState(null) // { index, total, groupName, kind }
  const [opProgress, setOpProgress] = useState(null) // { done, total } — живой прогресс текущего runBulkOp
  const [openGroupIds, setOpenGroupIds] = useState(() => new Set())
  const latestGroupValues = useRef({})

  // Переключение на другое устройство (одиночный вид — сменили выбор в
  // списке слева; групповой — сменили в переключателе "текущее устройство
  // для правки") должно сворачивать все раскрытые группы, а не тянуть за
  // собой раскрытые группы предыдущего устройства и не открывать первую
  // группу автоматически.
  useEffect(() => {
    setOpenGroupIds(new Set())
  }, [activeDeviceId])

  const expandGroup = useCallback((groupId) => {
    setOpenGroupIds(prev => (prev.has(groupId) ? prev : new Set(prev).add(groupId)))
  }, [])

  const clearGroupValue = useCallback((paramId) => {
    setGroupValues(prev => {
      const next = { ...prev }
      delete next[paramId]
      return next
    })
  }, [])
  const [cols, setCols]             = useState(DEFAULT_COLS)
  const [groupOrder, setGroupOrder] = useState(null)
  const isGroupVisibilityControlled = controlledVisibleGroupIds !== undefined
  const [ownVisibleGroupIds, setOwnVisibleGroupIds] = useState(new Set(device.groups.map(g => g.id)))
  const visibleGroupIds = isGroupVisibilityControlled ? controlledVisibleGroupIds : ownVisibleGroupIds
  const [pendingWrites, setPendingWrites] = useState({})
  const [pendingVersion, setPendingVersion] = useState(0) // растёт при смене устройства/применении шаблона — форсирует переинициализацию полей записи в ParamRow
  const [currentValues, setCurrentValues] = useState({})
  // Результаты последнего группового чтения ПЕР УСТРОЙСТВО ({ [deviceId]: { [paramId]: value } }).
  // Нужны, чтобы per-device "Скачать CSV" в групповом режиме выгружал именно то
  // устройство, что выбрано в переключателе, а не первое (у которого раньше
  // остались сохранённые currentValues).
  const [bulkResults, setBulkResults] = useState({})
  const [currentFillStamp] = useState(0)
  const [factoryReport, setFactoryReport] = useState(null) // отчёт о параметрах, которые нельзя заполнить без исполнения
  const [presetModalOpen, setPresetModalOpen] = useState(false)
  const [presets, setPresets] = useState([])
  // «Избранное» — собственный список параметров на семейство ПЧ (см.
  // FavoritesService на бэке). Виртуальная группа, собираемая на лету.
  const [favoriteIds, setFavoriteIds] = useState([])
  const [favModalOpen, setFavModalOpen] = useState(false)
  const [favDraft, setFavDraft] = useState(new Set())
  const [favSearch, setFavSearch] = useState('')
  const [favPresetOpen, setFavPresetOpen] = useState(false)
  const [favPresetName, setFavPresetName] = useState('')
  const [savingFavPreset, setSavingFavPreset] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState(null)
  const [applyingPreset, setApplyingPreset] = useState(false)
  const latestCols = useRef(DEFAULT_COLS)
  const latestCurrentValues = useRef({})
  const currentSaveTimer = useRef(null)
  const resizing = useRef(null)

  const [deviceSettings, saveDeviceSettings] = useDeviceSettings(device.templateId ?? device.id)

  useEffect(() => {
    if (deviceSettings === null) return
    if (deviceSettings.paramColWidths) {
      const c = { ...DEFAULT_COLS, ...deviceSettings.paramColWidths }
      setCols(c)
      latestCols.current = c
    }
    setGroupOrder(deviceSettings.groupOrder ?? null)
    if (!isGroupVisibilityControlled) {
      setOwnVisibleGroupIds(
        deviceSettings.visibleGroups
          ? new Set(deviceSettings.visibleGroups)
          : new Set(device.groups.map(g => g.id)),
      )
    }
  }, [deviceSettings])

  function toggleGroupVisible(groupId, checked) {
    const next = new Set(visibleGroupIds)
    if (checked) next.add(groupId)
    else next.delete(groupId)
    if (isGroupVisibilityControlled) {
      onVisibleGroupIdsChange(next)
    } else {
      setOwnVisibleGroupIds(next)
      saveDeviceSettings({ visibleGroups: Array.from(next) })
    }
  }

  function setAllGroupsVisible(checked) {
    // orderedGroups включает виртуальную группу «Избранное», если она непуста.
    const next = checked ? new Set(orderedGroups.map(g => g.id)) : new Set()
    setVisibleGroups(next)
  }

  function setVisibleGroups(next) {
    if (isGroupVisibilityControlled) {
      onVisibleGroupIdsChange(next)
    } else {
      setOwnVisibleGroupIds(next)
      saveDeviceSettings({ visibleGroups: Array.from(next) })
    }
  }

  // Подготовленные значения (черновик) и последние прочитанные — хранятся на
  // бэке ПЕР УСТРОЙСТВО. В групповом режиме показываем/редактируем черновик
  // ТЕКУЩЕГО выбранного в переключателе устройства; при переключении между
  // устройствами каждое хранит и подставляет своё собственное значение.
  useEffect(() => {
    setPendingWrites({})
    setCurrentValues({})
    let cancelled = false
    api.get(`/devices/${displayDeviceId}/pending-writes`)
      .then(({ data }) => {
        if (cancelled) return
        setPendingWrites(data ?? {})
        setPendingVersion(v => v + 1)
      })
      .catch(() => {})
    api.get(`/devices/${displayDeviceId}/current-values`)
      .then(({ data }) => {
        if (cancelled) return
        const cv = data ?? {}
        setCurrentValues(cv)
        latestCurrentValues.current = cv
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeDeviceId])

  // Любое групповое чтение (в том числе «Скачать все параметры в CSV», которое
  // запускается из панели выше) сохраняет прочитанное на бэкенде. Здесь мы об
  // этом узнаём и перечитываем «значение на устройстве» — иначе колонка
  // оставалась пустой, хотя параметры только что были считаны.
  useEffect(() => {
    function onBulkDone(d) {
      if (d?.kind !== 'read') return
      api.get(`/devices/${displayDeviceId}/current-values`)
        .then(({ data }) => {
          const cv = data ?? {}
          setCurrentValues(cv)
          latestCurrentValues.current = cv
        })
        .catch(() => {})
    }
    socket.on('bulk:op:done', onBulkDone)
    return () => socket.off('bulk:op:done', onBulkDone)
  }, [displayDeviceId])

  // Подготовленные значения могли измениться в другом месте (применение
  // шаблона на вкладке «Шаблоны», массовая подготовка) — перечитываем их,
  // иначе поля показывали бы старое до перезагрузки страницы.
  useEffect(() => {
    function onPendingChanged(e) {
      const ids = e?.detail?.deviceIds
      if (ids && !ids.includes(displayDeviceId)) return
      api.get(`/devices/${displayDeviceId}/pending-writes`)
        .then(({ data }) => {
          setPendingWrites(data ?? {})
          setPendingVersion(v => v + 1) // форсируем переинициализацию полей в ParamRow
        })
        .catch(() => {})
    }
    window.addEventListener('pending-writes:changed', onPendingChanged)
    return () => window.removeEventListener('pending-writes:changed', onPendingChanged)
  }, [displayDeviceId])

  const handlePendingWriteChange = useCallback((paramId, val) => {
    setPendingWrites(prev => ({ ...prev, [paramId]: val }))
    if (isAllMode) {
      // Одним запросом — во все выбранные ПЧ (сервер сохраняет проект один раз).
      api.patch('/devices/pending-writes/bulk', { deviceIds: effectiveDeviceIds, pendingWrites: { [paramId]: val } }).catch(() => {})
    } else {
      api.patch(`/devices/${activeDeviceId}/pending-writes`, { merge: true, pendingWrites: { [paramId]: val } }).catch(() => {})
    }
  }, [activeDeviceId, isAllMode, effectiveDeviceIds.join(',')])

  const handleReadValue = useCallback((paramId, val) => {
    setCurrentValues(prev => {
      const next = { ...prev, [paramId]: val }
      latestCurrentValues.current = next
      return next
    })
    // Держим значение и в per-device карте — на неё опирается колонка "Значение
    // на устройстве" и per-device CSV в групповом режиме (одиночное чтение строки
    // тоже должно там отражаться, не только групповое).
    setBulkResults(prev => ({
      ...prev,
      [displayDeviceId]: { ...prev[displayDeviceId], [paramId]: val },
    }))
    if (currentSaveTimer.current) clearTimeout(currentSaveTimer.current)
    currentSaveTimer.current = setTimeout(() => {
      api.patch(`/devices/${displayDeviceId}/current-values`, { currentValues: latestCurrentValues.current }).catch(() => {})
    }, 500)
  }, [activeDeviceId, displayDeviceId])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // ─── Избранное: своя группа из произвольных параметров ────────────────────
  const FAV_GROUP_ID = '__favorites__'   // постоянное «Избранное» из шаблона
  const DEBUG_GROUP_ID = '__debug__'    // рабочая «Отладка», редактируется на месте
  const deviceFamilyId = deviceFamily(device)

  useEffect(() => {
    let cancelled = false
    api.get('/favorites', { params: { family: deviceFamilyId } })
      .then(({ data }) => { if (!cancelled) setFavoriteIds(Array.isArray(data) ? data : []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [deviceFamilyId])

  const allParamsById = new Map(device.groups.flatMap(g => g.params).map(p => [p.id, p]))

  // Две разные виртуальные группы, их легко перепутать:
  //
  // «★ Избранное» — ПОСТОЯННЫЙ набор, заданный в шаблоне модели
  // (builtinFavorites) ещё до сборки инсталлятора. На объекте не редактируется:
  // это выверенный список того, что нужно при пусконаладке всегда.
  //
  // «🔧 Отладка» — РАБОЧАЯ группа: собирается на месте под текущую задачу,
  // меняется и очищается сколько угодно, хранится отдельно (favorites API).
  const builtinFavoriteParams = (device.builtinFavorites ?? [])
    .map(id => allParamsById.get(id))
    .filter(Boolean)
  const favoriteGroup = { id: FAV_GROUP_ID, name: '★ Избранное', params: builtinFavoriteParams }

  const debugParams = favoriteIds.map(id => allParamsById.get(id)).filter(Boolean)
  const debugGroup = { id: DEBUG_GROUP_ID, name: '🔧 Отладка', params: debugParams }
  // Дальше по коду редактируемым списком остаётся debug-набор
  const favoriteParams = debugParams

  // Сохраняем на бэке; локальное состояние обновляем только при успехе, иначе
  // список «на экране есть, а на самом деле не сохранён» (эта рассинхронизация
  // и путала: галочки применялись, а следом падала ошибка).
  async function saveFavorites(ids) {
    const prev = favoriteIds
    setFavoriteIds(ids)
    try {
      await api.put('/favorites', { family: deviceFamilyId, paramIds: ids })
      return true
    } catch (e) {
      setFavoriteIds(prev) // откат — на бэке ничего не изменилось
      const status = e?.response?.status
      message.error(
        status === 404
          ? 'Избранное недоступно: бэкенд запущен без модуля favorites — перезапустите backend (npm run start:dev)'
          : (e?.response?.data?.message ?? 'Не удалось сохранить избранное'),
      )
      return false
    }
  }

  async function clearFavorites() {
    if (await saveFavorites([])) {
      setFavModalOpen(false)
      message.success('Избранное очищено')
    }
  }

  function openFavModal() {
    setFavDraft(new Set(favoriteIds))
    setFavSearch('')
    setFavModalOpen(true)
  }

  async function applyFavDraft() {
    // Сохраняем в порядке следования параметров в шаблоне модели — предсказуемо.
    const ordered = device.groups.flatMap(g => g.params).map(p => p.id).filter(id => favDraft.has(id))
    if (!(await saveFavorites(ordered))) return // не закрываем окно — правки не потеряются
    setFavModalOpen(false)
    if (ordered.length > 0) {
      setVisibleGroups(new Set([...visibleGroupIds, DEBUG_GROUP_ID]))
      message.success(`В избранном ${ordered.length} параметров`)
    } else {
      message.success('Избранное очищено')
    }
  }

  // Шаблон значений на основе избранного: берём текущие подготовленные (или
  // заводские) значения ровно по избранным параметрам.
  async function createPresetFromFavorites() {
    const name = favPresetName.trim()
    if (!name) { message.warning('Введите название шаблона'); return }
    const presetValues = {}
    for (const p of favoriteParams) {
      if (!isParamWritable(device, p)) continue
      const val = pendingWrites[p.id] ?? (typeof p.default === 'number' ? p.default : undefined)
      if (typeof val === 'number') presetValues[p.id] = val
    }
    if (Object.keys(presetValues).length === 0) {
      message.warning('В избранном нет записываемых параметров со значениями')
      return
    }
    setSavingFavPreset(true)
    try {
      await api.post('/presets', { name, family: deviceFamilyId, values: presetValues })
      message.success(`Шаблон «${name}» создан из избранного (${Object.keys(presetValues).length} рег.)`)
      addLog('success', `Создан шаблон «${name}» из избранного (${Object.keys(presetValues).length} параметров)`)
      // Вкладка «Шаблоны» — отдельный компонент со своим списком, который
      // грузится один раз; без этого события новый шаблон появлялся там только
      // после перезагрузки страницы.
      window.dispatchEvent(new CustomEvent('presets:changed'))
      setFavPresetOpen(false)
      setFavPresetName('')
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Не удалось создать шаблон')
    } finally {
      setSavingFavPreset(false)
    }
  }

  // Избранное всегда первым — это «самое нужное», ради чего его и заводят.
  const groupsWithFavorites = [
    ...(builtinFavoriteParams.length > 0 ? [favoriteGroup] : []),
    ...(debugParams.length > 0 ? [debugGroup] : []),
    ...device.groups,
  ]

  const orderedGroups = groupOrder
    ? [...groupsWithFavorites].sort((a, b) => {
        // Обе виртуальные группы всегда наверху, порядок между ними фиксирован
        const rank = id => (id === FAV_GROUP_ID ? -2 : id === DEBUG_GROUP_ID ? -1 : 0)
        if (rank(a.id) !== rank(b.id)) return rank(a.id) - rank(b.id)
        if (rank(a.id) < 0) return 0
        const ai = groupOrder.indexOf(a.id)
        const bi = groupOrder.indexOf(b.id)
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
      })
    : groupsWithFavorites

  const groupsInScope = orderedGroups.filter(g => visibleGroupIds.has(g.id))

  function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedGroups.findIndex(g => g.id === active.id)
    const newIndex = orderedGroups.findIndex(g => g.id === over.id)
    const newOrder = arrayMove(orderedGroups, oldIndex, newIndex).map(g => g.id)
    setGroupOrder(newOrder)
    saveDeviceSettings({ groupOrder: newOrder })
  }

  const startResize = useCallback((key) => (e) => {
    e.preventDefault()
    resizing.current = { key, startX: e.clientX, startW: cols[key] }

    function onMove(e) {
      if (!resizing.current) return
      const { key, startX, startW } = resizing.current
      const newW = Math.max(MIN_COLS[key], startW + e.clientX - startX)
      setCols(prev => {
        const next = { ...prev, [key]: newW }
        latestCols.current = next
        return next
      })
    }
    function onUp() {
      resizing.current = null
      saveDeviceSettings({ paramColWidths: latestCols.current })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [cols])

  const bulkCancelRef = useRef(false)

  function stopGroupedOperation() {
    bulkCancelRef.current = true
    socket.emit('bulk:op:cancel')
  }

  // Единый механизм группового чтения/записи: один WebSocket-запрос, сервер сам
  // проходит по всем (устройство × параметр) и шлёт прогресс по каждому — вместо
  // отдельного HTTP-запроса на каждую пару с фронта (было в разы медленнее и
  // "Остановить" реагировало только между уже запущенными HTTP-вызовами).
  //
  // Запись поддерживает два режима payload:
  //  - массив paramIds (чтение)
  //  - { usePending: true, paramIds } — запись per-device подготовленных значений
  //    (сервер сам берёт pendingWrites каждого устройства и очищает записанное)
  //  - обычный объект { paramId: value } — запись ОДИНАКОВЫХ значений всем
  //    устройствам (используется только для сброса до заводских)
  // Прогресс и накопленные значения обновляют React-состояние НЕ на каждый
  // параметр (при сотнях регистров × нескольких ПЧ это сотни ре-рендеров и
  // подлагивания), а пачками не чаще ~1 раза в 80 мс — визуально то же самое,
  // но кратно меньше работы у браузера.
  function runBulkOp(kind, ids, payload) {
    const knownTotal = kind === 'read'
      ? ids.length * payload.length
      : (payload?.usePending ? null : ids.length * Object.keys(payload).length)
    setOpProgress({ done: 0, total: knownTotal ?? 0 })
    return new Promise(resolve => {
      let done = 0
      let total = knownTotal ?? 0
      const gvAcc = {}   // накопитель groupValues
      const brAcc = {}   // накопитель bulkResults (по устройствам)
      let flushTimer = null
      function flush() {
        flushTimer = null
        setOpProgress({ done, total })
        // ВАЖНО: сначала СНИМАЕМ КОПИЮ накопителя и только потом очищаем его.
        // Функция-updater в setState выполняется не в момент вызова, а позже
        // (на этапе рендера), поэтому если очистить накопитель сразу после
        // вызова, updater получит уже пустой объект и часть значений потеряется —
        // именно из-за этого в таблице группового чтения появлялись прочерки, а
        // у одиночного ПЧ колонка «Значение на устройстве» оставалась пустой.
        if (Object.keys(gvAcc).length) {
          const gvBatch = { ...gvAcc }
          for (const k of Object.keys(gvAcc)) delete gvAcc[k]
          setGroupValues(prev => ({ ...prev, ...gvBatch }))
        }
        if (Object.keys(brAcc).length) {
          const brBatch = {}
          for (const [dId, vals] of Object.entries(brAcc)) brBatch[dId] = { ...vals }
          for (const k of Object.keys(brAcc)) delete brAcc[k]
          setBulkResults(prev => {
            const next = { ...prev }
            for (const [dId, vals] of Object.entries(brBatch)) next[dId] = { ...next[dId], ...vals }
            return next
          })
        }
      }
      function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 80) }
      function onTotal(t) { if (t.kind !== kind) return; total = t.total; schedule() }
      function onProgress(p) {
        if (p.kind !== kind || !ids.includes(p.deviceId)) return
        done++
        if (!p.error) {
          gvAcc[p.paramId] = p.value
          // latestGroupValues.current держим свежим сразу (на него смотрит
          // readGroup при слиянии в currentValues одиночного ПЧ).
          latestGroupValues.current = { ...latestGroupValues.current, [p.paramId]: p.value }
          brAcc[p.deviceId] = { ...(brAcc[p.deviceId] || {}), [p.paramId]: p.value }
        }
        schedule()
      }
      function onDone(d) {
        if (d.kind !== kind) return
        socket.off('bulk:op:total', onTotal)
        socket.off('bulk:op:progress', onProgress)
        socket.off('bulk:op:done', onDone)
        if (flushTimer) clearTimeout(flushTimer)
        flush()            // финальный сброс накопленного
        setOpProgress(null)
        resolve(d)
      }
      socket.on('bulk:op:total', onTotal)
      socket.on('bulk:op:progress', onProgress)
      socket.on('bulk:op:done', onDone)
      if (kind === 'read') socket.emit('bulk:read:start', { deviceIds: ids, paramIds: payload })
      else if (payload?.usePending) socket.emit('bulk:write:start', { deviceIds: ids, usePending: true, paramIds: payload.paramIds })
      else socket.emit('bulk:write:start', { deviceIds: ids, values: payload })
    })
  }

  async function readGroup(group, e, { autoExpand = true, notify = true } = {}) {
    e?.stopPropagation()
    if (autoExpand) expandGroup(group.id)
    setReadingGroup(group.id)
    const key = notify ? processStart(`Чтение группы «${group.name}»…`, 'Опрос ПЧ') : null
    const paramIds = group.params.map(p => p.id)
    const result = await runBulkOp('read', effectiveDeviceIds, paramIds)
    setReadingGroup(null)
    if (result.cancelled) {
      message.info(`Остановлено: группа «${group.name}» прочитана частично (${result.ok}/${result.total})`)
      if (key) processInfo(key, `Группа «${group.name}» прочитана частично (${result.ok}/${result.total})`)
    } else {
      message.success(`Группа «${group.name}» прочитана (${result.ok}/${result.total})`)
      addLog("success", `Прочитана группа «${group.name}»: ${result.ok} из ${result.total} параметров${isBulk ? `, ПЧ: ${effectiveDeviceIds.length}` : ""}`)
      if (key) processDone(key, `Группа «${group.name}» прочитана (${result.ok}/${result.total})`)
    }
    if (effectiveDeviceIds.length === 1) {
      const merged = { ...latestCurrentValues.current }
      for (const paramId of paramIds) {
        if (latestGroupValues.current[paramId] !== undefined) merged[paramId] = latestGroupValues.current[paramId]
      }
      setCurrentValues(merged)
      latestCurrentValues.current = merged
      api.patch(`/devices/${activeDeviceId}/current-values`, { currentValues: merged }).catch(() => {})
    }
  }

  // Запись группы: каждое устройство пишет СВОИ подготовленные значения этой
  // группы (не общее значение с экрана) — то, что реально нужно, если часть
  // выбранных ПЧ отличается от остальных.
  async function writeGroup(group, e, { autoExpand = true, notify = true } = {}) {
    e?.stopPropagation()
    if (autoExpand) expandGroup(group.id)
    setReadingGroup(group.id)
    const key = notify ? processStart(`Запись группы «${group.name}»…`, 'Запись в ПЧ') : null
    const paramIds = group.params.filter(p => isParamWritable(device, p)).map(p => p.id)
    const result = await runBulkOp('write', effectiveDeviceIds, { usePending: true, paramIds })
    setReadingGroup(null)
    if (result.total === 0) {
      message.info(`В группе «${group.name}» ни у одного устройства нет подготовленных значений для записи`)
      if (key) processInfo(key, `В группе «${group.name}» нет значений для записи`)
    } else if (result.cancelled) {
      message.info(`Остановлено: группа «${group.name}» записана частично (${result.ok}/${result.total})`)
      if (key) processInfo(key, `Группа «${group.name}» записана частично (${result.ok}/${result.total})`)
    } else {
      message.success(`Записано ${result.ok} из ${result.total} (группа «${group.name}»)`)
      addLog("success", `Записана группа «${group.name}»: ${result.ok} из ${result.total} параметров${isBulk ? `, ПЧ: ${effectiveDeviceIds.length}` : ""}`)
      if (key) processDone(key, `Записано ${result.ok} из ${result.total} (группа «${group.name}»)`)
    }
    setPendingVersion(v => v + 1)
  }

  // Заводской сброс — ОДНОЙ штатной командой в специальный регистр (Pump:
  // F1.17=8, VL: PP.01=1), а не записью сотни значений по одному. Так корректнее:
  // сам ПЧ знает свои заводские значения для конкретного исполнения, а наши
  // табличные default'ы общие для модели и могут не подойти.
  // Связь после сброса теряется — это поведение самого устройства, оператор
  // предупреждён в диалоге подтверждения.
  async function factoryResetDevices() {
    const targets = isAllMode ? effectiveDevices : [activeDevice]
    const reset = device.factoryReset
    if (!reset) {
      message.error('Для этой модели не задана команда заводского сброса')
      return
    }
    const key = processStart(`Заводской сброс: ${targets.length} ПЧ…`, 'Сброс до заводских')
    let ok = 0
    for (const d of targets) {
      try {
        await api.post('/modbus/write', { deviceId: d.id, paramId: reset.paramId, value: reset.value })
        ok++
        addLog('warning', `Заводской сброс подан: ${d.name} (Адрес ${d.connection.slaveId}) — ${reset.paramId}=${reset.value}; связь с устройством будет потеряна`)
      } catch (e) {
        // Устройство часто не успевает ответить на подтверждение — оно уже
        // сбрасывается и меняет адрес. Это не обязательно ошибка.
        addLog('warning', `${d.name}: ответ на команду сброса не получен (${e?.response?.data?.message ?? e.message}) — вероятно, ПЧ уже сбрасывается`)
      }
    }
    processDone(key, `Команда сброса подана на ${targets.length} ПЧ (подтвердили ${ok}). Связь с ними потеряна — настройте адрес и скорость с пульта.`, 'Сброс выполнен')
    message.warning(`Заводской сброс подан на ${targets.length} ПЧ. Связь потеряна — это ожидаемо.`)
  }

  // «Подготовить заводские значения» — заполняет колонку «Значение для записи»
  // заводскими, НЕ записывая ничего в ПЧ (записать можно потом обычной кнопкой,
  // предварительно посмотрев и поправив). Учитывает исполнение устройства:
  //  - параметры с общим для модели заводским значением берутся из шаблона;
  //  - параметры, у которых значение «зависит от модели ПЧ», — из таблицы
  //    modelDefaults для конкретного исполнения;
  //  - если исполнение не указано или значения для него нет — параметр
  //    пропускается и попадает в отчёт, а не заполняется наугад.
  async function prepareFactoryValues(groups) {
    const scope = groups ?? groupsInScope
    if (scope.length === 0) { message.info('Нет отображаемых групп'); return }
    const targets = isAllMode ? effectiveDevices : [activeDevice]
    const dependent = new Set(device.modelDependentParams ?? [])

    const skipped = []   // нечего подставить
    let prepared = 0
    for (const d of targets) {
      const byModel = (device.modelDefaults ?? {})[d.model] ?? {}
      const patch = {}
      for (const g of scope) {
        if (g.protectedFromBulk) continue // настройки связи не трогаем
        for (const p of g.params) {
          if (!isParamWritable(device, p)) continue
          if (dependent.has(p.id)) {
            if (typeof byModel[p.id] === 'number') patch[p.id] = byModel[p.id]
            else skipped.push({ device: d.name, paramId: p.id, name: p.name, reason: d.model ? `нет значения для исполнения ${d.model}` : 'не указано исполнение ПЧ' })
          } else if (typeof p.default === 'number') {
            patch[p.id] = p.default
          }
        }
      }
      if (Object.keys(patch).length) {
        await api.patch(`/devices/${d.id}/pending-writes`, { merge: true, pendingWrites: patch }).catch(() => {})
        prepared += Object.keys(patch).length
      }
    }
    window.dispatchEvent(new CustomEvent('pending-writes:changed', { detail: { deviceIds: targets.map(d => d.id) } }))
    const uniqSkipped = [...new Set(skipped.map(s => s.paramId))]
    message.success(`Подготовлено ${prepared} заводских значений (${targets.length} ПЧ). Проверьте и запишите обычной кнопкой.`)
    addLog('info', `Подготовлены заводские значения: ${prepared} шт., ПЧ: ${targets.length}${uniqSkipped.length ? `; без значения (зависят от исполнения): ${uniqSkipped.join(', ')}` : ''}`)
    if (uniqSkipped.length) setFactoryReport({ skipped, uniqSkipped })
  }

  async function processAllGroups(kind) {
    if (groupsInScope.length === 0) {
      message.info('Нет отображаемых групп — отметьте хотя бы одну галочкой ниже')
      return
    }
    bulkCancelRef.current = false
    const verb = kind === 'read' ? 'Опрос' : kind === 'write' ? 'Запись' : 'Сброс до заводских'
    // Настройки связи из массового сброса исключены (см. resetGroup): читать их
    // скопом безопасно, а вот сбрасывать — нет.
    const skipped = kind === 'reset' ? groupsInScope.filter(g => g.protectedFromBulk) : []
    if (skipped.length) {
      message.warning(`Пропущены настройки связи (${skipped.map(g => g.name).join(', ')}) — их массовый сброс оборвал бы связь с ПЧ`)
    }
    const groupsToProcess = kind === 'reset' ? groupsInScope.filter(g => !g.protectedFromBulk) : groupsInScope
    const total = groupsToProcess.length
    const key = processStart(`${verb}: 0 из ${total} групп…`, verb)
    let processed = 0
    for (let i = 0; i < groupsToProcess.length; i++) {
      if (bulkCancelRef.current) break
      const group = groupsToProcess[i]
      setGroupProgress({ index: i, total, groupName: group.name, kind })
      processUpdate(key, `${verb}: группа ${i + 1} из ${total} — «${group.name}»…`, verb)
      const fakeEvent = { stopPropagation: () => {} }
      // При "Прочитать/Записать/Сбросить всё" группы НЕ разворачиваются одна за
      // другой по ходу цикла — иначе к концу открытыми оказываются вообще все
      // группы, страница расползается. Значения всё равно попадают в
      // currentValues/groupValues независимо от того, открыта группа или нет.
      // notify:false — общее уведомление ведём здесь, по каждой группе не плодим.
      const opts = { autoExpand: false, notify: false }
      if (kind === 'read') await readGroup(group, fakeEvent, opts)
      else if (kind === 'write') await writeGroup(group, fakeEvent, opts)
      else await resetGroup(group, fakeEvent, opts)
      processed++
    }
    setGroupProgress(null)
    if (bulkCancelRef.current) {
      message.info(`Остановлено: обработано ${processed} из ${total} групп`)
      processInfo(key, `Остановлено: обработано ${processed} из ${total} групп`)
    } else {
      const doneMsg = kind === 'read'
        ? `Опрос завершён — считаны все отображаемые группы (${total})`
        : kind === 'write'
          ? `Запись завершена — обработаны все отображаемые группы (${total})`
          : `Сброс завершён — все отображаемые группы (${total})`
      message.success(doneMsg)
      addLog("success", doneMsg)
      processDone(key, doneMsg, `${verb} завершён`)
    }
  }

  async function resetGroup(group, e, { autoExpand = true, notify = true } = {}) {
    e?.stopPropagation()
    // Настройки связи (адрес на шине, скорость) сбрасывать нельзя: заводской
    // адрес у всех ПЧ = 1 — сброс посадил бы всю шину на один адрес и оборвал
    // связь. Менять их можно только вручную, по одной строке.
    if (group.protectedFromBulk) {
      message.warning(`Группа «${group.name}» — настройки связи (адрес на шине, скорость). Массовый сброс для неё запрещён: заводской адрес у всех ПЧ одинаковый, и сброс оборвал бы связь со всеми устройствами. Меняйте эти параметры вручную, по одному.`)
      return
    }
    const toWrite = group.params.filter(
      p => isParamWritable(device, p) && p.default !== undefined && p.default !== null && typeof p.default === 'number'
    )
    if (toWrite.length === 0) {
      message.info('Нет параметров с заводскими значениями')
      return
    }
    if (autoExpand) expandGroup(group.id)
    setReadingGroup(group.id)
    const key = notify ? processStart(`Сброс группы «${group.name}» до заводских…`, 'Сброс до заводских') : null
    const values = {}
    for (const p of toWrite) values[p.id] = p.default
    const result = await runBulkOp('write', effectiveDeviceIds, values)
    setReadingGroup(null)
    if (result.cancelled) {
      message.info(`Остановлено: группа «${group.name}» сброшена частично (${result.ok}/${result.total})`)
      if (key) processInfo(key, `Группа «${group.name}» сброшена частично (${result.ok}/${result.total})`)
    } else {
      message.success(`Сброшено ${result.ok} из ${result.total} параметров группы ${group.name}`)
      addLog("warning", `Сброс до заводских: группа «${group.name}», ${result.ok} из ${result.total} параметров`)
      if (key) processDone(key, `Сброшено ${result.ok} из ${result.total} (группа «${group.name}»)`)
    }
  }

  // ─── Шаблоны значений (пресеты) ────────────────────────────────────────────

  const family = deviceFamily(device)

  async function openPresetModal() {
    setSelectedPresetId(null)
    setPresetModalOpen(true)
    try {
      const { data } = await api.get('/presets', { params: { family } })
      setPresets(data)
    } catch {
      setPresets([])
    }
  }

  async function applyPreset() {
    const preset = presets.find(p => p.id === selectedPresetId)
    if (!preset) return
    setApplyingPreset(true)
    try {
      await Promise.all(effectiveDeviceIds.map(id =>
        api.patch(`/devices/${id}/pending-writes`, { merge: true, pendingWrites: preset.values }).catch(() => {})
      ))
      message.success(`Шаблон «${preset.name}» применён к ${effectiveDeviceIds.length} устр. — значения подготовлены к записи`)
      addLog('success', `Шаблон «${preset.name}» применён к ${effectiveDeviceIds.length} ПЧ (${Object.keys(preset.values).length} параметров подготовлено)`)
      // Обновить видимые поля, если открытое сейчас устройство входит в выборку
      setPendingWrites(prev => ({ ...prev, ...preset.values }))
      setPendingVersion(v => v + 1)
      // ...и уведомить остальные экземпляры (напр. другой ПЧ в переключателе)
      window.dispatchEvent(new CustomEvent('pending-writes:changed', {
        detail: { deviceIds: effectiveDeviceIds },
      }))
      // Оставляем в отображении и раскрываем ровно те группы, которые есть в
      // шаблоне — чтобы человек сразу видел подготовленные значения и не искал
      // их среди всех групп.
      const presetGroupIds = new Set(
        device.groups.filter(g => g.params.some(p => preset.values[p.id] !== undefined)).map(g => g.id),
      )
      if (presetGroupIds.size) {
        setVisibleGroups(presetGroupIds)
        for (const groupId of presetGroupIds) expandGroup(groupId)
      }
      setPresetModalOpen(false)
    } finally {
      setApplyingPreset(false)
    }
  }

  // Значения для per-device CSV: в групповом режиме — результаты отображаемого
  // устройства (bulkResults[displayDeviceId]); в одиночном — последние
  // прочитанные (currentValues).
  const csvValues = isBulk ? (bulkResults[displayDeviceId] ?? {}) : currentValues
  // Скачиваем ТОЛЬКО отображаемые (отмеченные галочками) группы и только если
  // все они уже считаны — иначе кнопка неактивна (сначала считка, потом CSV).
  const csvGroupIsRead = g => g.params.some(p => csvValues[p.id] != null)
  const csvReady = groupsInScope.length > 0 && groupsInScope.every(csvGroupIsRead)

  // Экспорт значений отображаемых групп в CSV — тот же формат, что и
  // импорт/экспорт шаблонов значений (колонки "Параметр"/"Значение"), поэтому
  // такой файл можно загрузить и как заготовку шаблона. Имя файла = метки
  // отображаемых групп + имя ПЧ: "F2-EMD-PUMP-6", "Управление_ПЧ-F2-EMD-PUMP-6",
  // все группы → "All-Param-EMD-PUMP-6".
  function exportCurrentValuesCsv() {
    if (!csvReady) return
    const rows = groupsInScope.flatMap(g => g.params)
      .filter(p => csvValues[p.id] != null)
      .map(p => [p.id, p.name, csvValues[p.id], p.unit ?? ''])
    const groupPart = groupsInScope.length === device.groups.length
      ? 'All-Param'
      : (groupsInScope.map(groupFileLabel).join('-') || 'params')
    const safeName = String(activeDevice.name).replace(/[^\p{L}\p{N}_-]+/gu, '_')
    downloadCsv(
      `${groupPart}-${safeName}.csv`,
      ['Параметр', 'Название', 'Значение', 'Единица'],
      rows,
    )
  }

  const query = search.trim().toLowerCase()
  const filteredGroups = groupsInScope
    .map(group => ({
      ...group,
      params: query
        ? group.params.filter(p =>
            p.id.toLowerCase().includes(query) ||
            p.name.toLowerCase().includes(query))
        : group.params,
    }))
    .filter(g => g.params.length > 0)

  const totalWidth = cols.id + cols.desc + cols.def + 20 + cols.cur + 20 + cols.write

  const items = filteredGroups.map((group, groupIndex) => ({
    key: group.id,
    label: group.name,
    extra: (
      <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
        {readingGroup === group.id && (
          <Button size="small" danger onClick={stopGroupedOperation}>
            Остановить
          </Button>
        )}
        <Button
          size="small"
          icon={<DownloadOutlined />}
          loading={readingGroup === group.id}
          disabled={!modbusConnected || (readingGroup !== null && readingGroup !== group.id)}
          onClick={e => readGroup(group, e)}
        >
          Прочитать группу
        </Button>
        <Button
          size="small"
          icon={<UploadOutlined />}
          disabled={!modbusConnected || readingGroup !== null}
          loading={readingGroup === group.id}
          onClick={e => writeGroup(group, e)}
        >
          Записать группу
        </Button>
        <Popconfirm
          title="Сброс до заводских"
          description={`Записать заводские значения во все параметры группы «${group.name}»?`}
          okText="Сбросить"
          cancelText="Отмена"
          okButtonProps={{ danger: true }}
          onConfirm={e => resetGroup(group, e ?? { stopPropagation: () => {} })}
        >
          <Button
            size="small"
            icon={<RollbackOutlined />}
            disabled={!modbusConnected || readingGroup !== null}
            danger
          >
            Заводские
          </Button>
        </Popconfirm>
      </div>
    ),
    children: (
      <div className={groupIndex % 2 === 0 ? 'param-group-body-even' : 'param-group-body-odd'} style={{ overflowX: 'auto', background: groupIndex % 2 === 0 ? '#fff' : '#fafafa' }}>
        <div style={{ minWidth: totalWidth }}>
          <ParamTableHeader cols={cols} onResizeStart={startResize} />
          {group.params.map(param => (
            <ParamRow
              key={`${activeDeviceId}-${param.id}-v${pendingVersion}`}
              device={activeDevice}
              param={param}
              modbusConnected={modbusConnected}
              deviceRunning={deviceRunning}
              injectedValue={isBulk ? bulkResults[displayDeviceId]?.[param.id] : groupValues[param.id]}
              cols={cols}
              onWrite={onWrite}
              onClearGroupValue={clearGroupValue}
              pendingWriteValue={pendingWrites[param.id]}
              onPendingWriteChange={handlePendingWriteChange}
              currentValue={currentValues[param.id]}
              currentFillStamp={currentFillStamp}
              onReadValue={handleReadValue}
            />
          ))}
        </div>
      </div>
    ),
  }))

  // По 3 группы в столбец у Pump, по 4 у VL/VH — раскладка сверху вниз, потом
  // следующий столбец, а не горизонтальный перенос (проще ориентироваться в
  // длинном списке групп).
  const checkboxRows = family === 'vl' ? 4 : 3

  return (
    <>
      {/* Переключатель «с чем работаем» — ВЫШЕ панели действий: сначала видно,
          к какому ПЧ (или ко всей группе) относятся кнопки, и только потом сами
          кнопки. Показывается всегда, даже когда доступен один ПЧ, — чтобы
          адресат операции был явным, а не угадывался. */}
      <div style={{
        marginBottom: 12, padding: '6px 10px', borderRadius: 6,
        background: isAllMode ? '#fff7e6' : '#f0f7ff',
        border: `1px solid ${isAllMode ? '#ffd591' : '#bae0ff'}`,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <Typography.Text strong style={{ fontSize: 12 }}>Работаем с:</Typography.Text>
        <Select
          value={mixedSelectable ? device.id : activeDeviceId}
          onChange={mixedSelectable ? (id => onFocusDevice?.(id)) : changeActiveDevice}
          style={{ minWidth: 300 }}
          popupMatchSelectWidth={false}
          options={mixedSelectable
            // Смешанный выбор: только конкретные ПЧ, без «все разом» —
            // групповые операции по разным картам регистров невозможны.
            ? mixedSelectable.map(d => ({
                value: d.id,
                label: `${d.name} · Адрес ${d.connection.slaveId} · ${deviceFamily(d) === 'vl' ? 'VL' : 'Pump'}`,
              }))
            : [
                ...(isBulk ? [{
                  value: ALL_DEVICES,
                  label: `★ Все выбранные ПЧ (${effectiveDeviceIds.length}) — читать, мониторить и править разом`,
                }] : []),
                ...effectiveDevices.map(d => ({
                  value: d.id,
                  label: `${d.name} · Адрес ${d.connection.slaveId}`,
                })),
                ...(outsideDevice ? [{
                  value: outsideDevice.id,
                  label: `${outsideDevice.name} · Адрес ${outsideDevice.connection.slaveId} — вне группы отладки`,
                }] : []),
              ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {mixedSelectable
            ? 'выбраны ПЧ разных типов — групповые операции недоступны, работаем с одним устройством'
            : isAllMode
              ? 'чтение, мониторинг и правка значений — по всем отмеченным ПЧ сразу'
              : 'чтение, мониторинг и правка значений — только по этому ПЧ'}
        </Typography.Text>
      </div>

      <Space style={{ marginBottom: 12, width: '100%' }} wrap>
        <Input
          prefix={<SearchOutlined style={{ color: '#bbb' }} />}
          placeholder={searchFocused || search ? 'Поиск параметра по коду или названию' : 'Поиск'}
          value={search}
          onChange={e => setSearch(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          allowClear
          style={{ width: searchFocused || search ? 320 : 110, transition: 'width 0.15s' }}
        />
        <Button
          icon={<FileTextOutlined />}
          onClick={openPresetModal}
        >
          Подготовить из шаблона
        </Button>
        <Tooltip title={csvReady
          ? 'Скачать значения отображаемых (отмеченных галочками) групп в CSV'
          : 'Сначала считайте все отображаемые группы (кнопкой «Прочитать все» или по группам) — потом станет доступно скачивание'}>
          <Button
            icon={<DownloadOutlined />}
            disabled={!csvReady}
            onClick={exportCurrentValuesCsv}
          >
            Скачать CSV
          </Button>
        </Tooltip>
        {groupProgress ? (
          <Button danger onClick={stopGroupedOperation}>
            Остановить {groupProgress.kind === 'read' ? 'чтение' : groupProgress.kind === 'write' ? 'запись' : 'сброс'}
          </Button>
        ) : (
          <>
            <Tooltip title={groupOpsAllowed ? '' : outOfGroupHint}>
              <Button
                icon={<DownloadOutlined />}
                disabled={!modbusConnected || !groupOpsAllowed}
                onClick={() => processAllGroups('read')}
              >
                Прочитать все
              </Button>
            </Tooltip>
            <Tooltip title={groupOpsAllowed ? '' : outOfGroupHint}>
              <Button
                icon={<UploadOutlined />}
                disabled={!modbusConnected || !groupOpsAllowed}
                onClick={() => processAllGroups('write')}
              >
                Записать все
              </Button>
            </Tooltip>
            <Tooltip title="Заполнить колонку «Значение для записи» заводскими значениями с учётом исполнения ПЧ. В устройства ничего не пишется — сначала проверьте, потом запишите кнопкой «Записать все».">
              <Button
                icon={<RollbackOutlined />}
                disabled={!groupOpsAllowed}
                onClick={() => prepareFactoryValues()}
              >
                Подготовить заводские
              </Button>
            </Tooltip>
            <Popconfirm
              title="Заводской сброс — связь с ПЧ будет потеряна"
              description={(
                <div style={{ maxWidth: 460 }}>
                  Будет подана штатная команда заводского сброса
                  {device.factoryReset ? ` (${device.factoryReset.paramId} = ${device.factoryReset.value})` : ''}
                  {' '}на {isAllMode ? `все выбранные ПЧ (${effectiveDeviceIds.length})` : 'выбранный ПЧ'}.
                  <br /><br />
                  <b>ПЧ сбросит и настройки связи:</b> адрес на шине станет 1, скорость и формат — заводскими.
                  Программа сразу потеряет это устройство. Если сбросить несколько ПЧ, все они окажутся
                  на адресе 1 и начнут отвечать одновременно — шина перестанет работать.
                  <br /><br />
                  Восстановить связь можно будет только настроив адрес и скорость заново
                  с пульта каждого ПЧ (или подключая их по одному).
                </div>
              )}
              okText="Всё равно сбросить"
              cancelText="Отмена"
              okButtonProps={{ danger: true }}
              onConfirm={factoryResetDevices}
            >
              <Button icon={<RollbackOutlined />} danger disabled={!modbusConnected || !groupOpsAllowed}>
                Сбросить до заводских
              </Button>
            </Popconfirm>
          </>
        )}
      </Space>

      {!groupOpsAllowed && (
        <div style={{ marginBottom: 8, padding: '4px 10px', background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 6 }}>
          <Typography.Text style={{ fontSize: 12, color: '#d46b08' }}>
            Этот ПЧ просматривается, но не отмечен галочкой для групповых операций — «Прочитать/Записать/Сбросить все» недоступны.
            Отметьте его галочкой в списке слева, чтобы включить в группу отладки.
          </Typography.Text>
        </div>
      )}

      {isAllMode && (
        <div style={{ marginBottom: 8, padding: '4px 10px', background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 6 }}>
          <Typography.Text style={{ fontSize: 12, color: '#d46b08' }}>
            ★ Режим «Все выбранные ПЧ»: любое изменение поля «Значение для записи» применяется сразу ко всем {effectiveDeviceIds.length} выбранным ПЧ.
          </Typography.Text>
        </div>
      )}

      {/* В групповом режиме полосу прогресса показывает BulkPanel НАД таблицей
          результатов; здесь (одиночный ПЧ) — рядом с кнопками. */}
      {!isBulk && groupProgress && (
        <Progress
          style={{ marginBottom: 4 }}
          percent={Math.round(((groupProgress.index) / groupProgress.total) * 100)}
          status="active"
          format={() => `Группа ${groupProgress.index + 1} из ${groupProgress.total}: ${groupProgress.groupName}`}
        />
      )}
      {!isBulk && opProgress && (
        <Progress
          style={{ marginBottom: 12 }}
          size="small"
          percent={opProgress.total > 0 ? Math.round((opProgress.done / opProgress.total) * 100) : 0}
          status="active"
          format={() => `${opProgress.done} из ${opProgress.total} параметров`}
        />
      )}

      <div className="param-toolbar-box" style={{ marginBottom: 12, padding: '8px 10px', background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>
          Отображаемые группы параметров (влияет на «Прочитать/Записать/Сбросить все»)
        </Typography.Text>
        {/* Клик по квадратику — вкл/выкл группы; клик по НАЗВАНИЮ — «показать
            только эту группу» (как у фильтра Pump/VL в сайдбаре). Поэтому
            подпись вынесена из <Checkbox>: внутри неё она была бы частью
            <label> и всегда просто переключала галочку. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Checkbox
            checked={visibleGroupIds.size === orderedGroups.length}
            indeterminate={visibleGroupIds.size > 0 && visibleGroupIds.size < orderedGroups.length}
            onChange={e => setAllGroupsVisible(e.target.checked)}
          />
          {/* «Все» — обычный переключатель: клик по надписи делает то же, что
              клик по квадратику (снять всё / выбрать всё). У отдельных групп
              логика другая — там клик по названию оставляет только эту группу. */}
          <span
            onClick={() => setAllGroupsVisible(visibleGroupIds.size !== orderedGroups.length)}
            style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            title={visibleGroupIds.size === orderedGroups.length ? 'Снять все' : 'Показать все группы'}
          >
            Все
          </span>
        </span>
        <div style={{
          display: 'grid',
          gridAutoFlow: 'column',
          gridTemplateRows: `repeat(${checkboxRows}, auto)`,
          columnGap: 20,
          rowGap: 4,
        }}>
          {orderedGroups.map(group => (
            // align-items:center — иначе у названий, занимающих 2–3 строки,
            // квадратик прижимается к первой строке и «съезжает» вверх.
            <span key={group.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Checkbox
                checked={visibleGroupIds.has(group.id)}
                onChange={e => toggleGroupVisible(group.id, e.target.checked)}
              />
              <span
                onClick={() => setVisibleGroups(new Set([group.id]))}
                title={group.protectedFromBulk
                  ? 'Показать только эту группу. Настройки связи защищены от массовой записи/сброса — меняйте вручную, по одному параметру'
                  : 'Показать только эту группу'}
                style={{
                  fontSize: 12, lineHeight: 1.3, cursor: 'pointer',
                  fontWeight: (group.id === FAV_GROUP_ID || group.id === DEBUG_GROUP_ID) ? 600 : undefined,
                }}
              >
                {group.name}
                {group.protectedFromBulk && (
                  <Tag color="gold" style={{ fontSize: 10, marginLeft: 4, padding: '0 4px', lineHeight: '16px' }}>
                    только вручную
                  </Tag>
                )}
              </span>
            </span>
          ))}
        </div>
        {/* Управление составом избранного — рядом с чекбоксами групп */}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button size="small" icon={<ToolOutlined />} onClick={openFavModal}>
            {favoriteParams.length > 0 ? `Изменить «Отладку» (${favoriteParams.length})` : 'Собрать группу «Отладка»'}
          </Button>
          {favoriteParams.length > 0 && (
            <>
              <Button size="small" icon={<FileTextOutlined />} onClick={() => { setFavPresetName(''); setFavPresetOpen(true) }}>
                Создать шаблон из «Отладки»
              </Button>
              <Popconfirm
                title="Очистить группу «Отладка»?"
                description={`Из группы «🔧 Отладка» будут убраны все ${favoriteParams.length} параметров. Сами параметры и их значения не тронуты.`}
                okText="Очистить"
                cancelText="Отмена"
                okButtonProps={{ danger: true }}
                onConfirm={clearFavorites}
              >
                <Button size="small" danger>Очистить «Отладку»</Button>
              </Popconfirm>
            </>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            «★ Избранное» — постоянный набор из шаблона модели (не меняется). «🔧 Отладка» — рабочая группа: соберите под текущую задачу, потом очистите
          </Typography.Text>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={filteredGroups.map(g => g.id)} strategy={verticalListSortingStrategy}>
          <div style={{ paddingLeft: 20 }}>
            {filteredGroups.map((group) => {
              const item = items.find(it => it.key === group.id)
              if (!item) return null
              const isOpen = query ? true : openGroupIds.has(group.id)
              const groupIndex = filteredGroups.indexOf(group)
              return (
                <SortableCollapseItem key={group.id} id={group.id}>
                  <Collapse
                    items={[item]}
                    activeKey={isOpen ? [group.id] : []}
                    destroyOnHidden
                    onChange={keys => {
                      setOpenGroupIds(prev => {
                        const next = new Set(prev)
                        if (keys.length) next.add(group.id)
                        else next.delete(group.id)
                        return next
                      })
                    }}
                    style={{
                      marginBottom: 8,
                      borderLeft: `3px solid ${groupIndex % 2 === 0 ? '#d9e8ff' : '#e8e8e8'}`,
                    }}
                  />
                </SortableCollapseItem>
              )
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* Состав избранного: отмечаем ОТДЕЛЬНЫЕ параметры (не группы целиком) */}
      <AppModal
        title={<Space><ToolOutlined />Состав группы «🔧 Отладка»</Space>}
        open={favModalOpen}
        onCancel={() => setFavModalOpen(false)}
        width={760}
        // Кнопки сохранения вынесены наверх (см. блок ниже) — список параметров
        // длинный, и прокручивать его до низа ради «Сохранить» неудобно.
        footer={null}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Отмечайте нужные параметры по одному — галочка на параметре добавляет ТОЛЬКО его, а не всю его группу.
          Список общий для всех ПЧ семейства {deviceFamilyId === 'vl' ? 'VL' : 'Pump'} и сохраняется между проектами.
        </Typography.Paragraph>
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Input
            prefix={<SearchOutlined style={{ color: '#bbb' }} />}
            placeholder="Поиск параметра по коду или названию"
            value={favSearch}
            onChange={e => setFavSearch(e.target.value)}
            allowClear
            style={{ width: 320 }}
          />
          <Space wrap>
            <Button type="primary" onClick={applyFavDraft}>
              Сохранить ({favDraft.size})
            </Button>
            <Button onClick={() => setFavModalOpen(false)}>Отмена</Button>
            <Button danger onClick={() => setFavDraft(new Set())} disabled={favDraft.size === 0}>
              Очистить всё
            </Button>
          </Space>
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <Collapse
            items={device.groups.map(group => {
              const q = favSearch.trim().toLowerCase()
              const params = q
                ? group.params.filter(p => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
                : group.params
              if (params.length === 0) return null
              const countInFav = group.params.filter(p => favDraft.has(p.id)).length
              // Галочка на самой группе: добавить/убрать разом все её параметры
              // (в пределах текущего фильтра поиска). Отмечена, когда в избранном
              // уже все они; частично — indeterminate.
              const shownIds = params.map(p => p.id)
              const shownInFav = shownIds.filter(id => favDraft.has(id)).length
              const allShownInFav = shownInFav === shownIds.length && shownIds.length > 0
              function toggleWholeGroup(checked) {
                const next = new Set(favDraft)
                if (checked) shownIds.forEach(id => next.add(id))
                else shownIds.forEach(id => next.delete(id))
                setFavDraft(next)
              }
              return {
                key: group.id,
                label: (
                  <Space>
                    {/* stopPropagation — иначе клик по галочке ещё и
                        сворачивал/разворачивал саму секцию Collapse. */}
                    <span onClick={e => { e.stopPropagation() }}>
                      <Checkbox
                        checked={allShownInFav}
                        indeterminate={shownInFav > 0 && !allShownInFav}
                        onChange={e => toggleWholeGroup(e.target.checked)}
                        title="Добавить/убрать всю группу"
                      />
                    </span>
                    <span>{group.name}</span>
                    {countInFav > 0 && <Tag color="gold">{countInFav} в избранном</Tag>}
                  </Space>
                ),
                children: (
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    {params.map(p => (
                      <Checkbox
                        key={p.id}
                        checked={favDraft.has(p.id)}
                        onChange={e => {
                          const next = new Set(favDraft)
                          if (e.target.checked) next.add(p.id)
                          else next.delete(p.id)
                          setFavDraft(next)
                        }}
                      >
                        <Typography.Text code style={{ fontSize: 11 }}>{p.id}</Typography.Text>{' '}
                        <span style={{ fontSize: 12 }}>{p.name}</span>
                      </Checkbox>
                    ))}
                  </Space>
                ),
              }
            }).filter(Boolean)}
          />
        </div>
      </AppModal>

      {/* Шаблон значений из избранного */}
      <AppModal
        title={<Space><FileTextOutlined />Шаблон из избранного</Space>}
        open={favPresetOpen}
        onCancel={() => setFavPresetOpen(false)}
        onOk={createPresetFromFavorites}
        okText="Создать шаблон"
        okButtonProps={{ loading: savingFavPreset }}
        cancelText="Отмена"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Будет создан шаблон значений только из записываемых параметров избранного
          ({favoriteParams.filter(p => isParamWritable(device, p)).length} шт.).
          Значения берутся из текущих подготовленных (или заводских, если ничего не подготовлено).
        </Typography.Paragraph>
        <Input
          placeholder="Название шаблона"
          value={favPresetName}
          onChange={e => setFavPresetName(e.target.value)}
          onPressEnter={createPresetFromFavorites}
        />
      </AppModal>

      {/* Отчёт: какие заводские значения подставить не удалось. Молча пропускать
          их нельзя — оператор должен знать, что эти параметры остались как есть. */}
      <AppModal
        title={<Space><RollbackOutlined />Заводские значения подготовлены не полностью</Space>}
        open={!!factoryReport}
        onCancel={() => setFactoryReport(null)}
        onOk={() => setFactoryReport(null)}
        okText="Понятно"
        cancelButtonProps={{ style: { display: 'none' } }}
        width={720}
      >
        <Typography.Paragraph style={{ fontSize: 13 }}>
          У {factoryReport?.uniqSkipped?.length} параметров заводское значение <b>зависит от исполнения ПЧ</b>
          {' '}(мощности) — в руководстве вместо числа написано «зависит от модели». Подставить их наугад нельзя:
          неверный, например, номинальный ток двигателя приведёт к перегреву и срабатыванию защит.
          Эти параметры оставлены без изменений.
        </Typography.Paragraph>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 10 }}
          message="Что сделать"
          description={
            <>
              1. Укажите исполнение ПЧ в его карточке (кнопка «Изменить» в списке слева) — поле «Модель (мощность)».<br />
              2. Внесите заводские значения для этого исполнения в шаблон модели (поле <code>modelDefaults</code>) — один раз,
              дальше они подставляются во всех проектах автоматически.<br />
              3. Либо задайте эти параметры вручную по шильдику двигателя — это самый надёжный вариант.
            </>
          }
        />
        <Table
          size="small"
          pagination={{ pageSize: 8, size: 'small' }}
          rowKey={(r, i) => `${r.device}-${r.paramId}-${i}`}
          dataSource={factoryReport?.skipped ?? []}
          columns={[
            { title: 'ПЧ', dataIndex: 'device', width: 150 },
            { title: 'Параметр', width: 240, render: (_, r) => `${r.paramId} ${r.name ?? ''}` },
            { title: 'Причина', dataIndex: 'reason' },
          ]}
        />
      </AppModal>

      <AppModal
        title={<Space><FileTextOutlined />Подготовить значения из шаблона</Space>}
        open={presetModalOpen}
        onCancel={() => setPresetModalOpen(false)}
        onOk={applyPreset}
        okText={`Подготовить для ${effectiveDeviceIds.length} устр.`}
        okButtonProps={{ disabled: !selectedPresetId, loading: applyingPreset }}
        cancelText="Отмена"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Значения из выбранного шаблона будут подготовлены (записаны в черновик, но не в ПЧ) у {effectiveDeviceIds.length === 1 ? 'этого устройства' : `всех выбранных устройств (${effectiveDeviceIds.length})`}.
          Уже подготовленные вручную значения других параметров не тронутся; фактическая запись — обычной кнопкой «Записать группу»/«Записать все».
        </Typography.Paragraph>
        <Select
          style={{ width: '100%' }}
          placeholder={presets.length ? 'Выберите шаблон' : `Нет сохранённых шаблонов для ${family === 'vl' ? 'VL' : 'Pump'} — создайте на вкладке «Шаблоны»`}
          value={selectedPresetId}
          onChange={setSelectedPresetId}
          options={presets.map(p => ({ value: p.id, label: `${p.name} (${Object.keys(p.values).length} рег.)` }))}
          notFoundContent="Нет шаблонов для этого типа ПЧ"
        />
      </AppModal>
    </>
  )
}
