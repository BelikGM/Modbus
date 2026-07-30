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

// ── Вырезание фона у исходного логотипа ─────────────────────────────────────
//
// В исходнике всего два цвета: тёмно-синий фон и белые линии. Буквы НЕ залиты
// отдельным цветом — они лишь ОБВЕДЕНЫ линиями, причём обводка разомкнута
// (у знака это фирменная черта). Поэтому «стереть цвет фона» здесь не работает:
// от логотипа остались бы одни тонкие линии.
//
// Определять, где буква, приходится геометрией:
//  • большая F — её левый и верхний края вообще не нарисованы, они совпадают с
//    краем холста, поэтому заливка снаружи протекла бы внутрь буквы. Контур
//    собирается из найденных штрихов: длинные горизонтали дают низ перекладин,
//    длинные вертикали — правые края, крайние точки краски — левый и верхний
//    край буквы;
//  • подпись FBEST замкнута почти полностью, её достаточно «зашить»
//    морфологическим замыканием (расширить краску, потом сжать обратно) и
//    залить снаружи: что не залилось — внутренность букв.

function inkMask(img, bg, tolerance = 60) {
  const m = new Uint8Array(img.w * img.h)
  for (let i = 0, p = 0; i < img.px.length; i += 4, p++) {
    const d = Math.abs(img.px[i] - bg[0]) + Math.abs(img.px[i + 1] - bg[1]) + Math.abs(img.px[i + 2] - bg[2])
    m[p] = d > tolerance ? 1 : 0
  }
  return m
}

// Горизонтальная полоса без краски — граница между знаком и подписью
function findWordmarkTop(img, ink) {
  let lastInkRow = 0, gapStart = -1, best = -1
  for (let y = 0; y < img.h; y++) {
    let has = false
    for (let x = 0; x < img.w && !has; x++) if (ink[y * img.w + x]) has = true
    if (has) {
      if (gapStart >= 0 && y - gapStart > 40 && gapStart > img.h * 0.5) { best = gapStart + Math.floor((y - gapStart) / 2); break }
      gapStart = -1
      lastInkRow = y
    } else if (gapStart < 0) gapStart = lastInkRow + 1
  }
  return best
}

// Длинные прямые штрихи (толщина роли не играет — берём габарит)
function strokes(img, ink, yFrom, yTo, minH, minV) {
  const runs = []
  for (let y = yFrom; y < yTo; y++) {
    let s = -1
    for (let x = 0; x <= img.w; x++) {
      const on = x < img.w && ink[y * img.w + x]
      if (on && s < 0) s = x
      if (!on && s >= 0) { if (x - s >= minH) runs.push({ dir: 'h', y, x0: s, x1: x - 1 }); s = -1 }
    }
  }
  for (let x = 0; x < img.w; x++) {
    let s = -1
    for (let y = yFrom; y <= yTo; y++) {
      const on = y < yTo && ink[y * img.w + x]
      if (on && s < 0) s = y
      if (!on && s >= 0) { if (y - s >= minV) runs.push({ dir: 'v', x, y0: s, y1: y - 1 }); s = -1 }
    }
  }
  // склеиваем соседние ряды одного штриха в один прямоугольник
  const out = []
  for (const r of runs) {
    const hit = out.find(o => o.dir === r.dir && (r.dir === 'h'
      ? Math.abs(o.y1b - r.y) <= 1 && Math.abs(o.x0 - r.x0) <= 6 && Math.abs(o.x1 - r.x1) <= 6
      : Math.abs(o.x1b - r.x) <= 1 && Math.abs(o.y0 - r.y0) <= 6 && Math.abs(o.y1 - r.y1) <= 6))
    if (hit) {
      if (r.dir === 'h') { hit.y1b = r.y; hit.x0 = Math.min(hit.x0, r.x0); hit.x1 = Math.max(hit.x1, r.x1) }
      else { hit.x1b = r.x; hit.y0 = Math.min(hit.y0, r.y0); hit.y1 = Math.max(hit.y1, r.y1) }
    } else out.push(r.dir === 'h'
      ? { dir: 'h', y0b: r.y, y1b: r.y, x0: r.x0, x1: r.x1 }
      : { dir: 'v', x0b: r.x, x1b: r.x, y0: r.y0, y1: r.y1 })
  }
  return out
}

// Контур большой F по найденным штрихам
function markPolygon(img, ink, yTo) {
  let xLeft = img.w, yTop = img.h, xRight = 0
  for (let y = 0; y < yTo; y++) for (let x = 0; x < img.w; x++) if (ink[y * img.w + x]) {
    if (x < xLeft) xLeft = x
    if (y < yTop) yTop = y
    if (x > xRight) xRight = x
  }
  // Пороги разные: перекладины длинные, а короткий вертикальный штрих у стойки
  // (между верхней и средней перекладиной) втрое короче — общий порог его терял.
  const st = strokes(img, ink, 0, yTo, Math.floor(img.w * 0.25), Math.floor(yTo * 0.1))
  const hs = st.filter(s => s.dir === 'h').sort((a, b) => a.y0b - b.y0b)
  const vs = st.filter(s => s.dir === 'v').sort((a, b) => a.y0 - b.y0)
  if (hs.length < 3 || vs.length < 4) {
    throw new Error(`не удалось разобрать знак: горизонталей ${hs.length}, вертикалей ${vs.length}`)
  }
  const topBarBottom = hs[0].y1b            // низ верхней перекладины
  const midBarBottom = hs[1].y1b            // низ средней перекладины
  const stemBottom = hs[2].y1b              // низ стойки
  const stemRight = Math.max(...vs.filter(v => v.x1b < img.w * 0.6).map(v => v.x1b))
  const midTop = vs.filter(v => v.x0b > img.w * 0.6).map(v => v.y0).sort((a, b) => a - b)[1]
  return {
    poly: [
      [xLeft, yTop], [xRight, yTop],
      [xRight, topBarBottom], [stemRight, topBarBottom],
      [stemRight, midTop], [xRight, midTop],
      [xRight, midBarBottom], [stemRight, midBarBottom],
      [stemRight, stemBottom], [xLeft, stemBottom],
    ],
    info: { xLeft, yTop, xRight, topBarBottom, midTop, midBarBottom, stemBottom, stemRight },
  }
}

// Заливка многоугольника (все стороны вертикальные/горизонтальные)
function fillPolygon(mask, w, h, poly) {
  let minY = h, maxY = 0
  for (const [, y] of poly) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  for (let y = minY; y <= maxY; y++) {
    const xs = []
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length]
      if (y0 === y1) continue
      if (y >= Math.min(y0, y1) && y < Math.max(y0, y1)) xs.push(x0)
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = xs[k]; x <= xs[k + 1]; x++) mask[y * w + x] = 1
    }
  }
}

// Морфология по прямоугольному окну (быстро, через частичные суммы)
function morph(src, w, h, r, mode) {
  const sum = new Int32Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    sum[(y + 1) * (w + 1) + x + 1] = src[y * w + x] + sum[y * (w + 1) + x + 1] + sum[(y + 1) * (w + 1) + x] - sum[y * (w + 1) + x]
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r)
    const x1 = Math.min(w - 1, x + r), y1 = Math.min(h - 1, y + r)
    const s = sum[(y1 + 1) * (w + 1) + x1 + 1] - sum[y0 * (w + 1) + x1 + 1] - sum[(y1 + 1) * (w + 1) + x0] + sum[y0 * (w + 1) + x0]
    const area = (x1 - x0 + 1) * (y1 - y0 + 1)
    out[y * w + x] = mode === 'dilate' ? (s > 0 ? 1 : 0) : (s === area ? 1 : 0)
  }
  return out
}

// Внутренность замкнутых контуров в полосе [yFrom, yTo)
function enclosed(img, ink, yFrom, yTo, r) {
  const w = img.w, h = yTo - yFrom
  const band = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) band[y * w + x] = ink[(y + yFrom) * w + x]
  const closed = morph(morph(band, w, h, r, 'dilate'), w, h, r, 'erode')
  const outside = new Uint8Array(w * h)
  const st = []
  const push = (x, y) => {
    const p = y * w + x
    if (x < 0 || y < 0 || x >= w || y >= h || outside[p] || closed[p]) return
    outside[p] = 1; st.push(p)
  }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (st.length) {
    const p = st.pop(), x = p % w, y = (p - x) / w
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
  }
  const res = new Uint8Array(w * h)
  for (let i = 0; i < res.length; i++) res[i] = outside[i] ? 0 : 1
  return { mask: res, yFrom, h }
}

// Уменьшение с усреднением — без него мелкие линии на значке рассыпаются
function resizeInto(src, dst, dx, dy, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * src.h / dh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * src.h / dh))
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * src.w / dw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * src.w / dw))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const o = (sy * src.w + sx) * 4, al = src.px[o + 3] / 255
        r += src.px[o] * al; g += src.px[o + 1] * al; b += src.px[o + 2] * al; a += src.px[o + 3]; n++
      }
      const o = ((y + dy) * dst.w + x + dx) * 4
      const alpha = a / n
      const k = alpha > 0 ? 255 / alpha : 0
      dst.px[o] = Math.round(r / n * k); dst.px[o + 1] = Math.round(g / n * k)
      dst.px[o + 2] = Math.round(b / n * k); dst.px[o + 3] = Math.round(alpha)
    }
  }
}

// ── сборка ───────────────────────────────────────────────────────────────────
const outFile = path.join(__dirname, 'icon.png')
const source = path.join(__dirname, 'logo-source.png')

if (require.main === module) {
if (process.argv.includes('--from-source')) {
  if (!fs.existsSync(source)) {
    console.error(`Нет файла ${source}. Положите оригинал логотипа туда и повторите.`)
    process.exit(1)
  }
  const img = decodePng(fs.readFileSync(source))
  const bg = [img.px[0], img.px[1], img.px[2]]
  const ink = inkMask(img, bg)
  const wordTop = findWordmarkTop(img, ink)
  if (wordTop < 0) throw new Error('не нашлась граница между знаком и подписью')

  const keep = new Uint8Array(img.w * img.h)
  const { poly, info } = markPolygon(img, ink, wordTop)
  fillPolygon(keep, img.w, img.h, poly)

  // Подпись FBEST устроена иначе, чем знак: там белые линии — это САМИ БУКВЫ
  // (штриховой шрифт), а не обводка залитой формы. Заливать внутри нечего —
  // «залить букву» здесь значит оставить её штрихи, перекрасив в синий: белым
  // на прозрачном фоне подпись была бы не видна на светлом рабочем столе.
  for (let y = wordTop; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const p = y * img.w + x
    if (!ink[p]) continue
    keep[p] = 1
    img.px[p * 4] = bg[0]; img.px[p * 4 + 1] = bg[1]; img.px[p * 4 + 2] = bg[2]
  }
  // Линии внутри самого знака остаются белыми — это его исходный рисунок
  for (let p = 0; p < wordTop * img.w; p++) if (ink[p]) keep[p] = 1

  for (let p = 0; p < keep.length; p++) img.px[p * 4 + 3] = keep[p] ? 255 : 0

  // Значок должен быть квадратным — вписываем по высоте, по бокам прозрачно
  const out = canvas(SIZE)
  // 4% поля по краям: исходник обрезан впритык к знаку, а ярлык, упирающийся
  // в край плитки, выглядит обрезанным среди прочих значков.
  const scale = SIZE * 0.92 / Math.max(img.w, img.h)
  const dw = Math.round(img.w * scale), dh = Math.round(img.h * scale)
  resizeInto(img, out, Math.round((SIZE - dw) / 2), Math.round((SIZE - dh) / 2), dw, dh)
  fs.writeFileSync(outFile, encodePng(out))

  const opaque = keep.reduce((n, v) => n + v, 0)
  console.log(`Исходник: ${img.w}×${img.h}, фон rgb(${bg.join(',')}), подпись начинается с y=${wordTop}`)
  console.log('Контур знака:', JSON.stringify(info))
  console.log(`Непрозрачным осталось ${(opaque / (img.w * img.h) * 100).toFixed(1)}% (было 100%)`)
  console.log(`Готово: ${outFile} (${SIZE}×${SIZE})`)
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
}

module.exports = { decodePng, encodePng, canvas, inkMask, findWordmarkTop, strokes, markPolygon, fillPolygon, morph, enclosed, resizeInto }
