import { parseCsv } from './csv'
import { normalizeOptions } from './paramFormat'
import { isParamWritable } from './access'

// Разбор CSV, ранее выгруженного кнопкой «Скачать все параметры в CSV», обратно
// в подготовленные значения по каждому ПЧ.
//
// Формат файла (см. buildAndDownloadAllCsv в BulkPanel):
//   === EMD-PUMP (2 ПЧ) ===
//   Параметр | Название | EMD-PUMP-1 (Адрес 1) | EMD-PUMP-4 (Адрес 4)
//   F0 — Информационные параметры          <- строка-заголовок группы
//   F1.00 | Предустановленная частота | 50.00 Гц | 45.00 Гц
//
// Сопоставление колонок с устройствами идёт по АДРЕСУ (Slave ID) из заголовка,
// а не по позиции: файл могли отредактировать, переставить колонки, а имя ПЧ —
// переименовать. Адрес — единственный надёжный ключ.

const ADDR_RE = /адрес\s*(\d+)/i

// Значения в файле — человекочитаемые («50.00 Гц», «Предустановленная частота»).
// Возвращает { value } либо { error } с причиной.
function parseCell(param, raw) {
  const text = String(raw ?? '').trim()
  if (!text || text === '—') return { skip: true }
  if (text.toLowerCase() === 'ошибка') return { skip: true }

  if (param.type === 'enum') {
    const opts = normalizeOptions(param.options)
    const hit = opts.find(o => String(o.label).trim().toLowerCase() === text.toLowerCase())
    if (hit) return { value: Number(hit.value) }
    // Допускаем и «сырое» число, если человек вписал код варианта
    const asNum = Number(text.replace(',', '.'))
    if (Number.isFinite(asNum) && opts.some(o => Number(o.value) === asNum)) return { value: asNum }
    return { error: `значение «${text}» не совпадает ни с одним вариантом` }
  }

  if (param.type === 'bitmask') {
    // Битовые маски в файле — набор «имя: значение»; восстанавливать из них
    // число рискованно (легко получить не тот бит), поэтому не импортируем.
    return { error: 'битовая маска — задайте вручную' }
  }

  // Числовые: убираем единицы измерения и разделители разрядов
  const cleaned = text
    .replace(/ |\s/g, ' ')
    .replace(/,/g, '.')
    .replace(/[^\d.\-+eE]/g, ' ')
    .trim()
    .split(' ')[0]
  const num = Number(cleaned)
  if (!Number.isFinite(num)) return { error: `«${text}» — не число` }
  if (param.min !== undefined && num < param.min) return { error: `${num} меньше минимума ${param.min}` }
  if (param.max !== undefined && num > param.max) return { error: `${num} больше максимума ${param.max}` }
  return { value: num }
}

// devices — выбранные ПЧ (по ним ищем совпадение адресов).
// Возвращает: { byDevice: {id: {paramId: value}}, issues: [...], stats, unmatchedColumns }
export function parseParamsCsv(text, devices) {
  const rows = parseCsv(text)
  const byDevice = {}
  const issues = []
  const unmatchedColumns = []
  let matchedColumns = 0
  let applied = 0

  const paramsOf = new Map(devices.map(d => [d.id, new Map(d.groups.flatMap(g => g.params).map(p => [p.id, p]))]))
  const byAddr = new Map(devices.map(d => [Number(d.connection?.slaveId), d]))

  // Текущее сопоставление «индекс колонки -> устройство», меняется на каждой
  // строке заголовков (у каждой секции семейства она своя).
  let colToDevice = new Map()

  for (const row of rows) {
    if (!row || row.length === 0) continue
    const first = String(row[0] ?? '').trim()
    if (!first) continue

    // Строка заголовков секции: «Параметр | Название | <ПЧ> | <ПЧ> ...»
    if (first.toLowerCase() === 'параметр') {
      colToDevice = new Map()
      for (let i = 2; i < row.length; i++) {
        const title = String(row[i] ?? '').trim()
        if (!title) continue
        const m = title.match(ADDR_RE)
        if (!m) { unmatchedColumns.push(title); continue }
        const dev = byAddr.get(Number(m[1]))
        if (!dev) { unmatchedColumns.push(`${title} — нет такого ПЧ среди выбранных`); continue }
        colToDevice.set(i, dev)
        matchedColumns++
      }
      continue
    }

    // Разделитель секции/заголовок группы — колонок со значениями нет
    if (first.startsWith('===')) continue
    if (colToDevice.size === 0) continue

    // Обычная строка параметра: во второй колонке название, дальше значения.
    for (const [colIdx, dev] of colToDevice) {
      const param = paramsOf.get(dev.id)?.get(first)
      if (!param) continue // строка-заголовок группы либо параметр не этой модели
      const cell = row[colIdx]
      if (cell === undefined) continue
      if (!isParamWritable(dev, param)) continue // только чтение — молча мимо

      const res = parseCell(param, cell)
      if (res.skip) continue
      if (res.error) {
        issues.push({ deviceName: dev.name, slaveId: dev.connection?.slaveId, paramId: first, name: param.name, message: res.error })
        continue
      }
      byDevice[dev.id] = { ...(byDevice[dev.id] ?? {}), [first]: res.value }
      applied++
    }
  }

  return {
    byDevice,
    issues,
    unmatchedColumns,
    stats: {
      applied,
      devices: Object.keys(byDevice).length,
      matchedColumns,
      issues: issues.length,
    },
  }
}
