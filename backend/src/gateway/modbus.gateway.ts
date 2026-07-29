import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { DevicesService } from '../devices/devices.service';
import { DeviceParam } from '../devices/device.types';
import { ModbusService, ConnectOptions } from '../modbus/modbus.service';
import { ProjectsService } from '../projects/projects.service';
import { SettingsService } from '../settings/settings.service';

const RECONNECT_INTERVAL_MS = 5000;
const PORT_WATCH_INTERVAL_MS = 1000;

@WebSocketGateway({ cors: { origin: '*' } })
export class ModbusGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private monitoredDevices = new Map<string, { slaveId: number; params: DeviceParam[] }>();
  private monitorLoopRunning = false;
  private scanning = false;
  private scanCancelled = false;
  private autoDetecting = false;
  private autoDetectCancelled = false;

  private bulkOpRunning = false;
  private bulkOpCancelled = false;

  private deviceLiveness = new Map<string, boolean>();
  private livenessLoopRunning = false;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;

  private portWatchTimer: NodeJS.Timeout | null = null;
  private watchedPort: ConnectOptions | null = null;
  private portWatchConnecting = false;

  constructor(
    private readonly devicesService: DevicesService,
    private readonly modbusService: ModbusService,
    private readonly projectsService: ProjectsService,
    private readonly settingsService: SettingsService,
  ) {}

  async onModuleInit() {
    await this.tryAutoConnect();
    this.ensureLivenessLoopRunning();

    // Ошибки разбора файлов шаблонов — сразу всем клиентам, чтобы битый JSON
    // не пропадал молча (иначе новый тип ПЧ просто не появляется в списке).
    this.devicesService.events.on('templates:errors', (errors) =>
      this.server?.emit('templates:errors', errors),
    );
    this.devicesService.events.on('device:added', () =>
      this.server?.emit('devices:updated', this.devicesService.getAll()),
    );
    this.devicesService.events.on('device:changed', () =>
      this.server?.emit('devices:updated', this.devicesService.getAll()),
    );
    this.devicesService.events.on('device:removed', () =>
      this.server?.emit('devices:updated', this.devicesService.getAll()),
    );
    this.devicesService.events.on('devices:reloaded', () => {
      this.stopMonitor();
      this.server?.emit('devices:updated', this.devicesService.getAll());
    });
    this.devicesService.events.on('device:id:changed', ({ oldId, newId }: { oldId: string; newId: string }) => {
      this.server?.emit('device:id:changed', { oldId, newId });
      this.server?.emit('devices:updated', this.devicesService.getAll());
    });

    this.modbusService.events.on('connection:lost', () => {
      this.stopMonitor();
      this.server?.emit('modbus:status', this.buildStatus());
      this.startReconnect();
    });

    this.projectsService.events.on('project:folder:mismatch', (mismatches) => {
      this.server?.emit('project:folder:mismatch', mismatches);
    });
    this.projectsService.events.on('projects:changed', () => {
      this.server?.emit('projects:updated', this.projectsService.listProjects());
    });
    // Срабатывает и на ручное переключение проекта, и на автосоздание проекта
    // (например, при первом подключении к порту или определении устройств без
    // выбранного проекта) — так фронт всегда узнаёт, какой проект стал активным,
    // независимо от того, что именно его создало.
    this.projectsService.events.on('project:changed', (id: string | null) => {
      this.server?.emit('active:project:changed', { id });
      this.server?.emit('projects:updated', this.projectsService.listProjects());
    });
  }

  private async tryAutoConnect(): Promise<void> {
    const activeProject = this.projectsService.getActiveProjectId();
    if (!activeProject) return;
    const saved = this.settingsService.getProjectConnection(activeProject);
    if (!saved) return;
    try {
      await this.modbusService.connect(saved);
    } catch {
      this.startPortWatch(saved);
    }
  }

  afterInit(_server: Server) {}

  handleConnection(client: Socket) {
    client.emit('devices:list', this.devicesService.getAll());
    client.emit('modbus:status', this.buildStatus());
    client.emit('devices:liveness:snapshot', Object.fromEntries(this.deviceLiveness));
    const tplErrors = this.devicesService.getTemplateErrors();
    if (tplErrors.length) client.emit('templates:errors', tplErrors);
    const mismatches = this.projectsService.checkMismatches();
    if (mismatches.length) client.emit('project:folder:mismatch', mismatches);
  }

  handleDisconnect(_client: Socket) {}

  // ─── Connection ────────────────────────────────────────────────────────────

  @SubscribeMessage('connect:port')
  async handleConnectPort(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { portPath: string; baudRate: number },
  ) {
    this.stopReconnect();
    this.stopPortWatch();
    try {
      await this.modbusService.connect(payload);
      let activeProject = this.projectsService.getActiveProjectId();
      if (!activeProject) {
        const meta = this.projectsService.createProject(this.projectsService.generateDefaultProjectName());
        this.projectsService.setActiveProject(meta.id);
        activeProject = meta.id;
      }
      this.settingsService.saveProjectConnection(activeProject, {
        portPath: payload.portPath,
        baudRate: payload.baudRate,
      });
      this.server.emit('modbus:status', this.buildStatus());
      return { success: true };
    } catch (e) {
      client.emit('modbus:error', { message: (e as Error).message });
      return { success: false, error: (e as Error).message };
    }
  }

  @SubscribeMessage('project:select')
  async handleProjectSelect(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { id: string | null },
  ) {
    this.stopReconnect();
    this.stopPortWatch();
    this.stopMonitor();
    if (this.modbusService.isConnected()) {
      await this.modbusService.disconnect();
    }
    this.projectsService.setActiveProject(payload.id);
    if (!payload.id) {
      this.server.emit('modbus:status', this.buildStatus());
      return { success: true };
    }

    const saved = this.settingsService.getProjectConnection(payload.id);
    if (!saved) {
      // Порт никогда не выбирался — просим пользователя выбрать вручную
      this.server.emit('modbus:status', this.buildStatus());
      client.emit('port:required', { projectId: payload.id });
      return { success: true };
    }

    try {
      await this.modbusService.connect(saved);
    } catch {
      // Порт недоступен — ждём появления в фоне
      this.startPortWatch(saved);
    }
    this.server.emit('modbus:status', this.buildStatus());
    return { success: true };
  }

  @SubscribeMessage('disconnect:port')
  async handleDisconnectPort() {
    this.stopReconnect();
    this.stopPortWatch();
    this.stopMonitor();
    await this.modbusService.disconnect();
    this.server.emit('modbus:status', this.buildStatus());
  }

  // ─── Reconnect ─────────────────────────────────────────────────────────────

  private startReconnect() {
    this.stopReconnect();
    this.reconnectAttempt = 0;
    // First attempt immediately, then every RECONNECT_INTERVAL_MS
    this.tryReconnect();
    this.reconnectTimer = setInterval(() => this.tryReconnect(), RECONNECT_INTERVAL_MS);
  }

  private stopReconnect() {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  private async tryReconnect() {
    if (!this.reconnectTimer && this.reconnectAttempt > 0) return; // was stopped
    const opts = this.modbusService.getStatus().options;
    if (!opts) { this.stopReconnect(); return; }

    this.reconnectAttempt++;
    this.server?.emit('modbus:status', this.buildStatus());

    try {
      await this.modbusService.connect(opts);
      this.stopReconnect();
      this.server?.emit('modbus:status', this.buildStatus());
    } catch {
      // next attempt scheduled by setInterval
    }
  }

  private buildStatus() {
    return {
      ...this.modbusService.getStatus(),
      reconnecting: this.reconnectTimer !== null,
      attempt: this.reconnectAttempt,
      waitingPort: this.watchedPort?.portPath ?? null,
    };
  }

  // ─── Port watch ────────────────────────────────────────────────────────────

  private startPortWatch(conn: ConnectOptions) {
    this.stopPortWatch();
    this.watchedPort = conn;
    this.portWatchConnecting = false;
    this.server?.emit('modbus:status', this.buildStatus());

    this.portWatchTimer = setInterval(async () => {
      if (this.portWatchConnecting) return;
      this.portWatchConnecting = true;
      try {
        await this.modbusService.connect(this.watchedPort!);
        this.stopPortWatch();
        this.server?.emit('modbus:status', this.buildStatus());
      } catch {
        // порт ещё недоступен, следующая попытка через PORT_WATCH_INTERVAL_MS
      } finally {
        this.portWatchConnecting = false;
      }
    }, PORT_WATCH_INTERVAL_MS);
  }

  private stopPortWatch() {
    if (this.portWatchTimer) {
      clearInterval(this.portWatchTimer);
      this.portWatchTimer = null;
    }
    this.watchedPort = null;
    this.portWatchConnecting = false;
  }

  // ─── Bus scan ──────────────────────────────────────────────────────────────

  @SubscribeMessage('bus:scan:start')
  async handleBusScanStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { from?: number; to?: number },
  ) {
    if (!this.modbusService.isConnected()) {
      client.emit('bus:scan:error', { message: 'Нет подключения к порту' });
      return;
    }
    if (this.scanning) {
      client.emit('bus:scan:error', { message: 'Сканирование уже запущено' });
      return;
    }

    this.stopMonitor();
    this.scanning = true;
    this.scanCancelled = false;

    const from = Math.max(1, payload.from ?? 1);
    const to   = Math.min(247, payload.to ?? 32);

    try {
      const found = await this.modbusService.scanBus(
        from, to,
        (addr, foundSoFar) => {
          client.emit('bus:scan:progress', {
            current: addr - from + 1,
            total: to - from + 1,
            scannedAddr: addr,
            found: foundSoFar,
          });
        },
        () => this.scanCancelled,
      );
      client.emit('bus:scan:done', { found });
    } catch (e) {
      client.emit('bus:scan:error', { message: (e as Error).message });
    } finally {
      this.scanning = false;
    }
  }

  @SubscribeMessage('bus:scan:cancel')
  handleBusScanCancel() {
    this.scanCancelled = true;
  }

  // ─── Умный автопоиск: перебор baud/dataBits/stopBits/parity + скан slaveId ──

  @SubscribeMessage('bus:autodetect:start')
  async handleBusAutoDetectStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { portPath: string; from?: number; to?: number },
  ) {
    if (!payload.portPath) {
      client.emit('bus:autodetect:error', { message: 'portPath is required' });
      return;
    }
    if (this.autoDetecting || this.scanning) {
      client.emit('bus:autodetect:error', { message: 'Поиск уже запущен' });
      return;
    }

    this.stopReconnect();
    this.stopPortWatch();
    this.stopMonitor();
    if (this.modbusService.isConnected()) await this.modbusService.disconnect();

    this.autoDetecting = true;
    this.autoDetectCancelled = false;

    const from = Math.max(1, payload.from ?? 1);
    const to   = Math.min(247, payload.to ?? 32);

    try {
      const combo = await this.modbusService.autoDetectBus(
        payload.portPath, from, to,
        ({ comboIndex, totalCombos, combo }) => {
          client.emit('bus:autodetect:progress', { comboIndex, totalCombos, combo });
        },
        () => this.autoDetectCancelled,
      );

      if (!combo) {
        client.emit('bus:autodetect:notfound');
        return;
      }

      client.emit('bus:autodetect:found', { combo });
      const activeProject = this.projectsService.getActiveProjectId();
      if (activeProject) {
        this.settingsService.saveProjectConnection(activeProject, {
          portPath: combo.portPath,
          baudRate: combo.baudRate,
          dataBits: combo.dataBits,
          stopBits: combo.stopBits,
          parity: combo.parity,
        });
      }
      this.server.emit('modbus:status', this.buildStatus());

      this.scanning = true;
      this.scanCancelled = false;
      try {
        const found = await this.modbusService.scanBus(
          from, to,
          (addr, foundSoFar) => {
            client.emit('bus:scan:progress', {
              current: addr - from + 1,
              total: to - from + 1,
              scannedAddr: addr,
              found: foundSoFar,
            });
          },
          () => this.autoDetectCancelled || this.scanCancelled,
        );
        client.emit('bus:scan:done', { found });
      } finally {
        this.scanning = false;
      }
    } catch (e) {
      client.emit('bus:autodetect:error', { message: (e as Error).message });
    } finally {
      this.autoDetecting = false;
    }
  }

  @SubscribeMessage('bus:autodetect:cancel')
  handleBusAutoDetectCancel() {
    this.autoDetectCancelled = true;
    this.scanCancelled = true;
  }

  // ─── Device identification ─────────────────────────────────────────────────

  private static readonly TEMPLATE_MAP: Record<string, string> = {
    vl:   'Elhart-Emd-VL-Full',
    pump: 'Elhart-Emd-Pump-Full',
  };

  @SubscribeMessage('bus:identify:start')
  async handleBusIdentifyStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { slaveIds: number[] },
  ) {
    if (!this.modbusService.isConnected()) {
      client.emit('bus:identify:error', { message: 'Нет подключения к порту' });
      return;
    }

    for (const slaveId of payload.slaveIds) {
      const model = await this.modbusService.identifyDevice(slaveId);
      const templateId = ModbusGateway.TEMPLATE_MAP[model] ?? null;

      if (model === 'unknown') {
        client.emit('bus:identify:progress', { slaveId, model, error: 'Не удалось определить модель' });
        continue;
      }

      if (!templateId) {
        client.emit('bus:identify:progress', { slaveId, model, error: `Шаблон для ${model.toUpperCase()} не добавлен` });
        continue;
      }

      try {
        const name = `EMD-${model.toUpperCase()}-${slaveId}`;
        const device = this.devicesService.createDevice(templateId, name, slaveId);
        client.emit('bus:identify:progress', { slaveId, model, deviceId: device.id, name: device.name });
      } catch (e) {
        client.emit('bus:identify:progress', { slaveId, model, error: (e as Error).message });
      }
    }

    client.emit('bus:identify:done');
  }

  // ─── Monitor ───────────────────────────────────────────────────────────────

  @SubscribeMessage('monitor:start')
  handleMonitorStart(
    @MessageBody() payload: { deviceId: string; paramIds?: string[] },
  ) {
    this.startMonitor(payload.deviceId, payload.paramIds);
  }

  @SubscribeMessage('monitor:stop')
  handleMonitorStop(
    @MessageBody() payload?: { deviceId?: string },
  ) {
    if (payload?.deviceId) this.stopMonitorFor(payload.deviceId);
    else this.stopMonitor();
  }

  private startMonitor(deviceId: string, paramIds?: string[]) {
    const device = this.devicesService.getById(deviceId);
    if (!device) return;

    const f0 = device.groups.find(g => g.id === 'F0') ?? device.groups[0];
    let params = f0?.params ?? [];
    if (paramIds?.length) {
      const allParams = device.groups.flatMap(g => g.params);
      params = allParams.filter(p => paramIds.includes(p.id));
    }

    this.monitoredDevices.set(deviceId, { slaveId: device.connection.slaveId ?? 1, params });
    this.ensureMonitorLoopRunning();
  }

  // Останавливает мониторинг одного устройства (не трогая остальные — несколько
  // устройств могут мониториться параллельно, например из BulkMonitor).
  private stopMonitorFor(deviceId: string) {
    this.monitoredDevices.delete(deviceId);
  }

  // Раньше у каждого мониторимого устройства был свой независимый setInterval(1000мс) —
  // если реально мониторится несколько устройств, их запросы всё равно серилизуются
  // через один и тот же мьютекс (одна физическая шина RS-485), а независимые таймеры
  // по 1с каждый могли накладываться друг на друга и отставать от реального темпа шины.
  // Теперь один непрерывный round-robin цикл: устройство за устройством, без ожидания
  // между кругами — обновление идёт настолько часто, насколько позволяет сама шина,
  // а не искусственно раз в секунду.
  private async ensureMonitorLoopRunning() {
    if (this.monitorLoopRunning) return;
    this.monitorLoopRunning = true;
    try {
      while (this.monitoredDevices.size > 0) {
        for (const [deviceId, entry] of [...this.monitoredDevices.entries()]) {
          if (!this.monitoredDevices.has(deviceId)) continue; // сняли с мониторинга во время круга
          if (!this.modbusService.isConnected()) break;

          const data: Record<string, any> = {};
          for (const param of entry.params) {
            try {
              const rawValue = await this.modbusService.readRegister(param.register, entry.slaveId);
              data[param.id] = {
                id: param.id,
                name: param.name,
                value: rawValue * (param.scale ?? 1),
                rawValue,
                unit: param.unit ?? '',
                type: param.type,
                options: param.options,
                bits: param.bits,
              };
            } catch (e) {
              data[param.id] = {
                id: param.id,
                name: param.name,
                error: (e as Error).message,
              };
            }
          }
          this.server?.emit('monitor:data', { deviceId, data });
        }
        // Отдаём управление event loop'у между кругами: если шина не подключена —
        // не молотим впустую, ждём немного; если подключена — идём на следующий
        // круг сразу же (максимальная частота, ограниченная только самой шиной).
        await new Promise<void>(resolve => setTimeout(resolve, this.modbusService.isConnected() ? 0 : 500));
      }
    } finally {
      this.monitorLoopRunning = false;
    }
  }

  // Останавливает мониторинг ВСЕХ устройств сразу — используется там, где меняется
  // само соединение с шиной (скан, отключение, смена проекта и т.п.) и продолжать
  // читать регистры больше нельзя ни для одного устройства.
  private stopMonitor() {
    this.monitoredDevices.clear();
  }

  // ─── Групповое чтение/запись (несколько устройств × несколько параметров) ──
  //
  // Раньше это делалось с фронта отдельным HTTP-запросом на каждую пару
  // (устройство, параметр) — при 8 устройствах × 8 параметрах это 64
  // последовательных HTTP round-trip'а. Сам цикл теперь выполняется тут, на
  // бэкенде, одним WebSocket-запросом — так же, как уже работает monitor:start.
  // Это одновременно и быстрее (нет накладных расходов HTTP на каждый параметр),
  // и отмена ("Остановить") реагирует мгновенно между соседними регистрами,
  // а не только между групповыми HTTP-вызовами с фронта.

  @SubscribeMessage('bulk:read:start')
  async handleBulkReadStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: {
      deviceIds: string[];
      paramIds?: string[];
      // Свой список параметров на каждое устройство: { [deviceId]: [paramId] }.
      // Нужен при смешанном выборе Pump+VL — у семейств разные карты регистров,
      // и слать общий (объединённый) список бессмысленно: половина параметров
      // у устройства просто отсутствует, а total получается вдвое завышенным
      // («считано 600 из 1200»). С поимённым списком total точный.
      paramsByDevice?: Record<string, string[]>;
    },
  ) {
    if (this.bulkOpRunning) {
      client.emit('bulk:op:error', { message: 'Групповая операция уже выполняется' });
      return;
    }
    this.bulkOpRunning = true;
    this.bulkOpCancelled = false;
    const paramsFor = (deviceId: string): string[] =>
      payload.paramsByDevice?.[deviceId] ?? payload.paramIds ?? [];
    const total = payload.deviceIds.reduce((sum, id) => sum + paramsFor(id).length, 0);
    client.emit('bulk:op:total', { kind: 'read', total });
    let done = 0;
    let ok = 0;
    // Накопитель прочитанного по устройствам — в конце разом сохраняем в проект
    const readByDevice: Record<string, Record<string, number>> = {};
    // Не прочитавшиеся с первого раза — повторим одним проходом в конце
    const failed: { deviceId: string; slaveId: number; param: DeviceParam; message: string }[] = [];

    outer:
    for (const deviceId of payload.deviceIds) {
      const device = this.devicesService.getById(deviceId);
      if (!device) { done += paramsFor(deviceId).length; continue; }
      const slaveId = device.connection.slaveId ?? 1;
      const allParams = device.groups.flatMap(g => g.params);

      for (const paramId of paramsFor(deviceId)) {
        if (this.bulkOpCancelled) break outer;
        const param = allParams.find(p => p.id === paramId);
        if (!param) { done++; continue; }
        try {
          // Повтор при сбое делаем ЗДЕСЬ, а не внутри readRegister(retries=1):
          // так между попытками проверяется отмена. Иначе «Остановить» ждало
          // ещё один полный таймаут (до ~2 сек) на уже обречённом регистре.
          let rawValue: number;
          try {
            rawValue = await this.modbusService.readRegister(param.register, slaveId);
          } catch (firstErr) {
            if (this.bulkOpCancelled) throw firstErr;
            rawValue = await this.modbusService.readRegister(param.register, slaveId);
          }
          const value = rawValue * (param.scale ?? 1);
          readByDevice[deviceId] = { ...(readByDevice[deviceId] ?? {}), [paramId]: value };
          client.emit('bulk:op:progress', {
            kind: 'read', deviceId, paramId,
            value, unit: param.unit, name: param.name,
            type: param.type, options: param.options, bits: param.bits,
          });
          ok++;
        } catch (e) {
          // Не рапортуем об ошибке сразу — соберём и попробуем ещё раз в конце,
          // когда шина «успокоится» (см. финальный проход ниже).
          failed.push({ deviceId, slaveId, param, message: (e as Error).message });
        }
        done++;
      }
    }

    // Финальный проход по не прочитавшимся параметрам: единичные сбои на RS-485
    // (таймаут, битый CRC, коллизия) обычно уже не повторяются, а повтор сразу
    // на месте попадает в ту же «плохую» секунду. Событие прогресса по такому
    // параметру отправляется ровно один раз — здесь, по итогу второй попытки.
    if (failed.length && !this.bulkOpCancelled) {
      for (const f of failed) {
        if (this.bulkOpCancelled) break;
        try {
          const rawValue = await this.modbusService.readRegister(f.param.register, f.slaveId);
          const value = rawValue * (f.param.scale ?? 1);
          readByDevice[f.deviceId] = { ...(readByDevice[f.deviceId] ?? {}), [f.param.id]: value };
          client.emit('bulk:op:progress', {
            kind: 'read', deviceId: f.deviceId, paramId: f.param.id,
            value, unit: f.param.unit, name: f.param.name,
            type: f.param.type, options: f.param.options, bits: f.param.bits,
          });
          ok++;
        } catch (e) {
          client.emit('bulk:op:progress', {
            kind: 'read', deviceId: f.deviceId, paramId: f.param.id,
            name: f.param.name, error: (e as Error).message,
          });
        }
      }
    } else if (failed.length) {
      // Операцию отменили — просто сообщаем об ошибках как есть.
      for (const f of failed) {
        client.emit('bulk:op:progress', {
          kind: 'read', deviceId: f.deviceId, paramId: f.param.id, name: f.param.name, error: f.message,
        });
      }
    }

    // Сохраняем прочитанное как «значение на устройстве» для КАЖДОГО ПЧ, а не
    // только когда читали один: на этих значениях строится сравнение
    // «старое/новое» перед записью, и без них защита от перезаписи слепа.
    this.devicesService.mergeManyDevicesCurrentValues(readByDevice);

    this.bulkOpRunning = false;
    client.emit('bulk:op:done', { kind: 'read', done, ok, total, cancelled: this.bulkOpCancelled });
  }

  @SubscribeMessage('bulk:write:start')
  async handleBulkWriteStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: {
      deviceIds: string[];
      // Два режима:
      //  - values: общие значения для всех устройств (сброс до заводских и т.п.)
      //  - usePending: у КАЖДОГО устройства пишутся его «эффективные» подготовленные
      //    значения — заводские по умолчанию во всех записываемых параметрах +
      //    сохранённые правки/шаблон поверх (getEffectivePendingWrites),
      //    опционально ограниченные paramIds (группой). Значения НЕ очищаются
      //    после записи — их можно записать повторно.
      values?: Record<string, number>;
      usePending?: boolean;
      paramIds?: string[];
      // Параметры, которые НЕ надо трогать, по каждому устройству отдельно:
      // { [deviceId]: [paramId, ...] }. Используется защитой от случайной
      // перезаписи — оператор снял галочку с конкретного параметра в
      // предупреждении «заводское затрёт настроенное значение».
      skip?: Record<string, string[]>;
    },
  ) {
    if (this.bulkOpRunning) {
      client.emit('bulk:op:error', { message: 'Групповая операция уже выполняется' });
      return;
    }
    this.bulkOpRunning = true;
    this.bulkOpCancelled = false;

    // Планируем задания заранее — в режиме usePending у каждого устройства свой
    // набор параметров, и total известен только после сбора всех pendingWrites.
    const jobs: { deviceId: string; values: Record<string, number> }[] = [];
    for (const deviceId of payload.deviceIds) {
      const skipSet = new Set(payload.skip?.[deviceId] ?? []);
      if (payload.usePending) {
        const pending = this.devicesService.getEffectivePendingWrites(deviceId);
        const values: Record<string, number> = {};
        for (const [paramId, value] of Object.entries(pending)) {
          if (payload.paramIds && !payload.paramIds.includes(paramId)) continue;
          if (skipSet.has(paramId)) continue;
          if (typeof value !== 'number') continue;
          values[paramId] = value;
        }
        jobs.push({ deviceId, values });
      } else {
        const values: Record<string, number> = {};
        for (const [paramId, value] of Object.entries(payload.values ?? {})) {
          if (skipSet.has(paramId)) continue;
          values[paramId] = value;
        }
        jobs.push({ deviceId, values });
      }
    }
    const total = jobs.reduce((sum, j) => sum + Object.keys(j.values).length, 0);
    client.emit('bulk:op:total', { kind: 'write', total });
    let done = 0;
    let ok = 0;

    outer:
    for (const job of jobs) {
      const device = this.devicesService.getById(job.deviceId);
      const paramIds = Object.keys(job.values);
      if (!device) { done += paramIds.length; continue; }
      const slaveId = device.connection.slaveId ?? 1;
      const allParams = device.groups.flatMap(g => g.params);

      for (const paramId of paramIds) {
        if (this.bulkOpCancelled) break;
        const param = allParams.find(p => p.id === paramId);
        if (!param || !this.devicesService.isParamWritable(device, param)) { done++; continue; }
        const rawValue = Math.round(job.values[paramId] / (param.scale ?? 1));
        try {
          // Повтор с проверкой отмены между попытками — см. комментарий в
          // групповом чтении: иначе «Остановить» ждёт лишний таймаут.
          try {
            await this.modbusService.writeRegister(param.register, rawValue, slaveId);
          } catch (firstErr) {
            if (this.bulkOpCancelled) throw firstErr;
            await this.modbusService.writeRegister(param.register, rawValue, slaveId);
          }
          client.emit('bulk:op:progress', {
            kind: 'write', deviceId: job.deviceId, paramId,
            value: job.values[paramId], unit: param.unit, name: param.name,
            type: param.type, options: param.options, bits: param.bits,
          });
          ok++;
        } catch (e) {
          client.emit('bulk:op:progress', {
            kind: 'write', deviceId: job.deviceId, paramId, name: param.name, error: (e as Error).message,
          });
        }
        done++;
      }

      // Подготовленные значения НЕ очищаем после записи (в отличие от прежнего
      // поведения): человек на объекте может записать их повторно, а overrides
      // остаются в проекте.

      if (this.bulkOpCancelled) break outer;
    }

    this.bulkOpRunning = false;
    client.emit('bulk:op:done', { kind: 'write', done, ok, total, cancelled: this.bulkOpCancelled });
  }

  @SubscribeMessage('bulk:op:cancel')
  handleBulkOpCancel() {
    this.bulkOpCancelled = true;
  }

  // ─── Индикатор связи по каждому устройству ─────────────────────────────────
  //
  // Общий статус "порт подключён/нет" (modbus:status) не говорит, отвечает ли
  // КОНКРЕТНОЕ устройство на своём Slave ID/с текущими настройками подключения —
  // на реальном железе устройство может быть выключено, отключено от шины или
  // настроено на другой адрес, а порт при этом будет открыт нормально. Этот
  // цикл в фоне постоянно и по чуть-чуть (короткий таймаут на попытку, пауза
  // между кругами) пробует каждое устройство активного проекта и шлёт
  // device:liveness только когда статус реально меняется.
  private async ensureLivenessLoopRunning() {
    if (this.livenessLoopRunning) return;
    this.livenessLoopRunning = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!this.modbusService.isConnected()) {
          if (this.deviceLiveness.size > 0) {
            for (const deviceId of this.deviceLiveness.keys()) {
              this.server?.emit('device:liveness', { deviceId, online: false });
            }
            this.deviceLiveness.clear();
          }
          await new Promise<void>(resolve => setTimeout(resolve, 2000));
          continue;
        }

        const devices = this.devicesService.getAll().filter(d => !d.template);
        if (devices.length === 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 2000));
          continue;
        }

        for (const device of devices) {
          if (!this.modbusService.isConnected()) break;
          const slaveId = device.connection.slaveId ?? 1;
          const online = await this.modbusService.probeAddress(slaveId, 200);
          if (this.deviceLiveness.get(device.id) !== online) {
            this.deviceLiveness.set(device.id, online);
            this.server?.emit('device:liveness', { deviceId: device.id, online });
          }
        }
        // Пауза между полными кругами — это фоновая низкоприоритетная проверка,
        // ей не нужно молотить мьютекс так же агрессивно, как чтению/мониторингу.
        await new Promise<void>(resolve => setTimeout(resolve, 1500));
      }
    } finally {
      this.livenessLoopRunning = false;
    }
  }
}
