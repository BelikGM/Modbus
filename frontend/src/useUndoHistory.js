import { useState, useRef, useEffect } from 'react'

// Отмена действий (Ctrl+Z) для редактируемого черновика.
//
// Хук возвращает ОБЁРТКУ над сеттером состояния: снимок «как было» кладётся в
// историю прямо в обработчике, а не в эффекте по факту изменения — так история
// не зависит от порядка перерисовок и не плодит лишних рендеров.
//
// Правки, идущие подряд без паузы (набор текста в поле), считаются одним
// действием: иначе отмена откатывала бы по одной букве и до нужного состояния
// пришлось бы жать Ctrl+Z полсотни раз. Затянувшийся набор всё же разбивается
// на шаги (BURST_MS), чтобы одно «действие» не выросло до нескольких минут.
const COALESCE_MS = 500   // пауза, после которой правка считается новым действием
const BURST_MS = 3000     // максимальная длина одного «слитного» действия
const LIMIT = 50          // сколько шагов помним

export default function useUndoHistory(value, setValue, enabled = true) {
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  // Только тайминги — на отрисовку не влияют, поэтому рефы.
  const changeAt = useRef(0)
  const pushAt = useRef(0)

  function resetTiming() { changeAt.current = 0; pushAt.current = 0 }

  function reset() {
    resetTiming()
    setPast([])
    setFuture([])
  }

  // Обёртка вместо исходного setState: принимает и значение, и функцию-апдейтер.
  // null означает «закрыли редактор» — историю прошлого черновика забываем,
  // иначе Ctrl+Z в следующем открытии восстановил бы чужой тип.
  function set(next) {
    if (next == null) { reset(); setValue(next); return }
    if (value != null) {
      const now = Date.now()
      const sinceChange = now - changeAt.current
      const sincePush = now - pushAt.current
      changeAt.current = now
      if (sinceChange >= COALESCE_MS || sincePush >= BURST_MS) {
        pushAt.current = now
        setPast(p => [...p, value].slice(-LIMIT))
        setFuture(f => (f.length ? [] : f))
      }
    }
    setValue(next)
  }

  function undo() {
    if (!past.length) return
    resetTiming()   // следующая правка — заведомо новое действие
    setFuture(f => [...f, value])
    setPast(p => p.slice(0, -1))
    setValue(past[past.length - 1])
  }

  function redo() {
    if (!future.length) return
    resetTiming()
    setPast(p => [...p, value])
    setFuture(f => f.slice(0, -1))
    setValue(future[future.length - 1])
  }

  // Горячие клавиши вешаем на окно: правка идёт в полях ввода, таблицах и
  // модалках — общего DOM-узла, которому можно было бы отдать фокус, нет.
  // Обработчики читаем через реф, чтобы подписка не пересоздавалась на каждый
  // рендер, но при этом всегда работала со свежим состоянием.
  const latest = useRef(null)
  useEffect(() => { latest.current = { undo, redo, active: enabled && value != null } })

  useEffect(() => {
    function onKey(e) {
      if (!(e.ctrlKey || e.metaKey) || !latest.current?.active) return
      const k = (e.key ?? '').toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); latest.current.undo() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); latest.current.redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    set,
    undo,
    redo,
    reset,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    steps: past.length,
  }
}
