import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import ModbusRTU from 'modbus-serial';
import { SerialPort } from 'serialport';

const execAsync = promisify(exec);

export interface ConnectOptions {
  portPath: string;
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  busy: boolean;
}

@Injectable()
export class ModbusService implements OnModuleDestroy {
  readonly events = new EventEmitter();

  private client = new ModbusRTU();
  private connected = false;
  private options: ConnectOptions | null = null;
  private intentionalDisconnect = false;
  private watchdogTimer: NodeJS.Timeout | null = null;

  // Serialises all bus operations so concurrent setID+read pairs don't race
  private mutexTail: Promise<void> = Promise.resolve();

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutexTail.then(fn);
    this.mutexTail = result.then(() => {}, () => {});
    return result;
  }

  isConnected() {
    return this.connected;
  }

  getStatus() {
    return { connected: this.connected, options: this.options };
  }

  async connect(opts: ConnectOptions): Promise<void> {
    if (this.connected) await this.disconnect();
    this.intentionalDisconnect = false;
    await this.client.connectRTUBuffered(opts.portPath, {
      baudRate: opts.baudRate,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? 'none',
    });
    this.client.setTimeout(2000);
    this.connected = true;
    this.options = opts;
    this.startWatchdog();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.stopWatchdog();
    if (!this.connected) return;
    try {
      await new Promise<void>(resolve => this.client.close(() => resolve()));
    } catch { /* ignore close errors */ }
    this.connected = false;
    this.options = null;
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (this.connected && !this.client.isOpen && !this.intentionalDisconnect) {
        this.connected = false;
        this.stopWatchdog();
        this.events.emit('connection:lost');
      }
    }, 3000);
  }

  private stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  async readRegister(register: number, slaveId: number): Promise<number> {
    return this.withLock(async () => {
      this.client.setID(slaveId);
      const data = await this.client.readHoldingRegisters(register, 1);
      return data.data[0];
    });
  }

  async writeRegister(register: number, rawValue: number, slaveId: number): Promise<void> {
    return this.withLock(async () => {
      this.client.setID(slaveId);
      await this.client.writeRegister(register, rawValue);
    });
  }

  async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    const knownPaths = new Set(ports.map(p => p.path.toUpperCase()));
    const extra = await this.listExtraWindowsPorts(knownPaths);

    const results = await Promise.all([
      ...ports.map(async p => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
        busy: await this.isPortBusy(p.path),
      })),
      ...extra.map(async e => ({
        path: e.path,
        manufacturer: e.description,
        busy: await this.isPortBusy(e.path),
      })),
    ]);
    return results;
  }

  /**
   * SerialPort.list() на Windows находит устройства только в стандартном классе
   * "Ports" (GUID_DEVCLASS_PORTS). Виртуальные драйверы вроде com0com регистрируют
   * свои порты под собственным классом устройств (у com0com это "CNCPorts") — такие
   * порты полностью рабочие (их видно в реестре SERIALCOMM), но SerialPort.list() их
   * не находит. Здесь — резервный проход через WMI по ВСЕМ классам PnP-устройств,
   * который ищет "(COMx)" в имени устройства и добавляет то, что не нашлось выше.
   */
  private async listExtraWindowsPorts(
    knownPaths: Set<string>,
  ): Promise<{ path: string; description: string }[]> {
    if (process.platform !== 'win32') return [];
    try {
      // -EncodedCommand вместо -Command: exec() на Windows прогоняет строку через
      // cmd.exe, который портит вложенные кавычки в -Command; Base64 полностью
      // обходит эту проблему.
      const script =
        "Get-CimInstance Win32_PnPEntity | " +
        "Where-Object { $_.Name -match '\\(COM[0-9]+\\)$' } | " +
        "Select-Object Name | ConvertTo-Json -Compress";
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const { stdout } = await execAsync(
        `powershell -NoProfile -EncodedCommand ${encoded}`,
        { timeout: 10000 }, // "холодный" Get-CimInstance может идти несколько секунд
      );
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      const items: { Name?: string }[] = Array.isArray(parsed) ? parsed : [parsed];

      const found: { path: string; description: string }[] = [];
      for (const item of items) {
        const match = /\((COM\d+)\)$/.exec(item.Name ?? '');
        if (!match) continue;
        const path = match[1];
        if (knownPaths.has(path.toUpperCase())) continue;
        knownPaths.add(path.toUpperCase());
        found.push({ path, description: item.Name! });
      }
      return found;
    } catch {
      return [];
    }
  }

  private isPortBusy(path: string): Promise<boolean> {
    return new Promise(resolve => {
      const port = new SerialPort({ path, baudRate: 9600, autoOpen: false });
      port.open(err => {
        if (err) {
          resolve(true);
        } else {
          port.close(() => resolve(false));
        }
      });
    });
  }

  async identifyDevice(slaveId: number): Promise<'vl' | 'pump' | 'unknown'> {
    return this.withLock(async () => {
      this.client.setTimeout(500);
      try {
        this.client.setID(slaveId);

        // P0.00 (0xF000) — Режим работы: VL/VH возвращает 1 (тяжёлый) или 2 (нормальный)
        const modeData = await this.client.readHoldingRegisters(0xF000, 1);
        const mode = modeData.data[0];
        if (mode !== 1 && mode !== 2) throw new Error('unexpected mode value');

        // P7.07 (0xF707) — Температура IGBT: VL/VH возвращает 0–120 °C (scale=1)
        const tempData = await this.client.readHoldingRegisters(0xF707, 1);
        const temp = tempData.data[0];
        if (temp < 0 || temp > 120) throw new Error('unexpected temp value');

        return 'vl';
      } catch {
        try {
          // Pump отвечает на регистр 0
          await this.client.readHoldingRegisters(0, 1);
          return 'pump';
        } catch {
          return 'unknown';
        }
      } finally {
        this.client.setTimeout(2000);
      }
    });
  }

  async probeDevice(slaveId: number): Promise<{ slaveId: number; mei1: object; mei2: object; mei3: object; fc17: object }>
  {
    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
        ),
      ]);

    const readMei = async (code: number) => {
      try {
        const result = await withTimeout(this.client.readDeviceIdentification(code, 0x00), 1000);
        return { conformityLevel: result.conformityLevel, data: result.data };
      } catch (e: any) {
        return { error: e?.message ?? String(e) };
      }
    };

    return this.withLock(async () => {
      this.client.setID(slaveId);
      const mei1 = await readMei(1);
      const mei2 = await readMei(2);
      const mei3 = await readMei(3);
      let fc17: object;
      try {
        const result = await withTimeout(this.client.reportServerID(0), 1000);
        fc17 = {
          serverId: result.serverId,
          running: result.running,
          additionalDataHex: result.additionalData.toString('hex'),
          additionalDataText: result.additionalData.toString('utf8').replace(/[^\x20-\x7E]/g, '?'),
        };
      } catch (e: any) {
        fc17 = { error: e?.message ?? String(e) };
      }
      return { slaveId, mei1, mei2, mei3, fc17 };
    });
  }

  // Публичный — переиспользуется и scanBus'ом, и постоянным фоновым опросом
  // "на связи ли устройство" в гейтвее (device:liveness).
  async probeAddress(addr: number, timeoutMs = 150): Promise<boolean> {
    return this.withLock(async () => {
      this.client.setTimeout(timeoutMs);
      try {
        this.client.setID(addr);
        // Пробуем PUMP-диапазон (0) и VH-диапазон (0xF000)
        try {
          await this.client.readHoldingRegisters(0, 1);
          return true;
        } catch {
          await this.client.readHoldingRegisters(0xF000, 1);
          return true;
        }
      } catch {
        return false;
      } finally {
        this.client.setTimeout(2000);
      }
    });
  }

  async scanBus(
    from: number,
    to: number,
    onProgress: (addr: number, found: number[]) => void,
    isCancelled: () => boolean,
  ): Promise<number[]> {
    const found: number[] = [];
    for (let addr = from; addr <= to; addr++) {
      if (isCancelled()) break;
      const responded = await this.probeAddress(addr);
      if (isCancelled()) break;
      if (responded) found.push(addr);
      onProgress(addr, [...found]);
    }
    return found;
  }

  private static readonly AUTODETECT_BAUD_RATES = [9600, 19200, 38400, 4800, 57600, 115200, 2400, 1200];

  private static buildAutoDetectCombos(): ConnectOptions[] {
    const combos: ConnectOptions[] = [];
    const bauds = ModbusService.AUTODETECT_BAUD_RATES;
    // 1) самый частый случай — 8N1 на разных скоростях
    for (const baudRate of bauds) combos.push({ portPath: '', baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
    // 2) чётность (реже, но встречается на некоторых шинах)
    for (const baudRate of bauds) {
      for (const parity of ['even', 'odd'] as const) {
        combos.push({ portPath: '', baudRate, dataBits: 8, stopBits: 1, parity });
      }
    }
    // 3) 2 стоп-бита
    for (const baudRate of bauds) combos.push({ portPath: '', baudRate, dataBits: 8, stopBits: 2, parity: 'none' });
    // 4) 7 бит данных (устаревшие/нестандартные конфигурации)
    for (const baudRate of bauds) combos.push({ portPath: '', baudRate, dataBits: 7, stopBits: 1, parity: 'none' });
    return combos;
  }

  /**
   * Перебирает типовые сочетания baudRate/dataBits/stopBits/parity на заданном порту,
   * на каждом сочетании пробует несколько адресов из диапазона [from, to] — как только
   * хоть один адрес ответил корректным Modbus-пакетом, считает эту конфигурацию рабочей
   * и оставляет порт открытым с ней (готово для последующего scanBus по всему диапазону).
   */
  async autoDetectBus(
    portPath: string,
    from: number,
    to: number,
    onProgress: (info: { comboIndex: number; totalCombos: number; combo: ConnectOptions }) => void,
    isCancelled: () => boolean,
  ): Promise<ConnectOptions | null> {
    const combos = ModbusService.buildAutoDetectCombos();
    const probeAddrs: number[] = [];
    for (let a = from; a <= to && probeAddrs.length < 5; a++) probeAddrs.push(a);

    for (let i = 0; i < combos.length; i++) {
      if (isCancelled()) return null;
      const combo = { ...combos[i], portPath };
      onProgress({ comboIndex: i, totalCombos: combos.length, combo });

      try {
        await this.connect(combo);
      } catch {
        // сам порт не открылся (занят/не существует) — дальше перебирать бессмысленно
        return null;
      }

      let matched = false;
      for (const addr of probeAddrs) {
        if (isCancelled()) { await this.disconnect(); return null; }
        if (await this.probeAddress(addr, 150)) { matched = true; break; }
      }

      if (matched) return combo;
      await this.disconnect();
    }
    return null;
  }

  async findAdapterPort(opts: { baudRate?: number }): Promise<{ portPath: string; baudRate: number } | null> {
    const ports = await this.listPorts();
    if (!ports.length) return null;

    const knownVids = [
      '10c4',  // Silicon Labs CP2102/CP2104 (Elhart EDC-A1-U1)
      '0403',  // FTDI FT232
      '1a86',  // WCH CH340/CH341
      '067b',  // Prolific PL2303
      '04d8',  // Microchip MCP2200
    ];
    const knownManufacturers = ['silicon', 'ftdi', 'wch', 'prolific', 'microchip'];

    const baudRate = opts.baudRate ?? 9600;

    let found = ports.find(p => p.vendorId && knownVids.includes(p.vendorId.toLowerCase()));

    if (!found) {
      found = ports.find(p =>
        p.manufacturer && knownManufacturers.some(m => p.manufacturer!.toLowerCase().includes(m)),
      );
    }

    if (!found && ports.length === 1) found = ports[0];

    if (!found) return null;
    return { portPath: found.path, baudRate };
  }

  async onModuleDestroy() {
    await this.disconnect();
  }
}
