import { notification } from 'antd'
import { LoadingOutlined, CheckCircleOutlined, CloseCircleOutlined, InfoCircleOutlined } from '@ant-design/icons'

// Единый механизм «оператор не в неведении»: у долгого процесса своё уведомление
// с жёлтым крутящимся значком и описанием, которое по завершении превращается в
// зелёную галочку (или красный крест при ошибке). Уведомление обновляется ПО
// КЛЮЧУ (тот же key = та же карточка меняется на месте, а не плодит новые).
let seq = 0

export function processStart(description, message = 'Выполняется…') {
  const key = `proc-${++seq}`
  notification.open({
    key,
    message,
    description,
    icon: <LoadingOutlined spin style={{ color: '#faad14' }} />,
    duration: 0,
    placement: 'bottomRight',
  })
  return key
}

export function processUpdate(key, description, message = 'Выполняется…') {
  notification.open({
    key,
    message,
    description,
    icon: <LoadingOutlined spin style={{ color: '#faad14' }} />,
    duration: 0,
    placement: 'bottomRight',
  })
}

export function processDone(key, description, message = 'Готово') {
  notification.open({
    key,
    message,
    description,
    icon: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
    duration: 4,
    placement: 'bottomRight',
  })
}

export function processInfo(key, description, message = 'Остановлено') {
  notification.open({
    key,
    message,
    description,
    icon: <InfoCircleOutlined style={{ color: '#1677ff' }} />,
    duration: 4,
    placement: 'bottomRight',
  })
}

export function processError(key, description, message = 'Ошибка') {
  notification.open({
    key,
    message,
    description,
    icon: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,
    duration: 6,
    placement: 'bottomRight',
  })
}
