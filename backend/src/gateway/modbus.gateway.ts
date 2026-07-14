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

  private monitorIntervals = new Map<string, NodeJS.Timeout>();
  private scanning = false;
  private scanCancelled = false;
  private autoDetecting = false;
  private autoDetectCancelled = false;

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
      const activeProject = this.projectsService.getActiveProjectId();
      if (activeProject) {
        this.settingsService.saveProjectConnection(activeProject, {
          portPath: payload.portPath,
          baudRate: payload.baudRate,
        });
      }
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
    vh:   'Elhart-Emd-VH-Full',
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
    this.stopMonitorFor(deviceId);

    const device = this.devicesService.getById(deviceId);
    if (!device) return;

    const f0 = device.groups.find(g => g.id === 'F0') ?? device.groups[0];
    let params = f0?.params ?? [];
    if (paramIds?.length) {
      const allParams = device.groups.flatMap(g => g.params);
      params = allParams.filter(p => paramIds.includes(p.id));
    }

    const slaveId = device.connection.slaveId ?? 1;

    const interval = setInterval(async () => {
      if (!this.modbusService.isConnected()) return;

      const data: Record<string, any> = {};
      for (const param of params) {
        try {
          const rawValue = await this.modbusService.readRegister(param.register, slaveId);
          data[param.id] = {
            id: param.id,
            name: param.name,
            value: rawValue * (param.scale ?? 1),
            rawValue,
            unit: param.unit ?? '',
          };
        } catch (e) {
          data[param.id] = {
            id: param.id,
            name: param.name,
            error: (e as Error).message,
          };
        }
      }

      this.server.emit('monitor:data', { deviceId, data });
    }, 1000);

    this.monitorIntervals.set(deviceId, interval);
  }

  // Останавливает мониторинг одного устройства (не трогая остальные — несколько
  // устройств могут мониториться параллельно, например из BulkMonitor).
  private stopMonitorFor(deviceId: string) {
    const interval = this.monitorIntervals.get(deviceId);
    if (interval) {
      clearInterval(interval);
      this.monitorIntervals.delete(deviceId);
    }
  }

  // Останавливает мониторинг ВСЕХ устройств сразу — используется там, где меняется
  // само соединение с шиной (скан, отключение, смена проекта и т.п.) и продолжать
  // читать регистры больше нельзя ни для одного устройства.
  private stopMonitor() {
    for (const interval of this.monitorIntervals.values()) clearInterval(interval);
    this.monitorIntervals.clear();
  }
}
