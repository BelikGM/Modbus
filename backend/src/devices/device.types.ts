export interface ParamOption {
  value: number;
  label: string;
}

export interface DeviceParam {
  id: string;
  name: string;
  register: number;
  access: string;
  type: 'float' | 'integer' | 'enum';
  scale?: number;
  step?: number;
  unit?: string;
  min?: number;
  max?: number;
  default?: number;
  options?: ParamOption[];
  bits?: { bit: number; name: string; options?: Record<string, string> }[];
}

export interface ParamGroup {
  id: string;
  name: string;
  description?: string;
  // Настройки связи (RS-485: адрес на шине, скорость, формат). Такие группы
  // исключены из массовых операций «записать/сбросить всё»: заводской адрес у
  // всех ПЧ = 1, и запись его во все устройства разом посадила бы всю шину на
  // один адрес, а сброс скорости оборвал бы связь.
  protectedFromBulk?: boolean;
  params: DeviceParam[];
}

export interface DeviceConnection {
  slaveId: number;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
  protocol: string;
}

export interface DeviceImages {
  device?: string;
  wiring?: string;
}

export type AlertCondition = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
export type AlertLevel = 'info' | 'warning' | 'error';

export interface AlertRule {
  id: string;
  paramId: string;
  condition: AlertCondition;
  threshold: number;
  level: AlertLevel;
  message: string;
}

export interface DeviceConfig {
  id: string;
  name: string;
  description?: string;
  template?: boolean;
  templateId?: string;
  connection: DeviceConnection;
  images?: DeviceImages;
  errorCodes?: Record<string, string>;
  alerts?: AlertRule[];
  access_legend?: Record<string, string>;
  // Каталог исполнений модели (артикул + мощность) — берётся из шаблона.
  models?: { code: string; powerKw: number; supply?: string }[];
  // Штатная команда сброса на заводские настройки — ОДИН регистр, а не запись
  // сотни значений по одному. ВНИМАНИЕ: такой сброс возвращает к заводским и
  // настройки связи (адрес станет 1, скорость по умолчанию), поэтому связь с
  // устройством после него теряется — это ожидаемое поведение самого ПЧ.
  factoryReset?: { paramId: string; value: number; register: number };
  // Параметры, чьё заводское значение зависит от исполнения ПЧ (в руководстве
  // указано «Зависит от модели ПЧ», конкретного числа нет).
  modelDependentParams?: string[];
  // Заводские значения этих параметров по исполнениям:
  //   { "EMD-PUMP-0037 T": { "F2.10": 9.0, "F1.07": 20 } }
  // Хранится ОДИН раз в шаблоне модели (не в проекте), поэтому заполняется
  // единожды и переиспользуется во всех проектах. Значения, общие для всех
  // исполнений, лежат в самих параметрах (param.default) и не дублируются.
  modelDefaults?: Record<string, Record<string, number>>;
  // Доступные версии прошивки модели и выбранная у конкретного устройства.
  // У EMD-PUMP это v1.2 и v2.0 — у них отдельные руководства производителя.
  firmwares?: string[];
  firmware?: string;
  // Правки параметров под конкретную прошивку:
  //   { "v2.0": { "F0.06": { "scale": 0.1, "type": "float" } } }
  // Применяются при сборке конфигурации устройства (merge). Нужны там, где
  // версии отдают одно и то же по-разному — например температуру: v2.0 в
  // десятых долях (380 = 38.0 °C), v1.2 целыми (38).
  firmwareOverrides?: Record<string, Record<string, Partial<DeviceParam>>>;
  // Пользовательский тип, созданный в программе (штатные защищены от правки)
  custom?: boolean;
  // Семейство для фильтра слева: у типов одного семейства совместимые карты
  // регистров, поэтому групповые операции между ними безопасны. Задаётся явно,
  // а не угадывается по названию.
  family?: string;
  familyLabel?: string;
  // Постоянная группа «Избранное» этого типа
  builtinFavorites?: string[];
  // Выбранное исполнение конкретного устройства — из инстанса проекта.
  // Заполняется вручную: по шине исполнение не определить (ELHART не
  // поддерживает Modbus-функцию идентификации 43/MEI).
  model?: string;
  groups: ParamGroup[];
}
