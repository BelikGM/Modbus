import { Modal } from 'antd'
import useModalEnter from '../useModalEnter'

// Модальное окно приложения = antd Modal + одно общее правило: Enter нажимает
// основную кнопку, если она доступна. Правило живёт здесь, а не в каждом окне,
// чтобы поведение везде было одинаковым и не разъезжалось при добавлении новых
// форм.
//
// По умолчанию основным действием считается onOk. Если у окна свой подвал
// (footer со своими кнопками) и onOk нет — действие передаётся явно через
// onEnter. Отключить поведение для конкретного окна: enterSubmit={false}.
export default function AppModal({ onEnter, enterSubmit = true, ...props }) {
  const submit = onEnter ?? props.onOk
  const blocked = props.okButtonProps?.disabled || props.confirmLoading
  useModalEnter(!!props.open, enterSubmit && !!submit && !blocked, () => submit())
  return <Modal {...props} />
}
