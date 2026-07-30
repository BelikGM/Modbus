import { useEffect, useRef } from 'react'

// Полоса меню (Файл / Правка / Вид / Окно / Справка) в окне без рамки Windows.
//
// Постоянно висеть сверху ей незачем — нужна она редко: папка данных, «О
// программе», масштаб, инструменты разработчика. Поэтому меню скрыто, а
// показывается, когда мышь доводят до самого верха окна: вдоль верхнего края
// лежит невидимая полоска в несколько пикселей, наведение на неё просит главный
// процесс показать меню.
//
// Прячем по обратному признаку — курсор ушёл от верха вниз. Пока он в самом
// меню, страница событий мыши не получает (там рисует Windows), поэтому меню
// спокойно остаётся на месте, пока по нему ходят.
//
// Alt работает как и раньше: это встроенное поведение autoHideMenuBar.

const ZONE_HEIGHT = 4    // насколько узкая полоска ловит наведение
const HIDE_BELOW = 80    // ниже этой отметки меню уже точно не нужно

export default function MenuHotZone() {
  const api = typeof window !== 'undefined' ? window.modbusDesktop?.menuBar : null
  const shown = useRef(false)

  useEffect(() => {
    if (!api) return
    function onMove(e) {
      if (!shown.current || e.clientY <= HIDE_BELOW) return
      shown.current = false
      api.hide()
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [api])

  if (!api) return null

  return (
    <div
      onMouseEnter={() => { shown.current = true; api.show() }}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: ZONE_HEIGHT,
        zIndex: 2000,
        // Полоска должна ловить мышь, а не отдавать её перетаскиванию окна.
        WebkitAppRegion: 'no-drag',
      }}
    />
  )
}
