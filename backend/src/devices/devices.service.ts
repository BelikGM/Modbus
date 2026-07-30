import { Injectable, OnModuleInit, OnModuleDestroy, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { FSWatcher } from 'chokidar';
import { DeviceConfig, DeviceParam, ParamGroup } from './device.types';
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
  // Свои типы ПЧ живут ОТДЕЛЬНО от поставки — в папке данных.
  // В папку поставки писать нельзя: при установке обновления она заменяется
  // целиком (созданные типы пропали бы), а если программа стоит в Program Files,
  // запись туда вообще запрещена системой.
  readonly userTemplatesPath: string;

  constructor(private readonly projectsService: ProjectsService) {
    this.devicesPath = path.join(process.cwd(), '..', 'devices');
    this.templatesPath = path.join(this.devicesPath, 'templates');
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    this.userTemplatesPath = path.join(userDataPath, 'templates');
  }

  async onModuleInit() {
    fs.mkdirSync(this.templatesPath, { recursive: true });
    fs.mkdirSync(this.userTemplatesPath, { recursive: true });
    this.migrateCustomTemplates();
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
    // Сначала поставка, затем свои: при совпадении id свой тип перекрывает
    // штатный (пользователь явно этого хотел), а не наоборот.
    for (const dir of [this.templatesPath, this.userTemplatesPath]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        this.loadTemplateFile(path.join(dir, file));
      }
    }
  }

  // Разовый перенос типов, созданных до разделения папок: они лежали среди
  // файлов поставки и потерялись бы при первом же обновлении программы.
  private migrateCustomTemplates() {
    if (!fs.existsSync(this.templatesPath)) return;
    for (const file of fs.readdirSync(this.templatesPath).filter(f => f.endsWith('.json'))) {
      const from = path.join(this.templatesPath, file);
      try {
        const raw = JSON.parse(this.stripJsonComments(fs.readFileSync(from, 'utf-8')));
        if (raw?.custom !== true) continue;
        const to = path.join(this.userTemplatesPath, file);
        if (fs.existsSync(to)) continue;
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
        console.log(`[templates] свой тип «${raw.id ?? file}» перенесён в папку данных`);
      } catch {
        // битый файл — не наше дело, о нём сообщит loadTemplateFile
      }
    }
  }

  // Файл принадлежит пользователю (его можно менять и удалять), если лежит
  // в папке данных. Признак определяется расположением, а не полем в JSON:
  // так штатный файл нельзя «сделать своим», подправив в нём одну строчку.
  private isUserTemplateFile(filePath: string): boolean {
    return path.resolve(filePath).startsWith(path.resolve(this.userTemplatesPath) + path.sep);
  }

  // Ошибки разбора шаблонов: имя файла -> текст ошибки. Раньше битый файл
  // отбрасывался молча, и «почему нового типа ПЧ нет в списке» выяснить было
  // невозможно (типичная причина — комментарии `//` в JSON, их формат не
  // допускает). Теперь ошибка доходит до интерфейса.
  readonly templateErrors = new Map<string, string>();

  // Убирает из JSON комментарии `//` и `/* */`, не трогая их внутри строк
  // (иначе пострадали бы пути и URL вида "https://..."). Формат JSON комментарии
  // не допускает, но в файлах-шаблонах они очень полезны — поэтому здесь
  // поддерживается «JSON с комментариями»: файл остаётся читаемым для человека,
  // а на разбор уходит уже очищенный текст. Хвостовые запятые тоже убираются.
  private stripJsonComments(text: string): string {
    let out = '';
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];
      if (inLine) {
        if (c === '\n') { inLine = false; out += c; }
        continue;
      }
      if (inBlock) {
        if (c === '*' && next === '/') { inBlock = false; i++; }
        continue;
      }
      if (inString) {
        out += c;
        if (c === '\\') { out += next ?? ''; i++; continue; }  // экранированный символ
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === '/' && next === '/') { inLine = true; i++; continue; }
      if (c === '/' && next === '*') { inBlock = true; i++; continue; }
      out += c;
    }
    // хвостовые запятые перед } или ]
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  private loadTemplateFile(filePath: string): DeviceConfig | null {
    const fileName = path.basename(filePath);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const config = JSON.parse(this.stripJsonComments(raw)) as DeviceConfig;
      if (!config.id || !Array.isArray(config.groups)) {
        throw new Error('в файле нет обязательных полей "id" и "groups"');
      }
      const prevId = this.templateFileToId.get(filePath);
      if (prevId && prevId !== config.id) this.templates.delete(prevId);
      this.templateFileToId.set(filePath, config.id);
      this.templates.set(config.id, { ...config, template: true, custom: this.isUserTemplateFile(filePath) });
      this.templateErrors.delete(fileName);
      this.events.emit('templates:errors', this.getTemplateErrors());
      return config;
    } catch (e) {
      const raw = (e as Error).message ?? String(e);
      // Комментарии теперь поддерживаются (см. stripJsonComments), поэтому
      // подсказываем про другую частую причину — оборванную структуру.
      const hint = /Unexpected end|Expected/.test(raw)
        ? ' — проверьте парность скобок { } [ ] и кавычек'
        : '';
      this.templateErrors.set(fileName, raw + hint);
      this.events.emit('templates:errors', this.getTemplateErrors());
      return null;
    }
  }

  getTemplateErrors(): { file: string; message: string }[] {
    return Array.from(this.templateErrors, ([file, message]) => ({ file, message }));
  }

  private async startTemplateWatcher() {
    const chokidar = await import('chokidar');
    this.templateWatcher = chokidar.watch([this.templatesPath, this.userTemplatesPath], {
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
    this.templateWatcher.on('unlink', (fp: string) => this.forgetTemplateFile(fp));
  }

  // Файл шаблона исчез. Если тот же id есть и в другой папке (свой тип
  // перекрывал штатный), возвращаем оставшийся файл, а не «теряем» тип целиком.
  private forgetTemplateFile(filePath: string) {
    const id = this.templateFileToId.get(filePath);
    if (!id) return;
    this.templates.delete(id);
    this.templateFileToId.delete(filePath);
    const survivor = Array.from(this.templateFileToId).find(([, tid]) => tid === id)?.[0];
    if (survivor && fs.existsSync(survivor)) {
      const c = this.loadTemplateFile(survivor);
      if (c) { this.events.emit('device:changed', this.templates.get(id)!); return; }
    }
    this.events.emit('device:removed', id);
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

  // Возвращает группы параметров шаблона с наложенными правками выбранной
  // прошивки. Если прошивка не выбрана или правок для неё нет — отдаём как есть
  // (важно: НЕ угадываем версию, иначе можно молча исказить значения).
  private applyFirmwareOverrides(template: DeviceConfig, firmware?: string): ParamGroup[] {
    const overrides = firmware ? template.firmwareOverrides?.[firmware] : undefined;
    if (!overrides) return template.groups;
    return template.groups.map(group => ({
      ...group,
      params: group.params.map(param =>
        overrides[param.id] ? { ...param, ...overrides[param.id] } : param,
      ),
    }));
  }

  private merge(instance: DeviceInstance): DeviceConfig | null {
    const templateId =
      this.templates.has(instance.templateId)
        ? instance.templateId
        : (DevicesService.TEMPLATE_ALIASES[instance.templateId] ?? instance.templateId);
    const rawTemplate = this.templates.get(templateId);
    if (!rawTemplate) return null;
    const template = this.withExtras(rawTemplate);
    return {
      ...template,
      id: instance.id,
      name: instance.name,
      template: false,
      templateId,
      model: instance.model,
      firmware: instance.firmware,
      // Правки под выбранную прошивку применяем прямо к параметрам: например у
      // EMD-PUMP v2.0 температура отдаётся с десятыми (регистр 380 = 38.0 °C),
      // а у v1.2 — целыми. Без этого одно и то же значение читалось бы как
      // 380 °C и ложно срабатывал бы порог перегрева.
      groups: this.applyFirmwareOverrides(template, instance.firmware),
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
    const tpl = this.templates.get(id);
    return tpl ? this.withExtras(tpl) : null;
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
    return Array.from(this.templates.values()).map(t => this.withExtras(t));
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

  updateDevice(id: string, patch: { name?: string; slaveId?: number; model?: string; firmware?: string; templateId?: string }): DeviceConfig {
    const instance = this.instances.get(id);
    if (!instance) {
      if (this.templates.has(id)) throw new BadRequestException('Нельзя редактировать шаблон');
      throw new NotFoundException(`Устройство '${id}' не найдено`);
    }

    const projectId = this.projectsService.getActiveProjectId();
    if (!projectId) throw new BadRequestException('Нет активного проекта');

    const typeChanged = patch.templateId !== undefined && patch.templateId !== instance.templateId;
    if (typeChanged && !this.templates.has(patch.templateId!)) {
      throw new BadRequestException(`Шаблон '${patch.templateId}' не найден`);
    }

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
      // Смена типа (шаблона) — у нового типа своя карта регистров, поэтому
      // модель, прошивка и все подготовленные/прочитанные значения от прежнего
      // типа теряют смысл и сбрасываются, иначе остались бы значения по чужим
      // адресам регистров.
      ...(typeChanged && {
        templateId: patch.templateId!,
        model: undefined,
        firmware: undefined,
        pendingWrites: {},
        currentValues: {},
      }),
      ...(!typeChanged && patch.model !== undefined && { model: patch.model }),
      ...(!typeChanged && patch.firmware !== undefined && { firmware: patch.firmware }),
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
  // ВАЖНО (изменено осознанно): подставлять заводские значения во все
  // незаполненные поля БОЛЬШЕ НЕЛЬЗЯ. Заводские значения в шаблоне — общие для
  // модели, а у конкретного исполнения (версия прошивки, мощность) часть из них
  // отличается; запись «по умолчанию» вслепую означала бы запись наугад в
  // параметры, которые оператор менять не собирался. Теперь пишется ТОЛЬКО то,
  // что реально подготовлено — вручную или из шаблона. Если не подготовлено
  // ничего, запись не выполняется вовсе.
  getEffectivePendingWrites(id: string): Record<string, number> {
    const stored = this.getDevicePendingWrites(id);
    const result: Record<string, number> = {};
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

  // ─── Редактор типов ПЧ (шаблонов) ──────────────────────────────────────────
  //
  // Позволяет создавать свои типы прямо на объекте, не дожидаясь нового
  // инсталлятора: тип можно собрать с нуля или на основе уже имеющихся, отобрав
  // нужные группы и отдельные параметры. Файлы кладутся в ту же папку
  // devices/templates и подхватываются наблюдателем автоматически.
  //
  // Штатные шаблоны (поставляются с программой) защищены от изменения и
  // удаления: пользовательские помечаются `custom: true`. Иначе правка «под
  // объект» испортила бы эталон, и восстановить его можно было бы только
  // переустановкой.

  // ─── Дополнения к ШТАТНЫМ типам ────────────────────────────────────────────
  //
  // Штатный шаблон править нельзя (иначе эталон не восстановить), но каталог
  // исполнений и список прошивок пользователю дополнять нужно — производитель
  // выпускает новые. Такие дополнения храним ОТДЕЛЬНО в userData и подмешиваем
  // при выдаче: файл поставки остаётся нетронутым, а данные переживают
  // обновление программы.
  private extrasPath(): string {
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    return path.join(userDataPath, 'template-extras.json');
  }

  private loadExtras(): Record<string, { models?: any[]; firmwares?: string[] }> {
    try {
      const f = this.extrasPath();
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')) ?? {};
    } catch { /* повреждён — считаем, что дополнений нет */ }
    return {};
  }

  // Дополнения именно ДОБАВЛЯЮТСЯ к поставке, а не заменяют её: список из файла
  // шаблона всегда остаётся на месте. Поэтому удалить штатное исполнение или
  // штатную версию прошивки невозможно в принципе — убрать можно только своё.
  // Заодно отдаём фронту, что именно пришло из поставки (builtin*), чтобы он
  // показал такие строки как неудаляемые.
  private withExtras(tpl: DeviceConfig): DeviceConfig {
    const extra = this.loadExtras()[tpl.id];
    const builtinModels = tpl.models ?? [];
    const builtinFirmwares = tpl.firmwares ?? [];
    if (!extra) return { ...tpl, builtinModels, builtinFirmwares };

    const addedModels = (extra.models ?? []).filter(
      m => !builtinModels.some(b => b.code === m.code),
    );
    const addedFirmwares = (extra.firmwares ?? []).filter(f => !builtinFirmwares.includes(f));
    return {
      ...tpl,
      models: [...builtinModels, ...addedModels],
      firmwares: [...builtinFirmwares, ...addedFirmwares],
      builtinModels,
      builtinFirmwares,
    };
  }

  saveTemplateExtras(id: string, patch: { models?: any[]; firmwares?: string[] }): DeviceConfig {
    const tpl = this.templates.get(id);
    if (!tpl) throw new NotFoundException(`Тип ПЧ '${id}' не найден`);
    const all = this.loadExtras();
    all[id] = { ...(all[id] ?? {}), ...patch };
    fs.writeFileSync(this.extrasPath(), JSON.stringify(all, null, 2), 'utf-8');
    const updated = this.withExtras(tpl);
    this.events.emit('device:changed', updated);
    return updated;
  }

  // ─── Фотографии устройств ──────────────────────────────────────────────────
  //
  // Две папки, как и у шаблонов: поставочная (только чтение) и своя в папке
  // данных. Загружать можно только во вторую — первая заменяется при обновлении
  // программы, а в Program Files ещё и недоступна для записи.
  private get userImagesPath(): string {
    return path.join(path.dirname(this.userTemplatesPath), 'images');
  }

  private static readonly IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

  // Имя файла из запроса нельзя подставлять в путь как есть: '../' увёл бы
  // чтение и запись за пределы папки с картинками.
  private safeImageName(name: string): string {
    const safe = path.basename(String(name ?? '')).replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!safe) throw new BadRequestException('Некорректное имя файла');
    if (!DevicesService.IMAGE_EXT.includes(path.extname(safe).toLowerCase())) {
      throw new BadRequestException(`Поддерживаются только изображения (${DevicesService.IMAGE_EXT.join(', ')})`);
    }
    return safe;
  }

  findImage(filename: string): string | null {
    const safe = path.basename(String(filename ?? ''));
    for (const dir of [this.userImagesPath, path.join(this.devicesPath, 'images')]) {
      const p = path.join(dir, safe);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  listImages(): { name: string; custom: boolean }[] {
    const seen = new Map<string, boolean>();
    const scan = (dir: string, custom: boolean) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!DevicesService.IMAGE_EXT.includes(path.extname(f).toLowerCase())) continue;
        if (!seen.has(f)) seen.set(f, custom);
      }
    };
    scan(this.userImagesPath, true);
    scan(path.join(this.devicesPath, 'images'), false);
    return Array.from(seen, ([name, custom]) => ({ name, custom }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  saveImage(name: string, dataBase64: string): { name: string } {
    const safe = this.safeImageName(name);
    const raw = String(dataBase64 ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!raw) throw new BadRequestException('Пустой файл');
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 0) throw new BadRequestException('Не удалось разобрать файл');
    if (buf.length > 15 * 1024 * 1024) throw new BadRequestException('Файл больше 15 МБ');
    fs.mkdirSync(this.userImagesPath, { recursive: true });
    fs.writeFileSync(path.join(this.userImagesPath, safe), buf);
    return { name: safe };
  }

  deleteImage(filename: string): void {
    const safe = path.basename(String(filename ?? ''));
    const own = path.join(this.userImagesPath, safe);
    if (!fs.existsSync(own)) {
      throw new BadRequestException('Это фотография из поставки — её удалить нельзя');
    }
    fs.unlinkSync(own);
  }

  private templateFilePath(id: string): string {
    // Имя файла = id, очищенный от всего, что ломает путь
    const safe = String(id).replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!safe) throw new BadRequestException('Некорректный идентификатор типа');
    return path.join(this.userTemplatesPath, `${safe}.json`);
  }

  private assertCustomTemplate(id: string): DeviceConfig {
    const tpl = this.templates.get(id);
    if (!tpl) throw new NotFoundException(`Тип ПЧ '${id}' не найден`);
    if (!(tpl as any).custom) {
      throw new BadRequestException(
        `«${tpl.name ?? id}» — штатный тип, его нельзя изменить или удалить. Создайте на его основе свой тип.`,
      );
    }
    return tpl;
  }

  saveTemplate(config: DeviceConfig, opts: { overwrite?: boolean } = {}): DeviceConfig {
    if (!config?.id) throw new BadRequestException('Не задан идентификатор типа (id)');
    if (!Array.isArray(config.groups) || config.groups.length === 0) {
      throw new BadRequestException('В типе нет ни одной группы параметров');
    }
    const existing = this.templates.get(config.id);
    if (existing && !opts.overwrite) {
      throw new BadRequestException(`Тип с идентификатором «${config.id}» уже существует`);
    }
    if (existing) this.assertCustomTemplate(config.id); // менять можно только свои

    const payload: DeviceConfig = {
      ...config,
      custom: true,           // признак пользовательского типа
      template: undefined,    // служебный флаг проставляется при загрузке
    } as DeviceConfig;
    delete (payload as any).template;

    const file = this.templateFilePath(config.id);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    // Наблюдатель тоже перечитает файл, но делаем это сразу — чтобы ответ уже
    // содержал актуальный тип и фронт не ждал события.
    const loaded = this.loadTemplateFile(file);
    if (loaded) this.events.emit(existing ? 'device:changed' : 'device:added', loaded);
    return this.templates.get(config.id)!;
  }

  deleteTemplate(id: string): void {
    this.assertCustomTemplate(id);
    const used = Array.from(this.instances.values()).filter(i => i.templateId === id);
    if (used.length) {
      throw new BadRequestException(
        `Тип используют ${used.length} устройств (${used.map(u => u.name).join(', ')}). Смените им тип или удалите их.`,
      );
    }
    // Удаляем только файл в папке данных: тип из поставки сюда не дойдёт
    // (assertCustomTemplate выше), но подстраховка не лишняя.
    let file: string | null = null;
    for (const [fp, tid] of this.templateFileToId) if (tid === id && this.isUserTemplateFile(fp)) file = fp;
    if (!file) throw new BadRequestException('Файл этого типа не найден в папке данных');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.forgetTemplateFile(file);
  }
}
