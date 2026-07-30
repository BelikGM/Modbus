import { useState, useEffect } from 'react'
import {
  Table, Checkbox, Typography, Alert, Tag, Space, Button,
} from 'antd'
import AppModal from './AppModal'
import { WarningOutlined } from '@ant-design/icons'
import { formatParamValue } from '../paramFormat'

// Защита от случайной перезаписи настроенных параметров.
//
// Шаблон покрывает только часть параметров; всё остальное пишется ЗАВОДСКИМИ
// значениями. Если на ПЧ такой «непокрытый шаблоном» параметр уже настроен
// (его значение отличается от заводского), запись молча затрёт настройку.
// Здесь такие случаи собираются в список и показываются оператору: он либо
// подтверждает перезапись всех, либо снимает галочки с тех параметров,
// которые надо оставить как есть (они уйдут в skip и не будут записаны).
//
// Важно: сравнение идёт с ПОСЛЕДНИМИ ПРОЧИТАННЫМИ значениями (currentValues /
// результаты группового чтения). Параметры, которые ни разу не читались,
// проверить нечем — об этом честно сказано в самом окне.

// Собирает конфликты: [{ deviceId, deviceName, paramId, param, current, incoming }]
// values: { [deviceId]: { [paramId]: number } } — что собираемся записать
// known:  { [deviceId]: { [paramId]: number } } — что реально прочитано с ПЧ
// coveredParamIds: Set — параметры, покрытые шаблоном/ручной правкой (их
//   перезапись ожидаема, о ней не предупреждаем)
export function collectOverwriteConflicts({ devices, values, known, coveredParamIds, paramsById }) {
  const conflicts = []
  for (const device of devices) {
    const toWrite = values[device.id] ?? {}
    const current = known[device.id] ?? {}
    for (const [paramId, incoming] of Object.entries(toWrite)) {
      if (coveredParamIds?.has(paramId)) continue        // намеренно меняем — норма
      const cur = current[paramId]
      if (cur === undefined || cur === null) continue     // не читали — сравнивать не с чем
      if (typeof incoming !== 'number' || typeof cur !== 'number') continue
      // Сравниваем с допуском: значения приходят после умножения на scale.
      if (Math.abs(cur - incoming) < 1e-9) continue       // и так совпадает
      conflicts.push({
        deviceId: device.id,
        deviceName: device.name,
        slaveId: device.connection?.slaveId,
        paramId,
        param: paramsById.get(paramId),
        current: cur,
        incoming,
      })
    }
  }
  return conflicts
}

export default function OverwriteGuard({ open, conflicts, uncheckedCount, onCancel, onConfirm, onReadAll, reading }) {
  // По умолчанию НИЧЕГО не перезаписываем: безопасный вариант — сохранить то,
  // что уже настроено на ПЧ. Оператор осознанно отмечает, что можно затереть.
  const [checked, setChecked] = useState(new Set())

  useEffect(() => {
    if (open) setChecked(new Set())
  }, [open, conflicts])

  const keyOf = c => `${c.deviceId}::${c.paramId}`
  const allChecked = conflicts.length > 0 && conflicts.every(c => checked.has(keyOf(c)))
  // Параметры источника управления (помечены critical в шаблоне) — их сброс
  // отбирает управление по RS-485, поэтому выносим отдельным предупреждением.
  const criticalConflicts = conflicts.filter(c => c.param?.critical)

  function toggle(c) {
    const next = new Set(checked)
    const k = keyOf(c)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setChecked(next)
  }

  function toggleAll(on) {
    setChecked(on ? new Set(conflicts.map(keyOf)) : new Set())
  }

  function handleOk() {
    // skip = всё, что НЕ отмечено к перезаписи
    const skip = {}
    for (const c of conflicts) {
      if (checked.has(keyOf(c))) continue
      skip[c.deviceId] = [...(skip[c.deviceId] ?? []), c.paramId]
    }
    onConfirm(skip)
  }

  const fmt = (param, val) => param
    ? formatParamValue(param.type, val, param.unit, param.options, param.bits)
    : String(val)

  return (
    <AppModal
      title={<Space><WarningOutlined style={{ color: '#faad14' }} />Заводские значения затрут настроенные параметры</Space>}
      open={open}
      /* Enter здесь выключен: кнопка перезаписывает настроенные параметры ПЧ */
      enterSubmit={false}
      onCancel={onCancel}
      onOk={handleOk}
      okText={checked.size > 0 ? `Записать, перезаписав отмеченные (${checked.size})` : 'Записать, сохранив все текущие значения'}
      cancelText="Отмена"
      okButtonProps={{ danger: checked.size > 0 }}
      width={860}
    >
      {conflicts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`Найдено ${conflicts.length} параметров, не покрытых шаблоном, у которых значение на ПЧ отличается от заводского`}
          description="Эти параметры шаблон не задаёт, поэтому в них пойдёт ЗАВОДСКОЕ значение и текущая настройка будет потеряна. Отметьте те, которые действительно нужно вернуть к заводским. Неотмеченные останутся на ПЧ без изменений."
        />
      )}

      {/* Параметры источника управления — отдельно и максимально заметно:
          вернув их к заводским, ПЧ переключится на пульт и управлять им по
          RS-485 (в том числе писать параметры) станет невозможно. */}
      {criticalConflicts.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`Среди них ${criticalConflicts.length} — параметры источника управления!`}
          description={
            <>
              <div style={{ marginBottom: 4 }}>
                {criticalConflicts.map(c => `${c.paramId} ${c.param?.name ?? ''}`).filter((v, i, a) => a.indexOf(v) === i).join('; ')}
              </div>
              Сброс на заводское значение переведёт управление на пульт ПЧ — после этого
              подать команды и записать параметры по RS-485 будет НЕЛЬЗЯ, потребуется
              настраивать устройство вручную с его панели. Оставьте их без изменений,
              если не уверены.
            </>
          }
        />
      )}

      {uncheckedCount > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${uncheckedCount} параметров ни разу не читались с ПЧ — сравнить их не с чем`}
          description={
            <>
              Проверка выполнена только по ранее считанным значениям. Непрочитанные параметры
              будут записаны заводскими без предупреждения — среди них может оказаться важная
              настройка.
              {onReadAll && (
                <div style={{ marginTop: 8 }}>
                  <Button type="primary" size="small" loading={reading} onClick={onReadAll}>
                    Сначала считать все параметры с ПЧ и сравнить
                  </Button>
                </div>
              )}
            </>
          }
        />
      )}
      <Checkbox
        checked={allChecked}
        indeterminate={checked.size > 0 && !allChecked}
        onChange={e => toggleAll(e.target.checked)}
        style={{ marginBottom: 8 }}
      >
        <b>Перезаписать все ({conflicts.length})</b>
      </Checkbox>
      <Table
        size="small"
        pagination={false}
        scroll={{ y: 360 }}
        rowKey={keyOf}
        dataSource={conflicts}
        columns={[
          {
            title: 'Перезаписать',
            width: 100,
            render: (_, c) => (
              <Checkbox checked={checked.has(keyOf(c))} onChange={() => toggle(c)} />
            ),
          },
          {
            title: 'ПЧ',
            width: 170,
            render: (_, c) => (
              <span>
                {c.deviceName}{' '}
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>Адрес {c.slaveId}</Typography.Text>
              </span>
            ),
          },
          {
            title: 'Параметр',
            width: 260,
            render: (_, c) => (
              <span>
                <Typography.Text code style={{ fontSize: 11 }}>{c.paramId}</Typography.Text>{' '}
                <Typography.Text style={{ fontSize: 12 }}>{c.param?.name ?? ''}</Typography.Text>
                {c.param?.critical && (
                  <Tag color="red" style={{ fontSize: 10, marginLeft: 4, padding: '0 4px' }}>
                    источник управления
                  </Tag>
                )}
              </span>
            ),
          },
          {
            title: 'Сейчас на ПЧ',
            width: 150,
            render: (_, c) => <Tag color="blue">{fmt(c.param, c.current)}</Tag>,
          },
          {
            title: 'Будет записано (заводское)',
            width: 190,
            render: (_, c) => <Tag color={checked.has(keyOf(c)) ? 'red' : 'default'}>{fmt(c.param, c.incoming)}</Tag>,
          },
        ]}
      />
    </AppModal>
  )
}
