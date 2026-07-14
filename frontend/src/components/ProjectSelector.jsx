import { useState, useEffect, useRef } from 'react'
import {
  Dropdown, Button, Modal, Form, Input, Space, Popconfirm,
  message, Alert, Typography, Select, AutoComplete, Tag,
} from 'antd'
import {
  PlusOutlined, FolderOpenOutlined, DownOutlined,
  EditOutlined, DeleteOutlined, ImportOutlined, ExportOutlined,
  WarningOutlined, RollbackOutlined, CheckOutlined, DisconnectOutlined,
} from '@ant-design/icons'
import api from '../api'
import socket from '../socket'

export default function ProjectSelector({ onProjectChange, onProjectInit }) {
  const [projects, setProjects]       = useState([])
  const [portRequired, setPortRequired] = useState(null) // { projectId, lastPort? }
  const [ports, setPorts]             = useState([])
  const [selectedPort, setSelectedPort] = useState(null)
  const [baudRate, setBaudRate]       = useState(9600)
  const [connecting, setConnecting]   = useState(false)
  const [activeId, setActiveId]       = useState(null)
  const [createOpen, setCreateOpen]   = useState(false)
  const [creating, setCreating]       = useState(false)
  const [editProject, setEditProject] = useState(null)
  const [saving, setSaving]           = useState(false)
  const [mismatches, setMismatches]   = useState([])
  const [fixing, setFixing]           = useState(null) // folderId being fixed
  const [createForm] = Form.useForm()
  const [editForm]   = Form.useForm()
  const importRef    = useRef(null)

  useEffect(() => {
    load()
    socket.on('project:folder:mismatch', setMismatches)
    socket.on('projects:updated', (list) => setProjects(list))
    socket.on('port:required', async ({ projectId, lastPort }) => {
      const { data } = await api.get('/modbus/ports')
      setPorts(data)
      setSelectedPort(lastPort ?? null)
      setPortRequired({ projectId, lastPort })
    })
    return () => {
      socket.off('project:folder:mismatch', setMismatches)
      socket.off('projects:updated')
      socket.off('port:required')
    }
  }, [])

  async function load() {
    try {
      const [{ data: list }, { data: active }] = await Promise.all([
        api.get('/projects'),
        api.get('/projects/active'),
      ])
      setProjects(list)
      const validId = active.id && list.some(p => p.id === active.id) ? active.id : null
      setActiveId(validId)
      onProjectInit?.(validId)
    } catch {}
  }

  async function handleSelect(id) {
    try {
      socket.emit('project:select', { id })
      setActiveId(id)
      onProjectChange?.(id)
    } catch {
      message.error('Не удалось переключить проект')
    }
  }

  async function handlePortConnect() {
    if (!selectedPort) return
    setConnecting(true)
    socket.emit('connect:port', { portPath: selectedPort, baudRate })
    setPortRequired(null)
    setConnecting(false)
  }

  async function handleCreate({ name }) {
    setCreating(true)
    try {
      const { data: project } = await api.post('/projects', { name })
      await api.post('/projects/active', { id: project.id })
      setProjects(prev => [...prev, project])
      setActiveId(project.id)
      onProjectChange?.(project.id)
      setCreateOpen(false)
      createForm.resetFields()
      message.success(`Проект «${name}» создан`)
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Ошибка создания проекта')
    } finally {
      setCreating(false)
    }
  }

  async function handleRename({ name }) {
    setSaving(true)
    try {
      const oldId = editProject.id
      const { data: updated } = await api.patch(`/projects/${oldId}`, { name })
      setProjects(prev => prev.map(p => p.id === oldId ? updated : p))
      if (activeId === oldId) {
        setActiveId(updated.id)
        if (updated.id !== oldId) onProjectChange?.(updated.id)
      }
      setEditProject(null)
      editForm.resetFields()
      message.success('Проект переименован')
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Ошибка переименования')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id) {
    try {
      await api.delete(`/projects/${id}`)
      setProjects(prev => prev.filter(p => p.id !== id))
      if (activeId === id) {
        setActiveId(null)
        onProjectChange?.(null)
      }
      message.success('Проект удалён')
    } catch (e) {
      message.error(e?.response?.data?.message ?? 'Ошибка удаления')
    }
  }

  function openEdit(project) {
    setEditProject(project)
    editForm.setFieldsValue({ name: project.name })
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  function handleExport(id) {
    const a = document.createElement('a')
    a.href = `/api/projects/${id}/export`
    a.download = `${id}.project.json`
    a.click()
  }

  // ─── Import ───────────────────────────────────────────────────────────────

  function handleImportClick() {
    importRef.current.value = ''
    importRef.current.click()
  }

  function handleImportFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async evt => {
      try {
        const content = JSON.parse(evt.target.result)
        const { data: project } = await api.post('/projects/import', { content })
        await api.post('/projects/active', { id: project.id })
        setProjects(prev => [...prev, project])
        setActiveId(project.id)
        onProjectChange?.(project.id)
        message.success(`Проект «${project.name}» импортирован и открыт`)
      } catch (err) {
        message.error(err?.response?.data?.message ?? 'Ошибка импорта файла')
      }
    }
    reader.readAsText(file)
  }

  // ─── Fix mismatch ─────────────────────────────────────────────────────────

  async function handleFix(folderId, action) {
    setFixing(folderId)
    try {
      const { data: updated } = await api.post(`/projects/${folderId}/fix-mismatch`, { action })
      message.success('Исправлено')
      // Update projects list with corrected id/name
      setProjects(prev => {
        const without = prev.filter(p => p.id !== folderId && p.id !== updated.id)
        return [...without, updated]
      })
      if (activeId === folderId && updated.id !== folderId) {
        setActiveId(updated.id)
        onProjectChange?.(updated.id)
      }
      setMismatches(prev => prev.filter(m => m.folderId !== folderId))
      load()
    } catch (err) {
      message.error(err?.response?.data?.message ?? 'Ошибка исправления')
    } finally {
      setFixing(null)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const activeName = projects.find(p => p.id === activeId)?.name ?? 'Выберите проект'

  const menuItems = [
    ...projects.map(p => ({
      key: p.id,
      label: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 180 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
          <Space size={0} onClick={e => e.stopPropagation()}>
            <Button
              type="text" size="small" icon={<ExportOutlined />}
              style={{ color: '#888' }} onClick={() => handleExport(p.id)}
            />
            <Button
              type="text" size="small" icon={<EditOutlined />}
              style={{ color: '#888' }} onClick={() => openEdit(p)}
            />
            <Popconfirm
              title="Удалить проект?"
              description="Все устройства проекта будут удалены."
              okText="Удалить" cancelText="Отмена"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDelete(p.id)}
            >
              <Button type="text" size="small" icon={<DeleteOutlined />} danger />
            </Popconfirm>
          </Space>
        </div>
      ),
    })),
    { type: 'divider' },
    { key: '__new',    icon: <PlusOutlined />,   label: 'Новый проект' },
    { key: '__import', icon: <ImportOutlined />, label: 'Импортировать проект' },
  ]

  function onMenuClick({ key }) {
    if (key === '__new')    setCreateOpen(true)
    else if (key === '__import') handleImportClick()
    else handleSelect(key)
  }

  return (
    <>
      {/* Hidden imports */}
      <input
        type="file" accept=".json" ref={importRef}
        style={{ display: 'none' }} onChange={handleImportFile}
      />

      <Dropdown
        menu={{ items: menuItems, onClick: onMenuClick, selectedKeys: activeId ? [activeId] : [] }}
        trigger={['click']}
      >
        <Space style={{ cursor: 'pointer', userSelect: 'none' }}>
          <FolderOpenOutlined style={{ color: '#fff', fontSize: 14 }} />
          <span style={{ color: '#fff', fontSize: 14 }}>{activeName}</span>
          <DownOutlined style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10 }} />
        </Space>
      </Dropdown>

      {/* Mismatch alert */}
      {mismatches.length > 0 && (
        <Modal
          title={<Space><WarningOutlined style={{ color: '#faad14' }} />Несоответствие имён проекта</Space>}
          open
          footer={null}
          closable={false}
          width={560}
        >
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            Все четыре значения должны совпадать. Выберите, какое из них считать правильным.
          </Typography.Text>

          {mismatches.map(m => {
            const ref = m.folderId  // canonical: folder name
            const alt = m.contentId // alternative: id written in file

            // rows: [label, value, matches-ref]
            const rows = [
              { label: 'Папка',  value: m.folderId,   ok: true },
              { label: 'Файл',   value: m.fileId,      ok: m.fileId    === ref },
              { label: 'id',     value: m.contentId,   ok: m.contentId === ref },
              { label: 'name',   value: m.contentName, ok: m.contentName === ref },
            ]

            return (
              <div key={m.folderId} style={{ border: '1px solid #ffe58f', borderRadius: 8, padding: 14, marginBottom: 12, background: '#fffbe6' }}>

                {/* 4-row comparison table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14, fontSize: 12 }}>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.label}>
                        <td style={{ color: '#888', paddingRight: 8, paddingBottom: 4, width: 50 }}>{r.label}</td>
                        <td style={{ paddingBottom: 4 }}>
                          <Typography.Text code style={{ color: r.ok ? '#389e0d' : '#cf1322' }}>
                            {r.value}
                          </Typography.Text>
                          {!r.ok && <span style={{ color: '#cf1322', marginLeft: 6, fontSize: 11 }}>✗</span>}
                          {r.ok  && <span style={{ color: '#389e0d', marginLeft: 6, fontSize: 11 }}>✓</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <Space wrap>
                  {/* Option A: keep folder name, fix everything else */}
                  <Button
                    size="small"
                    icon={<RollbackOutlined />}
                    loading={fixing === m.folderId}
                    onClick={() => handleFix(m.folderId, 'sync-to-folder')}
                  >
                    Привести всё к папке: <Typography.Text code style={{ fontSize: 11 }}>{ref}</Typography.Text>
                  </Button>

                  {/* Option B: use id from file, rename folder+file, sync name */}
                  {alt && alt !== ref && (
                    <Button
                      size="small"
                      type="primary"
                      icon={<CheckOutlined />}
                      loading={fixing === m.folderId}
                      onClick={() => handleFix(m.folderId, 'rename-to-content')}
                    >
                      Переименовать папку и файл → <Typography.Text code style={{ fontSize: 11, color: '#fff' }}>{alt}</Typography.Text>
                    </Button>
                  )}
                </Space>
              </div>
            )
          })}
        </Modal>
      )}

      {/* Create project */}
      <Modal
        title="Новый проект"
        open={createOpen}
        onCancel={() => { setCreateOpen(false); createForm.resetFields() }}
        onOk={() => createForm.submit()}
        okText="Создать" cancelText="Отмена"
        confirmLoading={creating}
      >
        <Form form={createForm} onFinish={handleCreate} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Название проекта" rules={[{ required: true, message: 'Введите название' }]}>
            <Input placeholder="Например: Завод 1" autoFocus />
          </Form.Item>
        </Form>
      </Modal>

      {/* Port required dialog */}
      <Modal
        title={
          <Space>
            <DisconnectOutlined style={{ color: '#faad14' }} />
            Выберите COM-порт для проекта
          </Space>
        }
        open={!!portRequired}
        onCancel={() => setPortRequired(null)}
        onOk={handlePortConnect}
        okText="Подключить"
        cancelText="Пропустить"
        confirmLoading={connecting}
        okButtonProps={{ disabled: !selectedPort }}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={12}>
          {portRequired?.lastPort && (
            <Alert
              type="warning"
              showIcon
              message={`Порт ${portRequired.lastPort} недоступен или занят`}
            />
          )}
          <Typography.Text type="secondary">
            Выберите COM-порт для подключения к устройствам этого проекта. Если нужного порта нет
            в списке — впишите его имя вручную.
          </Typography.Text>
          <AutoComplete
            style={{ width: '100%' }}
            placeholder="Выберите или впишите порт, напр. COM6"
            value={selectedPort}
            onChange={setSelectedPort}
            options={ports.map(p => ({
              value: p.path,
              label: (
                <Space>
                  <span style={{ color: p.busy ? '#999' : undefined }}>
                    {p.manufacturer ? `${p.path} — ${p.manufacturer}` : p.path}
                  </span>
                  {p.busy && <Tag color="red" style={{ margin: 0, fontSize: 11 }}>занят</Tag>}
                </Space>
              ),
            }))}
          />
          <Space>
            <Typography.Text>Скорость:</Typography.Text>
            <Select
              value={baudRate}
              onChange={setBaudRate}
              style={{ width: 120 }}
              options={[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(v => ({ value: v, label: String(v) }))}
            />
          </Space>
        </Space>
      </Modal>

      {/* Rename project */}
      <Modal
        title="Переименовать проект"
        open={!!editProject}
        onCancel={() => { setEditProject(null); editForm.resetFields() }}
        onOk={() => editForm.submit()}
        okText="Сохранить" cancelText="Отмена"
        confirmLoading={saving}
      >
        <Form form={editForm} onFinish={handleRename} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Название проекта" rules={[{ required: true, message: 'Введите название' }]}>
            <Input autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
