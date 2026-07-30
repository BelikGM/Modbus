import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Версия попадает и в заголовок окна: наведя мышь на значок в панели задач,
// видно, какая сборка запущена, — не открывая программу.
document.title = `Fbest Controller ${__APP_VERSION__}`

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
