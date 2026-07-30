import { useState, useEffect, useRef } from 'react'
import {
  Collapse, Space, Typography, Input, InputNumber, Select, Button, Table, Tooltip, Tag, message, Empty,
} from 'antd'
import { PlusOutlined, DeleteOutlined, UploadOutlined } from '@ant-design/icons'
import api from '../api'

// Всё, что есть в JSON штатного типа ПЧ, кроме групп параметров: фотографии,
// параметры связи по умолчанию, словарь кодов аварий и пороговые оповещения.
//
// Без этих разделов «свой» тип получался неполноценным: карта регистров есть,
// а фотографии устройства и схемы подключения подставить неоткуда, коды аварий
// не расшифровываются, пороги не срабатывают. Собрать такой тип полностью можно
// было только правкой JSON руками — ровно то, от чего редактор и должен избавить.

const CONDITIONS = [
  { value: 'gt', label: 'больше' },
  { value: 'gte', label: 'больше или равно' },
  { value: 'lt', label: 'меньше' },
  { value: 'lte', label: 'меньше или равно' },
  { value: 'eq', label: 'равно' },
  { value: 'neq', label: 'не равно' },
]

const LEVELS = [
  { value: 'error', label: 'Авария' },
  { value: 'warning', label: 'Предупреждение' },
  { value: 'info', label: 'Сообщение' },
]

const PARITY = [
  { value: 'none', label: 'нет' },
  { value: 'even', label: 'чётность' },
  { value: 'odd', label: 'нечётность' },
]

export default function TemplateExtras({ draft, onChange }) {
  const [images, setImages] = useState([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  const targetRef = useRef('device')   // куда подставить загруженный файл

  useEffect(() => {
    api.get('/devices/images').then(({ data }) => setImages(data ?? [])).catch(() => setImages([]))
  }, [])

  const conn = draft.connection ?? {}
  const errorCodes = Object.entries(draft.errorCodes ?? {})
  const alerts = draft.alerts ?? []
  const paramIds = (draft.groups ?? []).flatMap(g => g.params.map(p => ({ value: p.id, label: `${p.id} — ${p.name}` })))

  function patch(field, value) { onChange({ ...draft, [field]: value }) }
  function patchConn(field, value) { onChange({ ...draft, connection: { ...conn, [field]: value } }) }

  function pickFile(target) {
    targetRef.current = target
    fileRef.current.value = ''      // чтобы повторный выбор того же файла сработал
    fileRef.current.click()
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('не удалось прочитать файл'))
        r.readAsDataURL(file)
      })
      const { data } = await api.post('/devices/images', { name: file.name, dataBase64 })
      onChange({ ...draft, images: { ...(draft.images ?? {}), [targetRef.current]: data.name } })
      setImages(prev => prev.some(i => i.name === data.name) ? prev : [{ name: data.name, custom: true }, ...prev])
      message.success(`Фотография «${data.name}» загружена`)
    } catch (err) {
      message.error(err?.response?.data?.message ?? err.message ?? 'Не удалось загрузить фотографию')
    } finally {
      setUploading(false)
    }
  }

  // Один блок «выбрать из имеющихся / загрузить / посмотреть» — для фото
  // устройства и для схемы подключения он одинаковый
  function imageField(key, label, hint) {
    const value = draft.images?.[key] ?? ''
    return (
      <div style={{ marginBottom: 12 }}>
        <Typography.Text strong style={{ fontSize: 12 }}>{label}</Typography.Text>
        <Space wrap style={{ display: 'flex', marginTop: 4 }}>
          <Select
            showSearch
            allowClear
            style={{ width: 320 }}
            placeholder="Файл не выбран"
            value={value || undefined}
            onChange={v => onChange({ ...draft, images: { ...(draft.images ?? {}), [key]: v ?? '' } })}
            options={images.map(i => ({
              value: i.name,
              label: i.custom ? `${i.name} · своя` : i.name,
            }))}
            filterOption={(input, opt) => opt.value.toLowerCase().includes(input.toLowerCase())}
          />
          <Button icon={<UploadOutlined />} loading={uploading} onClick={() => pickFile(key)}>
            Загрузить
          </Button>
        </Space>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{hint}</Typography.Text>
        </div>
        {value && (
          <img
            src={`/api/devices/images/${encodeURIComponent(value)}`}
            alt={label}
            style={{ maxWidth: 220, maxHeight: 140, marginTop: 6, border: '1px solid #f0f0f0', borderRadius: 4 }}
            onError={e => { e.currentTarget.style.display = 'none' }}
          />
        )}
      </div>
    )
  }

  const items = [
    {
      key: 'images',
      label: <Space>Фотографии {draft.images?.device || draft.images?.wiring ? <Tag color="blue">есть</Tag> : null}</Space>,
      children: (
        <>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
          {imageField('device', 'Фотография устройства', 'Показывается на вкладке «Устройство» в карточке ПЧ')}
          {imageField('wiring', 'Схема подключения', 'Вторая картинка там же — как подключать провода')}
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Загруженные файлы кладутся в папку данных (images) и переживают обновление программы.
            Фотографии из поставки доступны для выбора, но удалить их нельзя.
          </Typography.Text>
        </>
      ),
    },
    {
      key: 'connection',
      label: 'Параметры связи по умолчанию',
      children: (
        <>
          <Space wrap>
            <Select
              style={{ width: 190 }}
              value={conn.baudRate ?? 9600}
              onChange={v => patchConn('baudRate', v)}
              options={[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(v => ({ value: v, label: `${v} бод` }))}
            />
            <Select style={{ width: 150 }} value={conn.dataBits ?? 8} onChange={v => patchConn('dataBits', v)}
              options={[7, 8].map(v => ({ value: v, label: `${v} бит данных` }))} />
            <Select style={{ width: 150 }} value={conn.stopBits ?? 1} onChange={v => patchConn('stopBits', v)}
              options={[1, 2].map(v => ({ value: v, label: `${v} стоп-бит` }))} />
            <Select style={{ width: 170 }} value={conn.parity ?? 'none'} onChange={v => patchConn('parity', v)}
              options={PARITY.map(p => ({ value: p.value, label: `Чётность: ${p.label}` }))} />
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
            Это подсказка для подключения к шине — адрес (Slave ID) у каждого устройства свой
            и задаётся при добавлении ПЧ в проект, а не здесь.
          </Typography.Paragraph>
        </>
      ),
    },
    {
      key: 'errorCodes',
      label: <Space>Коды аварий {errorCodes.length > 0 && <Tag>{errorCodes.length}</Tag>}</Space>,
      children: (
        <>
          <Space style={{ marginBottom: 8 }}>
            <Button size="small" icon={<PlusOutlined />} onClick={() => {
              const used = new Set(Object.keys(draft.errorCodes ?? {}))
              let code = 0
              while (used.has(String(code))) code++
              patch('errorCodes', { ...(draft.errorCodes ?? {}), [code]: '' })
            }}>Добавить код</Button>
          </Space>
          <Table
            size="small"
            rowKey={r => r[0]}
            pagination={{ pageSize: 8, size: 'small', hideOnSinglePage: true }}
            dataSource={errorCodes}
            locale={{ emptyText: <Empty description="Кодов пока нет" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              {
                title: 'Код', width: 110, render: (_, r) => (
                  <InputNumber size="small" value={Number(r[0])} style={{ width: '100%' }}
                    onChange={v => {
                      const next = { ...(draft.errorCodes ?? {}) }
                      const text = next[r[0]]
                      delete next[r[0]]
                      next[String(v ?? 0)] = text
                      patch('errorCodes', next)
                    }} />
                ),
              },
              {
                title: 'Расшифровка', render: (_, r) => (
                  <Input size="small" value={r[1]} placeholder="например: Перегрузка по току"
                    onChange={e => patch('errorCodes', { ...(draft.errorCodes ?? {}), [r[0]]: e.target.value })} />
                ),
              },
              {
                title: '', width: 40, render: (_, r) => (
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => {
                    const next = { ...(draft.errorCodes ?? {}) }
                    delete next[r[0]]
                    patch('errorCodes', next)
                  }} />
                ),
              },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Число из регистра текущей аварии заменяется этим текстом. Это НЕ то же, что оповещения
            ниже: там сравнение с порогом, здесь — расшифровка кода.
          </Typography.Text>
        </>
      ),
    },
    {
      key: 'alerts',
      label: <Space>Пороговые оповещения {alerts.length > 0 && <Tag>{alerts.length}</Tag>}</Space>,
      children: (
        <>
          <Space style={{ marginBottom: 8 }}>
            <Button size="small" icon={<PlusOutlined />} disabled={paramIds.length === 0} onClick={() => patch('alerts', [
              ...alerts,
              { id: `alert-${alerts.length + 1}`, paramId: paramIds[0]?.value, condition: 'gt', threshold: 0, level: 'warning', message: '' },
            ])}>Добавить оповещение</Button>
            {paramIds.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>Сначала добавьте параметры</Typography.Text>
            )}
          </Space>
          <Table
            size="small"
            rowKey={(_, i) => i}
            pagination={{ pageSize: 6, size: 'small', hideOnSinglePage: true }}
            dataSource={alerts}
            locale={{ emptyText: <Empty description="Оповещений пока нет" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              {
                title: 'Параметр', width: 200, render: (_, a, i) => (
                  <Select size="small" style={{ width: '100%' }} showSearch value={a.paramId} options={paramIds}
                    filterOption={(inp, o) => o.label.toLowerCase().includes(inp.toLowerCase())}
                    onChange={v => patch('alerts', alerts.map((x, j) => j === i ? { ...x, paramId: v } : x))} />
                ),
              },
              {
                title: 'Условие', width: 150, render: (_, a, i) => (
                  <Select size="small" style={{ width: '100%' }} value={a.condition} options={CONDITIONS}
                    onChange={v => patch('alerts', alerts.map((x, j) => j === i ? { ...x, condition: v } : x))} />
                ),
              },
              {
                title: 'Порог', width: 100, render: (_, a, i) => (
                  <InputNumber size="small" style={{ width: '100%' }} value={a.threshold}
                    onChange={v => patch('alerts', alerts.map((x, j) => j === i ? { ...x, threshold: v } : x))} />
                ),
              },
              {
                title: 'Уровень', width: 160, render: (_, a, i) => (
                  <Select size="small" style={{ width: '100%' }} value={a.level} options={LEVELS}
                    onChange={v => patch('alerts', alerts.map((x, j) => j === i ? { ...x, level: v } : x))} />
                ),
              },
              {
                title: 'Текст', render: (_, a, i) => (
                  <Tooltip title="{{value}} подставит текущее значение параметра">
                    <Input size="small" value={a.message} placeholder="Перегрев: {{value}} °C"
                      onChange={e => patch('alerts', alerts.map((x, j) => j === i ? { ...x, message: e.target.value } : x))} />
                  </Tooltip>
                ),
              },
              {
                title: '', width: 40, render: (_, __, i) => (
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}
                    onClick={() => patch('alerts', alerts.filter((_, j) => j !== i))} />
                ),
              },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Проверяются, пока запущен мониторинг. Параметр обязан существовать именно в этом типе —
            скопированное между разными моделями оповещение указывает не на тот регистр.
          </Typography.Text>
        </>
      ),
    },
    {
      key: 'factoryReset',
      label: <Space>Команда сброса на заводские {draft.factoryReset?.paramId && <Tag color="blue">задана</Tag>}</Space>,
      children: (
        <Space wrap>
          <Select
            showSearch allowClear style={{ width: 300 }} placeholder="Параметр команды"
            value={draft.factoryReset?.paramId} options={paramIds}
            filterOption={(inp, o) => o.label.toLowerCase().includes(inp.toLowerCase())}
            onChange={v => {
              if (!v) { patch('factoryReset', undefined); return }
              const p = (draft.groups ?? []).flatMap(g => g.params).find(x => x.id === v)
              patch('factoryReset', { ...(draft.factoryReset ?? {}), paramId: v, register: p?.register })
            }}
          />
          <InputNumber
            addonBefore="Значение" style={{ width: 190 }}
            value={draft.factoryReset?.value}
            onChange={v => patch('factoryReset', { ...(draft.factoryReset ?? {}), value: v })}
          />
        </Space>
      ),
    },
  ]

  return <Collapse size="small" items={items} style={{ marginBottom: 12 }} />
}
