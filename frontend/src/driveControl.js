import { isStopOnly } from './access'

// Управление состоянием привода: определить, работает ли ПЧ, и корректно его
// остановить перед записью параметров, которые нельзя менять на ходу.
//
// Важно: далеко не всё требует остановки. У EMD-VL признак задан в шаблоне
// (access_legend: "X" = «редактирование только во время остановки»), у EMD-PUMP
// таких параметров в документации нет вовсе. Поэтому просто так, «на всякий
// случай», привод не останавливаем — только когда в записи реально есть
// параметры с этим признаком.

export function deviceFamily(templateId) {
  return (templateId ?? '').toLowerCase().includes('vl') ? 'vl' : 'pump'
}

// Параметры из списка, которые требуют остановленного ПЧ.
export function stopOnlyParamsOf(device, paramIds) {
  const byId = new Map(device.groups.flatMap(g => g.params).map(p => [p.id, p]))
  return paramIds
    .map(id => byId.get(id))
    .filter(p => p && isStopOnly(device, p))
}

// Как прочитать состояние привода и как понять «работает».
export function statusParamId() {
  return 'STATUS'
}

// Pump: STATUS — битовая маска, bit1: 0=остановлен, 1=работает.
// VL:   STATUS — перечисление, 1/2 = вращение вперёд/назад, 3 = остановлен.
export function isRunningFromStatus(device, value) {
  if (value === null || value === undefined || typeof value !== 'number') return null // неизвестно
  if (deviceFamily(device.templateId ?? device.id) === 'vl') return value === 1 || value === 2
  return ((Math.round(value) >> 1) & 1) === 1
}

// Команда управляемой остановки: Pump — «СТОП», VL — «Торможение с замедлением»
// (мягкая остановка по рампе, а не выбегом).
export function stopCommandValue(device) {
  return deviceFamily(device.templateId ?? device.id) === 'vl' ? 6 : 1
}
