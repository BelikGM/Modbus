// Семейство ПЧ — что именно считать «одинаковыми» устройствами.
//
// Семейство определяет, между какими ПЧ разрешены групповые операции: у одного
// семейства должна быть совместимая карта регистров, иначе групповая запись
// уйдёт не в те регистры. Задаётся полем `family` в JSON-типа (корневой
// уровень, рядом с `id` и `name`); `familyLabel` — как его показывать.
//
// Пока поля не было, семейство угадывалось по названию типа (есть ли в нём
// «vl»). Разбор оставлен как запасной путь: свои типы, созданные до появления
// поля, и файлы, принесённые руками, продолжают работать.
export function deviceFamily(device) {
  if (!device) return 'pump'
  if (device.family) return device.family
  return (device.templateId ?? device.id ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

export function familyLabel(device) {
  if (device?.familyLabel) return device.familyLabel
  const f = deviceFamily(device)
  if (f === 'vl') return 'VL'
  if (f === 'pump') return 'Pump'
  return f.charAt(0).toUpperCase() + f.slice(1)
}
