// Общие хелперы CSV — используются и экспортом "Текущие параметры" (ParamGroups),
// и экспортом/импортом шаблонов значений (ValuePresets), чтобы формат файла
// (разделитель, кавычки, BOM для кириллицы в Excel) был одинаковым и они могли
// читать файлы друг друга.
const DELIM = ';'
const BOM = '﻿'

// Короткая метка группы для имени CSV-файла: если id — это код (F0/P8/D0),
// берём его как есть; иначе (напр. "vfd-control") — человекочитаемое имя группы
// ("Управление ПЧ" → "Управление_ПЧ").
export function groupFileLabel(group) {
  if (/^[A-Za-z]+\d+$/.test(group.id)) return group.id
  return String(group.name).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '')
}

export function downloadCsv(filename, header, rows) {
  const escape = v => `"${String(v).replace(/"/g, '""')}"`
  const csv = [header, ...rows].map(r => r.map(escape).join(DELIM)).join('\r\n')
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Построчный CSV-парсер с поддержкой кавычек; разделитель (';' или ',')
// определяется по первой строке — этого достаточно для файлов, которые
// экспортирует само приложение или сохраняют из Excel.
export function parseCsv(text) {
  const clean = text.startsWith(BOM) ? text.slice(BOM.length) : text
  const lines = clean.split(/\r\n|\n|\r/).filter(l => l.length > 0)
  if (lines.length === 0) return []
  const delim = lines[0].includes(';') ? ';' : ','

  function parseLine(line) {
    const cells = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++ }
          else inQuotes = false
        } else cur += ch
      } else if (ch === '"') {
        inQuotes = true
      } else if (ch === delim) {
        cells.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    cells.push(cur)
    return cells
  }

  return lines.map(parseLine)
}
