import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Номер версии — из КОРНЕВОГО package.json, того же, по которому
// electron-builder называет инсталлятор. Одна точка правды: то, что показано в
// шапке программы, совпадает с версией установленного пакета. Подставляется на
// сборке, поэтому в готовом приложении никаких запросов за версией не нужно.
const rootPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(rootPkg.version) },
  plugins: [react()],
  server: {
    // По умолчанию Vite слушает localhost, что на некоторых машинах резолвится
    // в IPv6-loopback (::1) — если IPv6-петля в системе не работает (бывает
    // из-за групповых политик/файрвола), браузер не может достучаться до
    // дев-сервера, хотя порт формально "занят". Явный IPv4-адрес обходит это.
    host: '127.0.0.1',
    // Без этого Vite молча переезжает на 5174/5175 и т.д., если 5173 занят
    // (обычно старым зависшим процессом) — а потом непонятно, почему адрес
    // не тот. strictPort вместо этого сразу падает с ошибкой "порт занят",
    // явно показывая, что сначала нужно освободить порт (см. README).
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
