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
  groups: ParamGroup[];
}
