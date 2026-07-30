import { useState, useEffect } from 'react'
import { MinusOutlined, BorderOutlined, SwitcherOutlined, CloseOutlined } from '@ant-design/icons'

// Кнопки управления окном — свернуть / развернуть / закрыть.
//
// Окно собранной программы идёт без рамки Windows (frame: false), поэтому
// родных кнопок в правом верхнем углу нет и рисуем их сами. Размеры и поведение
// повторяют системные (46×высота шапки, красный «крестик» при наведении), чтобы
// оператор не гадал, куда нажимать.
//
// В браузере (запуск как обычный локальный сервер) моста в главный процесс нет —
// компонент просто ничего не рисует.
export default function WindowControls({ height = 64 }) {
  const api = typeof window !== 'undefined' ? window.modbusDesktop?.windowControls : null
  const [maximized, setMaximized] = useState(false)

  useEffect(() => api?.onState?.(s => setMaximized(!!s.maximized)), [api])

  if (!api) return null

  const base = {
    width: 46, height, border: 'none', background: 'transparent',
    color: '#fff', cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', padding: 0, fontSize: 13,
  }
  const hover = (e, color) => { e.currentTarget.style.background = color }

  return (
    <div style={{ display: 'flex', alignSelf: 'stretch' }}>
      <button
        type="button" title="Свернуть" style={base}
        onMouseEnter={e => hover(e, '#ffffff26')} onMouseLeave={e => hover(e, 'transparent')}
        onClick={() => api.minimize()}
      >
        <MinusOutlined />
      </button>
      <button
        type="button" title={maximized ? 'Восстановить размер' : 'Развернуть'} style={base}
        onMouseEnter={e => hover(e, '#ffffff26')} onMouseLeave={e => hover(e, 'transparent')}
        onClick={() => api.toggleMaximize()}
      >
        {maximized ? <SwitcherOutlined /> : <BorderOutlined />}
      </button>
      {/* Закрытие — красным при наведении, как в Windows: это единственная
          кнопка здесь, нажатие которой нельзя отменить. */}
      <button
        type="button" title="Закрыть" style={base}
        onMouseEnter={e => hover(e, '#e81123')} onMouseLeave={e => hover(e, 'transparent')}
        onClick={() => api.close()}
      >
        <CloseOutlined />
      </button>
    </div>
  )
}
