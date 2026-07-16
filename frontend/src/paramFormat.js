export function normalizeOptions(options) {
  if (!options) return []
  if (Array.isArray(options)) return options
  return Object.entries(options).map(([k, v]) => ({ value: Number(k), label: v }))
}

export function formatParamValue(type, val, unit, options) {
  if (val === null || val === undefined) return '—'
  // Некоторые параметры (напр. "Время ускорения") объявляют default текстом —
  // "Зависит от модели ПЧ" — вместо числа, если завод не документирует общее
  // значение. Показываем как есть, не пытаясь отформатировать как число.
  if (typeof val !== 'number') return String(val)
  if (type === 'enum') {
    const opts = normalizeOptions(options)
    const opt = opts.find(o => o.value === Math.round(val))
    return opt ? opt.label : String(val)
  }
  if (type === 'float') return `${val.toFixed(2)}${unit ? ' ' + unit : ''}`
  return `${val}${unit ? ' ' + unit : ''}`
}
