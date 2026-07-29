import { Drawer, List, Typography, Button, Space, Tag, Empty, Badge } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
  DeleteOutlined,
  DownloadOutlined,
} from '@ant-design/icons'
import { useLog, clearLog } from '../log'
import { downloadCsv } from '../csv'

const ICONS = {
  success: <CheckCircleOutlined style={{ color: '#52c41a', marginTop: 2 }} />,
  error:   <CloseCircleOutlined  style={{ color: '#ff4d4f', marginTop: 2 }} />,
  warning: <WarningOutlined      style={{ color: '#fa8c16', marginTop: 2 }} />,
  info:    <InfoCircleOutlined   style={{ color: '#1677ff', marginTop: 2 }} />,
}

const LEVEL_LABEL = { success: 'Успех', error: 'Ошибка', warning: 'Предупреждение', info: 'Информация' }

export default function LogDrawer({ open, onClose, projectName }) {
  const entries = useLog()
  const errorCount = entries.filter(e => e.level === 'error').length

  // Выгрузка журнала в CSV: имя файла — «<проект>-журнал-<дата>.csv».
  // Записи идут в хронологическом порядке (в списке — новые сверху, в файле
  // удобнее читать сверху вниз по времени).
  function exportLogCsv() {
    const rows = [...entries].reverse().map(e => {
      const d = e.ts ? new Date(e.ts) : null
      return [
        d ? d.toLocaleDateString('ru-RU') : '',
        e.time ?? (d ? d.toLocaleTimeString('ru-RU') : ''),
        LEVEL_LABEL[e.level] ?? e.level,
        e.message,
      ]
    })
    const safeProject = String(projectName || 'проект').replace(/[^\p{L}\p{N}_-]+/gu, '_')
    const today = new Date().toISOString().slice(0, 10)
    downloadCsv(
      `${safeProject}-журнал-${today}.csv`,
      ['Дата', 'Время', 'Уровень', 'Событие'],
      rows,
    )
  }

  return (
    <Drawer
      title={
        <Space>
          Журнал операций
          <Tag>{entries.length}</Tag>
          {errorCount > 0 && <Tag color="error">{errorCount} ошибок</Tag>}
        </Space>
      }
      open={open}
      onClose={onClose}
      size={460}
      extra={
        <Space>
          <Button size="small" icon={<DownloadOutlined />} onClick={exportLogCsv} disabled={!entries.length}>
            Скачать CSV
          </Button>
          <Button size="small" icon={<DeleteOutlined />} onClick={clearLog} disabled={!entries.length}>
            Очистить
          </Button>
        </Space>
      }
      styles={{ body: { padding: '8px 16px' } }}
    >
      {entries.length === 0 ? (
        <Empty description="Журнал пуст" style={{ marginTop: 60 }} />
      ) : (
        <List
          dataSource={entries}
          renderItem={entry => (
            <List.Item style={{ padding: '5px 0', borderBottom: '1px solid #f5f5f5' }}>
              <Space align="start" size={8} style={{ width: '100%' }}>
                <div style={{ paddingTop: 1 }}>{ICONS[entry.level]}</div>
                <div style={{ flex: 1 }}>
                  <Typography.Text style={{ fontSize: 13 }}>{entry.message}</Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>{entry.time}</Typography.Text>
                </div>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Drawer>
  )
}
