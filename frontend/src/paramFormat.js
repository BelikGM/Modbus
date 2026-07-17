export function normalizeOptions(options) {
  if (!options) return []
  if (Array.isArray(options)) return options
  return Object.entries(options).map(([k, v]) => ({ value: Number(k), label: v }))
}

export function formatParamValue(type, val, unit, options, bits) {
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
  if (type === 'bitmask') {
    if (Array.isArray(bits) && bits.length) {
      const raw = Math.round(val)
      return bits
        .map(b => {
          const bitVal = (raw >> b.bit) & 1
          const label = b.options?.[String(bitVal)] ?? String(bitVal)
          return `${b.name}:${label}`
        })
        .join(' ')
    }
    return `0b${Math.round(val).toString(2).padStart(4, '0')}`
  }
  if (type === 'float') return `${val.toFixed(2)}${unit ? ' ' + unit : ''}`
  return `${val}${unit ? ' ' + unit : ''}`
}
