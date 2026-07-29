import { useState, useEffect } from 'react'

// Глобальный признак «идёт длительная операция»: групповое чтение/запись,
// выгрузка CSV, мониторинг. Пока он взведён, UI не даёт переключиться на другой
// ПЧ или другую вкладку — иначе операция продолжается в фоне, а её результаты
// уходят «не туда» (таблица обнуляется, мониторинг остаётся висеть на прежнем
// устройстве). Снимается либо по завершении операции, либо кнопкой «Остановить».
//
// Отдельный модуль, а не проп через полдерева: занятость поднимают глубоко
// вложенные компоненты (Monitor, BulkMonitor), а читает её корневой App.
const _flags = { bulk: false, monitor: false }
const _listeners = new Set()

function snapshot() {
  return { ..._flags, any: _flags.bulk || _flags.monitor }
}

export function setBusy(key, value) {
  if (_flags[key] === value) return
  _flags[key] = value
  const s = snapshot()
  _listeners.forEach(fn => fn(s))
}

export function isBusy() {
  return snapshot().any
}

export function useBusy() {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    setState(snapshot())
    _listeners.add(setState)
    return () => _listeners.delete(setState)
  }, [])
  return state
}
