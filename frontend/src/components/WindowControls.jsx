import { useState, useEffect } from 'react'

// Кнопки управления окном — свернуть / развернуть / закрыть.
//
// Окно собранной программы идёт без рамки Windows (frame: false), поэтому
// родных кнопок в правом верхнем углу нет и рисуем их сами. Вид — как в
// VS Code: узкие кнопки, прижатые к самому верху правого угла, и тонкие
// штриховые значки, а не залитые иконки из набора antd (те в шапке смотрелись
// крупными и «тяжёлыми»). Красный «крестик» при наведении — как в Windows.
//
// В браузере (запуск как обычный локальный сервер) моста в главный процесс нет —
// компонент просто ничего не рисует.

// Значки рисуем сами: 10×10, обводка в 1 px по currentColor. Готовые наборы
// иконок дают залитые глифы другого веса — рядом с тонкой рамкой окна это
// заметно.
const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1 }

function Glyph({ children }) {
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">{children}</svg>
}

const ICONS = {
  minimize: <Glyph><path d="M0 5h10" {...STROKE} /></Glyph>,
  maximize: <Glyph><rect x="0.5" y="0.5" width="9" height="9" {...STROKE} /></Glyph>,
  // «Восстановить» — два квадрата уступом: передний целиком, задний виден
  // только верхней и правой сторонами.
  restore: (
    <Glyph>
      <path d="M2.5 2.5V0.5h7v7h-2" {...STROKE} />
      <rect x="0.5" y="2.5" width="7" height="7" {...STROKE} />
    </Glyph>
  ),
  close: <Glyph><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" {...STROKE} /></Glyph>,
}

// Узкие и низкие, как в VS Code: 40×30 вместо кнопки во всю высоту шапки.
const BUTTON = {
  width: 40, height: 30, border: 'none', background: 'transparent',
  color: '#fff', cursor: 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

function CaptionButton({ title, icon, onClick, danger }) {
  const paint = (e, color) => { e.currentTarget.style.background = color }
  return (
    <button
      type="button" title={title} style={BUTTON} onClick={onClick}
      onMouseEnter={e => paint(e, danger ? '#e81123' : '#ffffff26')}
      onMouseLeave={e => paint(e, 'transparent')}
    >
      {icon}
    </button>
  )
}

export default function WindowControls() {
  const api = typeof window !== 'undefined' ? window.modbusDesktop?.windowControls : null
  const [maximized, setMaximized] = useState(false)

  useEffect(() => api?.onState?.(s => setMaximized(!!s.maximized)), [api])

  if (!api) return null

  return (
    <div style={{ display: 'flex' }}>
      <CaptionButton title="Свернуть" icon={ICONS.minimize} onClick={() => api.minimize()} />
      <CaptionButton
        title={maximized ? 'Восстановить размер' : 'Развернуть'}
        icon={maximized ? ICONS.restore : ICONS.maximize}
        onClick={() => api.toggleMaximize()}
      />
      {/* Закрытие — красным при наведении: единственная кнопка здесь, нажатие
          которой нельзя отменить. */}
      <CaptionButton title="Закрыть" icon={ICONS.close} onClick={() => api.close()} danger />
    </div>
  )
}
