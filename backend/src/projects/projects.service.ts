import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { FSWatcher } from 'chokidar';
import { SettingsService } from '../settings/settings.service';
import { ProjectMeta, DeviceInstance, ProjectFile, ProjectMismatch } from './project.types';

@Injectable()
export class ProjectsService implements OnModuleInit, OnModuleDestroy {
  readonly events = new EventEmitter();
  readonly projectsPath: string;
  private projectWatcher: FSWatcher | null = null;
  private mismatchPollTimer: NodeJS.Timeout | null = null;
  private lastMismatchKey = '';

  constructor(private readonly settingsService: SettingsService) {
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    this.projectsPath = path.join(userDataPath, 'projects');
    fs.mkdirSync(this.projectsPath, { recursive: true });
  }

  async onModuleInit() {
    await this.startProjectWatcher();
    this.mismatchPollTimer = setInterval(() => this.emitMismatches(), 2000);
  }

  onModuleDestroy() {
    this.projectWatcher?.close();
    if (this.mismatchPollTimer) clearInterval(this.mismatchPollTimer);
  }

  // ─── File helpers ──────────────────────────────────────────────────────────

  private projectFileName(id: string): string {
    return `${id}.project.json`;
  }

  private findProjectFile(dir: string): { stem: string; filePath: string } | null {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.project.json'));
      if (!files.length) return null;
      const stem = files[0].replace('.project.json', '');
      return { stem, filePath: path.join(dir, files[0]) };
    } catch {
      return null;
    }
  }

  private readProjectFile(filePath: string): ProjectFile | null {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProjectFile;
    } catch {
      return null;
    }
  }

  private writeProjectFile(filePath: string, data: ProjectFile): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private emptyFile(id: string, name: string): ProjectFile {
    return { id, name, created: new Date().toISOString(), devices: [] };
  }

  // ─── Project folder watcher (detects external renames) ────────────────────

  private async startProjectWatcher(): Promise<void> {
    const chokidar = await import('chokidar');
    this.projectWatcher = chokidar.watch(this.projectsPath, {
      depth: 1,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this.projectWatcher.on('addDir', (dirPath: string) => {
      if (dirPath === this.projectsPath) return;
      setTimeout(() => {
        this.events.emit('projects:changed');
        this.emitMismatches();
      }, 500);
    });
    this.projectWatcher.on('unlinkDir', () => {
      setTimeout(() => {
        this.events.emit('projects:changed');
        this.emitMismatches();
      }, 500);
    });
    this.projectWatcher.on('change', (filePath: string) => {
      if (filePath.endsWith('.project.json')) {
        setTimeout(() => this.emitMismatches(), 400);
      }
    });
  }

  private emitMismatches(): void {
    const mismatches = this.checkMismatches();
    const key = JSON.stringify(mismatches);
    if (key === this.lastMismatchKey) return;
    this.lastMismatchKey = key;
    this.events.emit('project:folder:mismatch', mismatches);
  }

  // ─── Mismatch detection ────────────────────────────────────────────────────

  checkMismatches(): ProjectMismatch[] {
    try {
      return fs.readdirSync(this.projectsPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .flatMap(d => {
          const dir = path.join(this.projectsPath, d.name);
          const found = this.findProjectFile(dir);
          if (!found) return [];
          const data = this.readProjectFile(found.filePath);
          const contentId   = data?.id   ?? found.stem;
          const contentName = data?.name ?? found.stem;
          if (found.stem === d.name && contentId === d.name && contentName === d.name) return [];
          return [{ folderId: d.name, fileId: found.stem, contentId, contentName }];
        });
    } catch { return []; }
  }

  // action 'sync-to-folder'   — folder name is truth, rename file + update id/name in content
  // action 'rename-to-content' — id in file is truth, rename folder + file to match it, sync name=id
  fixMismatch(folderId: string, action: 'sync-to-folder' | 'rename-to-content'): ProjectMeta {
    const dir = path.join(this.projectsPath, folderId);
    if (!fs.existsSync(dir)) throw new NotFoundException(`Папка '${folderId}' не найдена`);
    const found = this.findProjectFile(dir);
    if (!found) throw new BadRequestException(`Нет .project.json в папке '${folderId}'`);
    const data = this.readProjectFile(found.filePath) ?? this.emptyFile(folderId, folderId);

    if (action === 'sync-to-folder') {
      data.id   = folderId;
      data.name = folderId;
      const newFilePath = path.join(dir, this.projectFileName(folderId));
      this.writeProjectFile(newFilePath, data);
      if (found.filePath !== newFilePath) {
        try { fs.unlinkSync(found.filePath); } catch {}
      }
      if (this.getActiveProjectId() === found.stem && found.stem !== folderId) {
        this.settingsService.update({ activeProject: folderId });
        this.events.emit('project:changed', folderId);
      }
      setTimeout(() => this.emitMismatches(), 400);
      return { id: folderId, name: folderId, created: data.created };
    } else {
      // rename-to-content: use id from file as the new canonical name
      const targetId = (data.id || folderId).replace(/[\\/:*?"<>|]/g, '') || folderId;
      data.id   = targetId;
      data.name = targetId;

      // Write updated file (with targetId name) while folder still has old name
      const newFilePath = path.join(dir, this.projectFileName(targetId));
      this.writeProjectFile(newFilePath, data);
      if (found.filePath !== newFilePath) {
        try { fs.unlinkSync(found.filePath); } catch {}
      }

      // Rename folder if needed
      if (targetId !== folderId) {
        const targetDir = path.join(this.projectsPath, targetId);
        if (fs.existsSync(targetDir)) throw new BadRequestException(`Папка '${targetId}' уже существует`);
        fs.renameSync(dir, targetDir);
        if (this.getActiveProjectId() === folderId) {
          this.settingsService.update({ activeProject: targetId });
          this.events.emit('project:changed', targetId);
        }
      }

      setTimeout(() => this.emitMismatches(), 400);
      return { id: targetId, name: targetId, created: data.created };
    }
  }

  // Первый свободный порядковый номер ("1", "2", ...), не занятый ни одной
  // существующей папкой проекта — используется для автосоздания проекта, когда
  // пользователь пытается что-то сделать (например, определить устройства на
  // шине), а активного проекта ещё нет.
  generateDefaultProjectName(): string {
    const existing = new Set(this.listProjects().map(p => p.id));
    let n = 1;
    while (existing.has(String(n))) n++;
    return String(n);
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  listProjects(): ProjectMeta[] {
    return fs.readdirSync(this.projectsPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const dir = path.join(this.projectsPath, d.name);
        const found = this.findProjectFile(dir);
        if (!found) return { id: d.name, name: d.name, created: '' };
        const data = this.readProjectFile(found.filePath);
        return { id: d.name, name: data?.name ?? d.name, created: data?.created ?? '' };
      });
  }

  createProject(name: string): ProjectMeta {
    const id = name.trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '') || `project_${Date.now()}`;
    const dir = path.join(this.projectsPath, id);
    if (fs.existsSync(dir)) throw new BadRequestException(`Проект '${id}' уже существует`);
    fs.mkdirSync(dir, { recursive: true });
    const data: ProjectFile = { id, name, created: new Date().toISOString(), devices: [] };
    this.writeProjectFile(path.join(dir, this.projectFileName(id)), data);
    return { id, name, created: data.created };
  }

  deleteProject(id: string): void {
    const dir = path.join(this.projectsPath, id);
    if (!fs.existsSync(dir)) throw new NotFoundException(`Проект '${id}' не найден`);
    fs.rmSync(dir, { recursive: true, force: true });
    if (this.getActiveProjectId() === id) {
      this.settingsService.update({ activeProject: null });
      this.events.emit('project:changed', null);
    }
  }

  renameProject(id: string, name: string): ProjectMeta {
    const dir = path.join(this.projectsPath, id);
    if (!fs.existsSync(dir)) throw new NotFoundException(`Проект '${id}' не найден`);

    const newId = name.trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '') || id;
    const newDir = path.join(this.projectsPath, newId);

    const found = this.findProjectFile(dir);
    const data: ProjectFile = (found && this.readProjectFile(found.filePath)) ?? this.emptyFile(id, name);
    data.id = newId;
    data.name = name;

    if (newId !== id) {
      if (fs.existsSync(newDir)) throw new BadRequestException(`Папка '${newId}' уже существует`);
      // Write new-name file, delete old, then rename dir
      const newFilePath = path.join(dir, this.projectFileName(newId));
      this.writeProjectFile(newFilePath, data);
      if (found && found.filePath !== newFilePath) {
        try { fs.unlinkSync(found.filePath); } catch {}
      }
      fs.renameSync(dir, newDir);
      if (this.getActiveProjectId() === id) {
        this.settingsService.update({ activeProject: newId });
        this.events.emit('project:changed', newId);
      }
    } else {
      const filePath = found ? found.filePath : path.join(dir, this.projectFileName(id));
      this.writeProjectFile(filePath, data);
    }

    return { id: newId, name, created: data.created };
  }

  importProject(content: any): ProjectMeta {
    if (!content || typeof content !== 'object') {
      throw new BadRequestException('Неверный формат файла');
    }
    if (!content.id || !content.name) {
      throw new BadRequestException('Файл не является проектом: нет поля id или name');
    }
    const id = String(content.id).replace(/[\\/:*?"<>|]/g, '');
    const dir = path.join(this.projectsPath, id);
    if (fs.existsSync(dir)) throw new BadRequestException(`Проект '${id}' уже существует`);
    fs.mkdirSync(dir, { recursive: true });
    const data: ProjectFile = {
      id,
      name: String(content.name),
      created: content.created ?? new Date().toISOString(),
      devices: Array.isArray(content.devices) ? content.devices : [],
    };
    this.writeProjectFile(path.join(dir, this.projectFileName(id)), data);
    return { id, name: data.name, created: data.created };
  }

  // ─── Active project ────────────────────────────────────────────────────────

  getActiveProjectId(): string | null {
    return this.settingsService.get().activeProject;
  }

  getActiveProjectPath(): string | null {
    const id = this.getActiveProjectId();
    if (!id) return null;
    const dir = path.join(this.projectsPath, id);
    return fs.existsSync(dir) ? dir : null;
  }

  setActiveProject(id: string | null): void {
    if (id !== null) {
      const dir = path.join(this.projectsPath, id);
      if (!fs.existsSync(dir)) throw new NotFoundException(`Проект '${id}' не найден`);
    }
    this.settingsService.update({ activeProject: id });
    this.events.emit('project:changed', id);
  }

  // ─── Instance helpers ──────────────────────────────────────────────────────

  loadInstances(projectId: string): DeviceInstance[] {
    const dir = path.join(this.projectsPath, projectId);
    if (!fs.existsSync(dir)) return [];
    const found = this.findProjectFile(dir);
    if (!found) return [];
    return this.readProjectFile(found.filePath)?.devices ?? [];
  }

  writeInstance(projectId: string, instance: DeviceInstance): void {
    const dir = path.join(this.projectsPath, projectId);
    const found = this.findProjectFile(dir);
    if (!found) throw new NotFoundException(`Файл проекта '${projectId}' не найден`);
    const data = this.readProjectFile(found.filePath) ?? this.emptyFile(projectId, projectId);
    const idx = data.devices.findIndex(d => d.id === instance.id);
    if (idx >= 0) data.devices[idx] = instance;
    else data.devices.push(instance);
    this.writeProjectFile(found.filePath, data);
  }

  deleteInstance(projectId: string, instanceId: string): void {
    const dir = path.join(this.projectsPath, projectId);
    const found = this.findProjectFile(dir);
    if (!found) return;
    const data = this.readProjectFile(found.filePath);
    if (!data) return;
    data.devices = data.devices.filter(d => d.id !== instanceId);
    this.writeProjectFile(found.filePath, data);
  }

  getProjectFilePath(projectId: string): string | null {
    const dir = path.join(this.projectsPath, projectId);
    return this.findProjectFile(dir)?.filePath ?? null;
  }
}
