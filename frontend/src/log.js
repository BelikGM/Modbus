import { useState, useEffect } from 'react'
import api from './api'

// Журнал операций. Хранится НА БЭКЕНДЕ пер-проект (см. backend/src/logs) и
// переживает перезагрузку страницы: раньше жил только в памяти вкладки и
// терялся при F5. Здесь — кэш в памяти для мгновенной отрисовки + отправка
// новых записей на сервер пачками (журнал пополняется часто, по записи на
// каждый прочитанный/записанный параметр).
let _entries = []
let _projectId = null
const _listeners = new Set()

let _queue = []
let _flushTimer = null

function notify() {
  _listeners.forEach(fn => fn(_entries))
}

function flush() {
  _flushTimer = null
  if (!_projectId || _queue.length === 0) return
  const batch = _queue
  _queue = []
  api.post('/logs', { projectId: _projectId, entries: batch }).catch(() => {})
}

function scheduleFlush() {
  if (_flushTimer) return
  _flushTimer = setTimeout(flush, 600)
}

// Переключение активного проекта: подтягиваем его журнал с сервера.
export function setLogProject(projectId) {
  if (_projectId === projectId) return
  flush() // не теряем ещё не отправленные записи предыдущего проекта
  _projectId = projectId
  _entries = []
  notify()
  if (!projectId) return
  api.get('/logs', { params: { projectId } })
    .then(({ data }) => {
      // Проект мог успеть смениться, пока шёл запрос
      if (_projectId !== projectId) return
      _entries = Array.isArray(data) ? data : []
      notify()
    })
    .catch(() => {})
}

export function addLog(level, message) {
  const now = new Date()
  const entry = {
    id: now.getTime() + '-' + Math.random().toString(36).slice(2, 8),
    ts: now.toISOString(),
    time: now.toLocaleTimeString('ru-RU'),
    level, // 'info' | 'success' | 'error' | 'warning'
    message,
  }
  _entries = [entry, ..._entries].slice(0, 5000)
  notify()
  _queue.push(entry)
  scheduleFlush()
}

export function clearLog() {
  _entries = []
  _queue = []
  notify()
  if (_projectId) api.delete('/logs', { params: { projectId: _projectId } }).catch(() => {})
}

export function useLog() {
  const [entries, setEntries] = useState(_entries)
  useEffect(() => {
    setEntries(_entries)
    _listeners.add(setEntries)
    return () => _listeners.delete(setEntries)
  }, [])
  return entries
}
