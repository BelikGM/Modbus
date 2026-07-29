import { Injectable, OnModuleInit, OnModuleDestroy, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { FSWatcher } from 'chokidar';
import { DeviceConfig, DeviceParam } from './device.types';
import { ProjectsService } from '../projects/projects.service';
import { DeviceInstance, DeviceNote } from '../projects/project.types';

@Injectable()
export class DevicesService implements OnModuleInit, OnModuleDestroy {
  readonly events = new EventEmitter();

  private templates = new Map<string, DeviceConfig>();
  private templateFileToId = new Map<string, string>();

  private instances = new Map<string, DeviceInstance>();

  private templateWatcher: FSWatcher | null = null;

  readonly devicesPath: string;
  readonly templatesPath: string;

  constructor(private readonly projectsService: ProjectsService) {
    this.devicesPath = path.join(process.cwd(), '..', 'devices');
    this.templatesPath = path.join(this.devicesPath, 'templates');
  }

  async onModuleInit() {
    fs.mkdirSync(this.templatesPath, { recursive: true });
    this.loadAllTemplates();
    await this.startTemplateWatcher();
    this.loadActiveProjectInstances();
    this.projectsService.events.on('project:changed', () => this.reloadProject());
  }

  onModuleDestroy() {
    this.templateWatcher?.close();
  }

  // ─── Templates ─────────────────────────────────────────────────────────────

  private loadAllTemplates() {
    if (!fs.existsSync(this.templatesPath)) return;
    for (const file of fs.readdirSync(this.templatesPath).filter(f => f.endsWith('.json'))) {
      this.loadTemplateFile(path.join(this.templatesPath, file));
    }
  }

  private loadTemplateFile(filePath: string): DeviceConfig | null {
    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DeviceConfig;
      const prevId = this.templateFileToId.get(filePath);
      if (prevId && prevId !== config.id) this.templates.delete(prevId);
      this.templateFileToId.set(filePath, config.id);
      this.templates.set(config.id, { ...config, template: true });
      return config;
    } catch {
      return null;
    }
  }

  private async startTemplateWatcher() {
    const chokidar = await import('chokidar');
    this.templateWatcher = chokidar.watch(this.templatesPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.templateWatcher.on('add', (fp: string) => {
      if (!fp.endsWith('.json')) return;
      const c = this.loadTemplateFile(fp);
      if (c) this.events.emit('device:added', c);
    });
    this.templateWatcher.on('change', (fp: string) => {
      if (!fp.endsWith('.json')) return;
      const c = this.loadTemplateFile(fp);
      if (c) this.events.emit('device:changed', c);
    });
    this.templateWatcher.on('unlink', (fp: string) => {
      const id = this.templateFileToId.get(fp);
      if (id) {
        this.templates.delete(id);
        this.templateFileToId.delete(fp);
        this.events.emit('device:removed', id);
      }
    });
  }

  // ─── Instances ─────────────────────────────────────────────────────────────

  private loadActiveProjectInstances() {
    this.instances.clear();
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) return;
    for (const inst of this.projectsService.loadInstances(projectId)) {
      this.instances.set(inst.id, inst);
    }
  }

  private reloadProject() {
    this.loadActiveProjectInstances();
    this.events.emit('devices:reloaded');
  }

  // ─── Merge ─────────────────────────────────────────────────────────────────

  // Шаблон Elhart-Emd-VH-Full переименован в Elhart-Emd-VL-Full (серии VL и VH
  // покрываются одним руководством и картой регистров; фактически используемые
  // насосы — VL). Старые проекты могли сохранить инстансы со старым templateId —
  // прозрачно перенаправляем их на новый шаблон, чтобы устройства не пропали.
  private static readonly TEMPLATE_ALIASES: Record<string, string> = {
    'Elhart-Emd-VH-Full': 'Elhart-Emd-VL-Full',
  };

  private merge(instance: DeviceInstance): DeviceConfig | null {
    const templateId =
      this.templates.has(instance.templateId)
        ? instance.templateId
        : (DevicesService.TEMPLATE_ALIASES[instance.templateId] ?? instance.templateId);
    const template = this.templates.get(templateId);
    if (!template) return null;
    return {
      ...template,
      id: instance.id,
      name: instance.name,
      template: false,
      templateId,
      connection: { ...template.connection, ...instance.connection },
    };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  getAll(): DeviceConfig[] {
    const result: DeviceConfig[] = [];
    for (const t of this.templates.values()) result.push(t);
    for (const inst of this.instances.values()) {
      const merged = this.merge(inst);
      if (merged) result.push(merged);
    }
    return result;
  }

  getById(id: string): DeviceConfig | null {
    const inst = this.instances.get(id);
    if (inst) return this.merge(inst);
    return this.templates.get(id) ?? null;
  }

  findParam(deviceId: string, paramId: string): DeviceParam | null {
    const device = this.getById(deviceId);
    if (!device) return null;
    for (const group of device.groups) {
      const param = group.params.find(p => p.id === paramId);
      if (param) return param;
    }
    return null;
  }

  isParamWritable(device: DeviceConfig, param: DeviceParam): boolean {
    if (device.access_legend) {
      const description = device.access_legend[param.access];
      if (description === undefined) return false;
      return !description.includes('только чтение');
    }
    return param.access === 'read-write';
  }

  getTemplates(): DeviceConfig[] {
    return Array.from(this.templates.values());
  }

  createDevice(templateId: string, name: string, slaveId: number): DeviceConfig {
    const template = this.templates.get(templateId);
    if (!template) throw new NotFoundException(`Шаблон '${templateId}' не найден`);

    let projectId = this.projectsService.getActiveProjectId();
    if (!projectId) {
      const meta = this.projectsService.createProject(this.projectsService.generateDefaultProjectName());
      this.projectsService.setActiveProject(meta.id);
      projectId = meta.id;
    }

    const baseName = name.trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '') || `device_${Date.now()}`;
    let id = baseName;
    let counter = 2;
    while (this.instances.has(id)) {
      id = `${baseName}_${counter++}`;
    }

    const duplicate = Array.from(this.instances.values()).find(i => i.connection.slaveId === slaveId);
    if (duplicate) throw new BadRequestException(`Устройство со Slave ID ${slaveId} уже существует (${duplicate.id})`);

    const instance: DeviceInstance = { id, name, templateId, connection: { slaveId } };
    this.instances.set(id, instance);
    this.projectsService.writeInstance(projectId, instance);
    const merged = this.merge(instance)!;
    this.events.emit('device:added', merged);
    return merged;
  }

  updateDevice(id: string, patch: { name?: string; slaveId?: number }): DeviceConfig {
    const instance = this.instances.get(id);
    if (!instance) {
      if (this.templates.has(id)) throw new BadRequestException('Нельзя редактировать шаблон');
      throw new NotFoundException(`Устройство '${id}' не найдено`);
    }

    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) throw new BadRequestException('Нет активного проекта');

    let newId = id;
    if (patch.name !== undefined) {
      const base = patch.name.trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '') || id;
      newId = base;
      let counter = 2;
      while (newId !== id && this.instances.has(newId)) {
        newId = `${base}_${counter++}`;
      }
    }

    if (patch.slaveId !== undefined) {
      const duplicate = Array.from(this.instances.values()).find(
        i => i.id !== id && i.connection.slaveId === patch.slaveId,
      );
      if (duplicate) throw new BadRequestException(`Устройство со Slave ID ${patch.slaveId} уже существует (${duplicate.id})`);
    }

    const updated: DeviceInstance = {
      ...instance,
      id: newId,
      ...(patch.name !== undefined && { name: patch.name }),
      connection: {
        ...instance.connection,
        ...(patch.slaveId !== undefined && { slaveId: patch.slaveId }),
      },
    };

    if (newId !== id) {
      this.projectsService.deleteInstance(projectId, id);
      this.instances.delete(id);
      this.events.emit('device:id:changed', { oldId: id, newId });
    }
    this.projectsService.writeInstance(projectId, updated);
    this.instances.set(newId, updated);

    const merged = this.merge(updated)!;
    // Важно эмитить и когда id НЕ поменялся (правка slaveId без переименования) —
    // иначе фронт узнавал об изменении только косвенно, при следующем несвязанном
    // событии (например при добавлении другого устройства), и правки казались
    // "не сохранившимися".
    this.events.emit('device:changed', merged);
    return merged;
  }

  getDevicePendingWrites(id: string): Record<string, any> {
    const instance = this.instances.get(id);
    return instance?.pendingWrites ?? {};
  }

  // «Эффективные» подготовленные значения = заводское значение по умолчанию для
  // КАЖДОГО записываемого параметра с числовым default, поверх которого ложатся
  // сохранённые в проекте ручные правки и значения из шаблона (overrides). Так у
  // только что добавленного ПЧ во всех полях всех групп сразу стоит заводское
  // значение, а «Записать всё» приводит устройство к известному состоянию,
  // перетирая чужие правки, кроме параметров, которые мы намеренно поменяли.
  // В файле проекта хранятся ТОЛЬКО overrides (компактно и переживает правки
  // шаблона); заводская база подставляется на лету. Overrides НЕ очищаются после
  // записи — человек на объекте может нажать «Записать» повторно.
  getEffectivePendingWrites(id: string): Record<string, number> {
    const device = this.getById(id);
    if (!device) return {};
    const result: Record<string, number> = {};
    for (const group of device.groups) {
      // Группы настроек связи (RS-485: адрес на шине, скорость, формат) НИКОГДА
      // не попадают в автоматическую «заводскую» подложку. Заводской адрес у
      // всех моделей = 1: запись его во все ПЧ разом посадила бы всю шину на
      // один адрес, а сброс скорости — оборвал бы связь. Восстанавливать
      // пришлось бы, подключая устройства по одному. Менять эти параметры
      // можно только вручную, по одной строке.
      if (group.protectedFromBulk) continue;
      for (const param of group.params) {
        if (!this.isParamWritable(device, param)) continue;
        if (typeof param.default === 'number') result[param.id] = param.default;
      }
    }
    const stored = this.getDevicePendingWrites(id);
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === 'number') result[key] = value;
    }
    return result;
  }

  updateDevicePendingWrites(id: string, pendingWrites: Record<string, any>): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) return;
    const updated = { ...instance, pendingWrites };
    this.instances.set(id, updated);
    this.projectsService.writeInstance(projectId, updated);
  }

  // Вливает patch в существующие pendingWrites устройства (null/undefined в
  // значении — удалить ключ). В отличие от updateDevicePendingWrites не трогает
  // ключи, которых нет в patch.
  mergeDevicePendingWrites(id: string, patch: Record<string, any>): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    const merged = { ...(instance.pendingWrites ?? {}) };
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === null || value === undefined) delete merged[key];
      else merged[key] = value;
    }
    this.updateDevicePendingWrites(id, merged);
  }

  // Вливает один и тот же patch в pendingWrites сразу нескольких устройств и
  // сохраняет проект ОДНИМ перезаписыванием файла (а не N — как было бы при
  // отдельном PATCH на каждое устройство). Используется опцией «Все выбранные
  // ПЧ» в редакторе подготовленных значений: правка значения применяется ко
  // всем выбранным ПЧ разом.
  mergeManyDevicesPendingWrites(ids: string[], patch: Record<string, any>): void {
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) return;
    const updated: DeviceInstance[] = [];
    for (const id of ids) {
      const instance = this.instances.get(id);
      if (!instance) continue;
      const merged = { ...(instance.pendingWrites ?? {}) };
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === null || value === undefined) delete merged[key];
        else merged[key] = value;
      }
      const next = { ...instance, pendingWrites: merged };
      this.instances.set(id, next);
      updated.push(next);
    }
    this.projectsService.writeInstances(projectId, updated);
  }

  // Вливает прочитанные значения сразу нескольким устройствам и сохраняет
  // проект ОДНИМ перезаписыванием файла. Вызывается после группового чтения:
  // раньше «значение на устройстве» сохранялось только когда читали ОДИН ПЧ, а
  // при групповом чтении/выгрузке CSV значения жили лишь в таблице на экране —
  // из-за этого защита от перезаписи (OverwriteGuard) не с чем было сравнивать.
  mergeManyDevicesCurrentValues(patchByDevice: Record<string, Record<string, any>>): void {
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) return;
    const updated: DeviceInstance[] = [];
    for (const [id, patch] of Object.entries(patchByDevice ?? {})) {
      const instance = this.instances.get(id);
      if (!instance || !patch || Object.keys(patch).length === 0) continue;
      const merged = { ...(instance.currentValues ?? {}), ...patch };
      const next = { ...instance, currentValues: merged };
      this.instances.set(id, next);
      updated.push(next);
    }
    if (updated.length) this.projectsService.writeInstances(projectId, updated);
  }

  getDeviceCurrentValues(id: string): Record<string, any> {
    const instance = this.instances.get(id);
    return instance?.currentValues ?? {};
  }

  updateDeviceCurrentValues(id: string, currentValues: Record<string, any>): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) return;
    const updated = { ...instance, currentValues };
    this.instances.set(id, updated);
    this.projectsService.writeInstance(projectId, updated);
  }

  getDeviceNotes(id: string): DeviceNote[] {
    return this.instances.get(id)?.notes ?? [];
  }

  addDeviceNote(id: string, text: string): DeviceNote {
    const instance = this.instances.get(id);
    if (!instance) throw new NotFoundException(`Устройство '${id}' не найдено`);
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) throw new BadRequestException('Нет активного проекта');
    const note: DeviceNote = { id: Date.now().toString(), createdAt: new Date().toISOString(), text };
    const updated = { ...instance, notes: [...(instance.notes ?? []), note] };
    this.instances.set(id, updated);
    this.projectsService.writeInstance(projectId, updated);
    return note;
  }

  updateDeviceNote(id: string, noteId: string, text: string): DeviceNote {
    const instance = this.instances.get(id);
    if (!instance) throw new NotFoundException(`Устройство '${id}' не найдено`);
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) throw new BadRequestException('Нет активного проекта');
    const notes = instance.notes ?? [];
    const idx = notes.findIndex(n => n.id === noteId);
    if (idx === -1) throw new NotFoundException(`Запись '${noteId}' не найдена`);
    const updated_note: DeviceNote = { ...notes[idx], text };
    const updatedNotes = [...notes.slice(0, idx), updated_note, ...notes.slice(idx + 1)];
    const updated = { ...instance, notes: updatedNotes };
    this.instances.set(id, updated);
    this.projectsService.writeInstance(projectId, updated);
    return updated_note;
  }

  deleteDeviceNote(id: string, noteId: string): void {
    const instance = this.instances.get(id);
    if (!instance) throw new NotFoundException(`Устройство '${id}' не найдено`);
    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) throw new BadRequestException('Нет активного проекта');
    const updated = { ...instance, notes: (instance.notes ?? []).filter(n => n.id !== noteId) };
    this.instances.set(id, updated);
    this.projectsService.writeInstance(projectId, updated);
  }

  deleteDevice(id: string): void {
    if (this.templates.has(id)) throw new BadRequestException('Нельзя удалить шаблон');
    if (!this.instances.has(id)) throw new NotFoundException(`Устройство '${id}' не найдено`);
    const projectId = this.projectsService.getActiveProjectId();
    if (projectId) this.projectsService.deleteInstance(projectId, id);
    this.instances.delete(id);
    this.events.emit('device:removed', id);
  }
}
