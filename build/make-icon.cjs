// Генератор иконки приложения: build/icon.png (1024×1024, RGBA с прозрачностью).
//
// Почему кодом, а не картинкой в репозитории: нужен ИМЕННО прозрачный фон —
// синяя заливка только внутри знака, всё остальное пустое, иначе ярлык на
// рабочем столе выглядит квадратной наклейкой. Внешних библиотек нет, поэтому
// PNG собирается вручную: zlib есть в самом Node, а фигуры здесь только
// прямоугольные, так что растеризация — это заливка диапазонов пикселей.
//
// ЕСЛИ ЕСТЬ ОРИГИНАЛ ЛОГОТИПА: положите его в build/logo-source.png и запустите
//   node build/make-icon.cjs --from-source
// Тогда фон исходника (сплошной тёмно-синий по углам) станет прозрачным, а сам
// знак сохранится как есть. Без файла рисуется знак по описанию: буква F и
// подпись FBEST синей заливкой на прозрачном фоне.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 1024
const NAVY = [0x00, 0x1a, 0x2e, 0xff]   // тёмно-синий из логотипа
const WHITE = [0xff, 0xff, 0xff, 0xff]

// ── холст ────────────────────────────────────────────────────────────────────
function canvas(size) {
  return { w: size, h: size, px: Buffer.alloc(size * size * 4, 0) }  // 0 = прозрачный
}

function rect(c, x0, y0, x1, y1, color) {
  const xa = Math.max(0, Math.round(x0)), xb = Math.min(c.w, Math.round(x1))
  const ya = Math.max(0, Math.round(y0)), yb = Math.min(c.h, Math.round(y1))
  for (let y = ya; y < yb; y++) {
    let o = (y * c.w + xa) * 4
    for (let x = xa; x < xb; x++, o += 4) {
      c.px[o] = color[0]; c.px[o + 1] = color[1]; c.px[o + 2] = color[2]; c.px[o + 3] = color[3]
    }
  }
}

// Замкнутая ломаная постоянной толщины по списку точек. Все звенья
// горизонтальные или вертикальные, поэтому каждое — просто прямоугольник,
// расширенный на половину толщины поперёк линии.
function polyline(c, pts, t, color) {
  const h = t / 2
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    if (y0 === y1) rect(c, Math.min(x0, x1) - h, y0 - h, Math.max(x0, x1) + h, y0 + h, color)
    else rect(c, x0 - h, Math.min(y0, y1) - h, x0 + h, Math.max(y0, y1) + h, color)
  }
}

// ── мини-шрифт 5×7 для подписи FBEST ─────────────────────────────────────────
const FONT = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
}

function text(c, str, x, y, cell, gap, color) {
  let cx = x
  for (const ch of str) {
    const g = FONT[ch]
    if (!g) { cx += cell * 5 + gap; continue }
    for (let r = 0; r < g.length; r++) {
      for (let k = 0; k < g[r].length; k++) {
        if (g[r][k] === '1') rect(c, cx + k * cell, y + r * cell, cx + (k + 1) * cell, y + (r + 1) * cell, color)
      }
    }
    cx += cell * 5 + gap
  }
  return cx - gap - x   // ширина строки
}

// ── знак: буква F ────────────────────────────────────────────────────────────
function drawMark(c) {
  const x0 = 300, stemW = 150
  const top = 110, bottom = 745
  const topBarW = 470, midBarW = 380
  const barH = 150, midY = 385

  rect(c, x0, top, x0 + stemW, bottom, NAVY)                    // стойка
  rect(c, x0, top, x0 + topBarW, top + barH, NAVY)              // верхняя перекладина
  rect(c, x0, midY, x0 + midBarW, midY + barH, NAVY)            // средняя перекладина

  // Белая линия внутри знака — узнаваемая черта исходного логотипа. Это ОДИН
  // замкнутый контур, повторяющий силуэт буквы с отступом внутрь: у вогнутых
  // углов (под перекладинами) отступ уходит в противоположную сторону, поэтому
  // точки считаются по граням, а не «прямоугольник в прямоугольнике».
  const t = 14, m = 40
  polyline(c, [
    [x0 + m, top + m],
    [x0 + topBarW - m, top + m],
    [x0 + topBarW - m, top + barH - m],
    [x0 + stemW - m, top + barH - m],
    [x0 + stemW - m, midY + m],
    [x0 + midBarW - m, midY + m],
    [x0 + midBarW - m, midY + barH - m],
    [x0 + stemW - m, midY + barH - m],
    [x0 + stemW - m, bottom - m],
    [x0 + m, bottom - m],
  ], t, WHITE)
}

// ── PNG без внешних библиотек ────────────────────────────────────────────────
function crc32(buf) {
  let c, table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(c) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(c.w, 0); ihdr.writeUInt32BE(c.h, 4)
  ihdr[8] = 8      // бит на канал
  ihdr[9] = 6      // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(c.h * (c.w * 4 + 1))
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 4 + 1)] = 0   // фильтр «none»
    c.px.copy(raw, y * (c.w * 4 + 1) + 1, y * c.w * 4, (y + 1) * c.w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── разбор исходного PNG (только для режима --from-source) ───────────────────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('это не PNG')
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]
      if (data[12] !== 0) throw new Error('чересстрочный PNG не поддерживается')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`поддерживается только 8 бит RGB/RGBA (получено depth=${bitDepth}, type=${colorType})`)
  }
  const ch = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(w * h * 4, 255)
  const line = Buffer.alloc(stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0
      const b = prev[i]
      const cc = i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc
      }
      line[i] = v & 0xff
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]
      out[d + 3] = ch === 4 ? line[s + 3] : 255
    }
    line.copy(prev)
  }
  return { w, h, px: out }
}

// Делает фон прозрачным: цвет берётся из угла, стираются близкие к нему пиксели
function knockoutBackground(img, tolerance = 40) {
  const bg = [img.px[0], img.px[1], img.px[2]]
  let cleared = 0
  for (let i = 0; i < img.px.length; i += 4) {
    const d = Math.abs(img.px[i] - bg[0]) + Math.abs(img.px[i + 1] - bg[1]) + Math.abs(img.px[i + 2] - bg[2])
    if (d <= tolerance) { img.px[i + 3] = 0; cleared++ }
  }
  return { bg, cleared, total: img.px.length / 4 }
}

// ── сборка ───────────────────────────────────────────────────────────────────
const outFile = path.join(__dirname, 'icon.png')
const source = path.join(__dirname, 'logo-source.png')

if (process.argv.includes('--from-source')) {
  if (!fs.existsSync(source)) {
    console.error(`Нет файла ${source}. Положите оригинал логотипа туда и повторите.`)
    process.exit(1)
  }
  const img = decodePng(fs.readFileSync(source))
  const r = knockoutBackground(img)
  fs.writeFileSync(outFile, encodePng(img))
  console.log(`Фон rgb(${r.bg.join(',')}) сделан прозрачным: ${(r.cleared / r.total * 100).toFixed(1)}% пикселей`)
  console.log(`Готово: ${outFile} (${img.w}×${img.h})`)
} else {
  const c = canvas(SIZE)
  drawMark(c)
  // Подпись: 7 строк по cell пикселей, поэтому высота = cell*7 — держим её
  // внутри холста с запасом, иначе нижний ряд букв срезается краем иконки.
  const cell = 17, gap = 21
  const width = 5 * cell * 5 + gap * 4
  text(c, 'FBEST', (SIZE - width) / 2, 810, cell, gap, NAVY)
  fs.writeFileSync(outFile, encodePng(c))
  const opaque = (() => { let n = 0; for (let i = 3; i < c.px.length; i += 4) if (c.px[i]) n++; return n })()
  console.log(`Готово: ${outFile} (${SIZE}×${SIZE}), непрозрачных пикселей ${(opaque / (SIZE * SIZE) * 100).toFixed(1)}%`)
}
