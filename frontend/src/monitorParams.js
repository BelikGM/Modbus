// Список и порядок параметров для карточек/таблицы мониторинга — не просто
// "все read-параметры группы подряд", а осмысленный порядок: сначала частота/
// ток (самое важное для оценки режима работы), затем связанные с ними сигналы
// задания FIV/FIC, потом температура и остальные показания, затем сводный
// статус ПЧ (направление/разгон-торможение) и маски дискретных входов/выходов,
// затем код текущей аварии и архивные записи истории аварий (это снимки на
// момент прошлой аварии, не текущее состояние, потому и в конце). Обратная
// связь ПИД-регулятора (F0.07) исключена — почти всегда 0 у типовой настройки
// насоса без ПИД и только замусоривает экран.
const PUMP_ORDER = [
  'F0.01', 'F0.02', 'F0.03',        // заданная/выходная частота, ток
  'F0.23', 'F0.24',                  // сигналы FIV/FIC
  'F0.06',                            // температура ПЧ
  'F0.04', 'F0.05', 'F0.09',        // об/мин, напряжение ЗПТ, выходное напряжение
  'STATUS',                           // сводный статус (направление/пуск-стоп)
  'F0.21', 'F0.22',                  // состояние дискретных входов/выходов (маски), соседними строками
  'F0.27',                            // текущий код аварийного состояния
  'F0.10', 'F0.11', 'F0.12', 'F0.13', // записи об авариях (архив)
  'F0.08',                            // наработка
]
const PUMP_EXCLUDE = new Set(['F0.00', 'F0.07'])

const VL_ORDER = [
  'D0.01', 'D0.00', 'D0.04',        // заданная/выходная частота, ток
  'D0.09', 'D0.10',                  // сигналы FIV/FIC
  'D0.02', 'D0.03',                  // напряжение ЗПТ, выходное напряжение
  'D0.14', 'D0.05', 'D0.06',        // скорость двигателя, мощность, момент
  'D0.61',                            // сводный статус (направление/разгон-торможение/перенапряжение)
  'D0.07',                            // состояние дискретных входов (маска)
  'D0.45',                            // информация об ошибке
]

function findMonitorGroup(device) {
  return device.groups.find(g => g.id === 'F0')
    ?? device.groups.find(g => g.id === 'D0')
    ?? device.groups.find(g => g.params?.some(p => p.access === 'read' && ['float', 'integer', 'bitmask'].includes(p.type)))
}

// bitmask-параметр без описания битов нельзя расшифровать (у Pump в группе F0
// есть именно такой "голый" дубль регистра 28 без bits — рабочая версия с
// полным описанием битов лежит в отдельной группе vfd-modbus/vfd-control под
// именем STATUS, её и подмешиваем ниже вместо него).
function isDisplayableBitmask(p) {
  return p.type !== 'bitmask' || (Array.isArray(p.bits) && p.bits.length > 0)
}

export function getMonitorParams(device) {
  const group = findMonitorGroup(device)
  if (!group) return []
  const isVl = group.id === 'D0'
  const order = isVl ? VL_ORDER : PUMP_ORDER
  const exclude = isVl ? new Set() : PUMP_EXCLUDE
  let eligible = group.params.filter(
    p => p.access === 'read' && !exclude.has(p.id) && ['float', 'integer', 'bitmask'].includes(p.type) && isDisplayableBitmask(p),
  )
  // Сводный статус ПЧ (направление/пуск-стоп/разгон-торможение) у Pump лежит
  // не в группе F0, а в отдельной служебной группе (STATUS, тот же регистр 28,
  // но с полным описанием битов) — у VL аналогичный параметр (D0.61) уже
  // внутри группы D0 и попадает в eligible сам. Подмешиваем StatUS явно, чтобы
  // у обоих семейств мониторинг показывал одинаково содержательную картину.
  if (!isVl) {
    const statusParam = device.groups
      .flatMap(g => g.params)
      .find(p => p.id === 'STATUS' && isDisplayableBitmask(p));
    if (statusParam && !eligible.some(p => p.id === statusParam.id)) eligible = [...eligible, statusParam]
  }
  return eligible.slice().sort((a, b) => {
    const ai = order.indexOf(a.id)
    const bi = order.indexOf(b.id)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })
}
