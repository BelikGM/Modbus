// Симулятор Modbus RTU-устройств на виртуальном COM-порту (com0com).
// Позволяет тестировать автопоиск адаптера, скан шины (bus:scan), автоопределение
// модели (bus:identify) и мониторинг — без физического ПЧ.
//
// Установка виртуальной пары портов: https://sourceforge.net/projects/com0com/
// (или форк с подписанным драйвером для Windows 10/11: https://github.com/paulakalanmalus/com0com,
// либо https://com0com.sourceforge.io/ — при установке снять галку "use signtool", если ставите
// оригинальную версию, и разрешить unsigned driver в Windows, либо взять подписанный форк).
// com0com создаёт пару связанных портов (напр. COM8 <-> COM9): один конец — этот симулятор,
// другой — подключаете как обычный COM-порт в приложении.
//
// Запуск (из backend/):
//   node tools/modbus-simulator.js COM8 9600
//   node tools/modbus-simulator.js COM8 9600 1:pump,2:vh,5:pump

const fs = require('fs');
const nodePath = require('path');
const ModbusRTU = require('modbus-serial');

const path = process.argv[2] || 'COM8';
const baudRate = Number(process.argv[3]) || 9600;
const deviceArg = process.argv[4] || '1:pump,2:vh';

const DEVICES = {};
for (const pair of deviceArg.split(',')) {
  const [slaveId, kind] = pair.split(':');
  DEVICES[Number(slaveId)] = kind.trim();
}

const regs = {};

// Заводские значения регистров, которых нет в ручной таблице ниже (все F1-F9 —
// параметры настройки, а не датчики), берём прямо из шаблона устройства
// (param.default), а не оставляем 0 — иначе, например, "Скорость передачи
// данных" читалась бы как 0 (4800 бит/сек) вместо реального заводского
// значения 1 (9600 бит/сек, см. default в devices/templates/*.json).
function loadTemplateDefaults(templateFile) {
  const map = new Map();
  try {
    const raw = fs.readFileSync(nodePath.join(__dirname, '..', '..', 'devices', 'templates', templateFile), 'utf8');
    const tpl = JSON.parse(raw);
    for (const group of tpl.groups ?? []) {
      for (const param of group.params ?? []) {
        if (typeof param.register === 'number' && param.default !== undefined) {
          map.set(param.register, param.default);
        }
      }
    }
  } catch (e) {
    console.error(`Не удалось прочитать заводские значения из ${templateFile}:`, e.message);
  }
  return map;
}

const TEMPLATE_DEFAULTS = {
  pump: loadTemplateDefaults('Elhart-Emd-Pump-Full.json'),
  vh: loadTemplateDefaults('Elhart-Emd-VH-Full.json'),
};

function defaultsFor(kind) {
  const map = new Map(TEMPLATE_DEFAULTS[kind]);
  // Поверх заводских настроек — свои "живые" показания датчиков с разбросом,
  // этим регистрам родное значение "default" в шаблоне не задано (это показания,
  // а не хранимые настройки).
  if (kind === 'pump') {
    map.set(0, 0);      // F0.00 — параметр на дисплее
    map.set(1, 5000);   // F0.01 заданная частота, scale 0.01 → 50.00 Гц
    map.set(2, 5000);   // F0.02 выходная частота
    map.set(3, 45);     // F0.03 ток, scale 0.1 → 4.5 А
    map.set(4, 1450);   // F0.04 об/мин
    map.set(5, 540);    // F0.05 напряжение ЗПТ, В
    map.set(6, 38);     // F0.06 температура ПЧ, °C
    map.set(7, 0);      // F0.07 сигнал ОС ПИД
    map.set(8, 12);     // F0.08 наработка, ч
    map.set(9, 380);    // F0.09 выходное напряжение, В
    map.set(10, 0);     // F0.10 код аварии — 0 = нет аварии
  } else if (kind === 'vh') {
    map.set(0xf000, 2);   // P0.00 режим работы (1=тяжёлый, 2=обычный)
    map.set(0xf707, 42);  // P7.07 температура IGBT-модуля, °C
    map.set(0x7004, 350); // D0.04 выходной ток, scale 0.01 → 3.50 А
    map.set(0x8000, 0);   // FAULT_CODE — 0 = нет аварии
    map.set(0x3000, 3);   // STATUS — 3 = привод остановлен
  }
  return map;
}

function regsFor(unitID) {
  if (!regs[unitID]) regs[unitID] = defaultsFor(DEVICES[unitID]);
  return regs[unitID];
}

// небольшой "живой" разброс для регистров-датчиков, чтобы монитор не стоял на месте
const NOISY = new Set([1, 2, 3, 4, 0x7004, 0xf707]);

const vector = {
  getHoldingRegister: function (addr, unitID, callback) {
    if (!DEVICES[unitID]) {
      // адрес не занят ни одним симулируемым устройством — как будто никто не ответил
      return callback(new Error(`unit ${unitID} not present`));
    }
    const map = regsFor(unitID);
    let value = map.has(addr) ? map.get(addr) : 0;
    if (NOISY.has(addr) && value > 0) {
      value = Math.max(0, Math.round(value + (Math.random() - 0.5) * value * 0.06));
    }
    callback(null, value);
  },
  setRegister: function (addr, value, unitID) {
    if (!DEVICES[unitID]) return;
    regsFor(unitID).set(addr, value);
    console.log(`[SET] unit ${unitID}: reg ${addr} (0x${addr.toString(16)}) = ${value}`);
  },
};

const server = new ModbusRTU.ServerSerial(vector, {
  path,
  baudRate,
  debug: true,
});

server.on('initialized', () => {
  console.log(`Симулятор запущен на ${path} @ ${baudRate}`);
  console.log('Устройства на шине:', DEVICES);
  console.log('Для остановки — Ctrl+C');
});
server.on('error', (e) => console.error('Ошибка сервера:', e));
server.on('socketError', (e) => console.error('Ошибка порта:', e));
