// Устройства, которых нет в сохранённом порядке (новые/ещё не переставленные),
// уходят в конец в исходном относительном порядке. Используется и сайдбаром
// (DeviceList), и App.jsx — чтобы групповой просмотр (BulkPanel/BulkMonitor)
// показывал устройства в том же порядке, в каком они расставлены в сайдбаре,
// а не в порядке, в котором они были найдены/добавлены в проект.
export function sortByDeviceOrder(devices, order) {
  if (!order) return devices
  return [...devices].sort((a, b) => {
    const ai = order.indexOf(a.id)
    const bi = order.indexOf(b.id)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })
}
