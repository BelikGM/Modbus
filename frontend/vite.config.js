import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // По умолчанию Vite слушает localhost, что на некоторых машинах резолвится
    // в IPv6-loopback (::1) — если IPv6-петля в системе не работает (бывает
    // из-за групповых политик/файрвола), браузер не может достучаться до
    // дев-сервера, хотя порт формально "занят". Явный IPv4-адрес обходит это.
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
