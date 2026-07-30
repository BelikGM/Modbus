import { useEffect, useRef } from 'react'

// Enter в модальном окне = нажать его основную кнопку.
//
// Раньше так вела себя только форма подключения к COM-порту (там обработчик был
// вписан руками). Наладчик заполняет десятки таких форм подряд, и тянуться
// мышкой к кнопке после каждого поля — лишняя работа.
//
// Открытых окон может быть несколько (например, редактор вариантов значения
// поверх редактора типа), поэтому окна складываются в стек и клавишу
// обрабатывает только верхнее — иначе Enter во вложенном окне сохранял бы ещё
// и нижнее, закрывая обе формы разом.
const stack = []
let installed = false

// Случаи, когда Enter принадлежит не окну, а тому, что под курсором/фокусом.
function belongsToField(e) {
  if (e.isComposing || e.keyCode === 229) return true          // набор через IME
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return true
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true                          // многострочное поле: Enter = перенос строки
  if (tag === 'BUTTON' || tag === 'A') return true             // на кнопке Enter нажимает саму кнопку
  if (el.isContentEditable) return true
  // Открытый список выбора: Enter выбирает вариант, а не сохраняет форму
  if (el.closest?.('.ant-select-open, .ant-cascader-open, .ant-picker-focused')) return true
  return false
}

function onKey(e) {
  if (e.key !== 'Enter' || e.defaultPrevented || belongsToField(e)) return
  const top = stack[stack.length - 1]
  if (!top?.current?.canSubmit) return
  e.preventDefault()
  top.current.onSubmit()
}

export default function useModalEnter(open, canSubmit, onSubmit) {
  const ref = useRef({ canSubmit, onSubmit })
  useEffect(() => { ref.current = { canSubmit, onSubmit } })

  useEffect(() => {
    if (!open) return
    stack.push(ref)
    if (!installed) { window.addEventListener('keydown', onKey); installed = true }
    return () => {
      const i = stack.lastIndexOf(ref)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [open])
}
