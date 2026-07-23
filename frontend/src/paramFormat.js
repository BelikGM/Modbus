export function normalizeOptions(options) {
  if (!options) return []
  if (Array.isArray(options)) return options
  return Object.entries(options).map(([k, v]) => ({ value: Number(k), label: v }))
}

// Для битовой маски: если подпись значения бита — это осмысленный текст
// ("Прямое", "Остановлен"), она сама по себе понятна и техническое имя бита
// ("direction"/"run") только мешает. Если же это обычный вкл/выкл-флаг —
// смысл несёт ИМЯ бита (S1, FWD, M01...), а не значение, и его надо оставить.
const GENERIC_BIT_LABELS = new Set([
  'вкл', 'выкл', 'включено', 'выключено', 'on', 'off', 'да', 'нет', '0', '1', '—',
])
export function isGenericBitLabel(label) {
  return GENERIC_BIT_LABELS.has(String(label).trim().toLowerCase())
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
      // Перенос строки на каждый бит — читатель этой строки обычно рендерит
      // с white-space:'pre-line', чтобы получился список "имя: значение" по
      // одной строке на бит, а не одна нечитаемая простыня через пробел.
      return bits
        .map(b => {
          const bitVal = (raw >> b.bit) & 1
          const label = b.options?.[String(bitVal)] ?? String(bitVal)
          // осмысленную подпись показываем как есть, вкл/выкл-флаг — с именем бита
          return isGenericBitLabel(label) ? `${b.name}: ${label}` : label
        })
        .join('\n')
    }
    return `0b${Math.round(val).toString(2).padStart(4, '0')}`
  }
  if (type === 'float') return `${val.toFixed(2)}${unit ? ' ' + unit : ''}`
  return `${val}${unit ? ' ' + unit : ''}`
}
