import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

// Запись журнала операций. Журнал ведётся ПЕР ПРОЕКТ (у каждого объекта своя
// история работ) и переживает перезагрузку страницы/перезапуск приложения —
// раньше он жил только в памяти вкладки браузера и терялся при F5.
export interface LogEntry {
  id: string;
  ts: string;    // ISO-время (для сортировки/экспорта)
  time: string;  // локальное время для показа
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

const MAX_ENTRIES = 5000;

@Injectable()
export class LogsService {
  private readonly logsPath: string;
  // Кэш в памяти + отложенная запись: журнал пополняется часто (каждый параметр
  // группового чтения), синхронно писать файл на каждую запись — лишняя
  // нагрузка на диск.
  private cache = new Map<string, LogEntry[]>();
  private flushTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    // Отдельная папка, НЕ внутри projects/: за папкой проектов следит chokidar
    // (детект переименований/рассинхрона), и частая запись файла журнала туда
    // спамила бы событиями projects:changed.
    this.logsPath = path.join(userDataPath, 'logs');
  }

  private fileFor(projectId: string): string {
    const safe = path.basename(projectId);
    return path.join(this.logsPath, `${safe}.json`);
  }

  private load(projectId: string): LogEntry[] {
    if (this.cache.has(projectId)) return this.cache.get(projectId)!;
    let entries: LogEntry[] = [];
    try {
      const file = this.fileFor(projectId);
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (Array.isArray(parsed)) entries = parsed;
      }
    } catch { /* повреждённый файл — начинаем с пустого журнала */ }
    this.cache.set(projectId, entries);
    return entries;
  }

  private scheduleFlush(projectId: string): void {
    if (this.flushTimers.has(projectId)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(projectId);
      this.flush(projectId);
    }, 800);
    this.flushTimers.set(projectId, timer);
  }

  private flush(projectId: string): void {
    try {
      if (!fs.existsSync(this.logsPath)) fs.mkdirSync(this.logsPath, { recursive: true });
      const entries = this.cache.get(projectId) ?? [];
      fs.writeFileSync(this.fileFor(projectId), JSON.stringify(entries, null, 2), 'utf-8');
    } catch { /* журнал не критичен — не роняем операцию из-за ошибки записи */ }
  }

  list(projectId: string): LogEntry[] {
    if (!projectId) return [];
    return this.load(projectId);
  }

  append(projectId: string, incoming: Partial<LogEntry>[]): LogEntry[] {
    if (!projectId || !Array.isArray(incoming) || incoming.length === 0) return this.list(projectId);
    const entries = this.load(projectId);
    for (const raw of incoming) {
      const ts = raw.ts ?? new Date().toISOString();
      entries.unshift({
        id: raw.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts,
        time: raw.time ?? new Date(ts).toLocaleTimeString('ru-RU'),
        level: (raw.level as LogEntry['level']) ?? 'info',
        message: String(raw.message ?? ''),
      });
    }
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    this.cache.set(projectId, entries);
    this.scheduleFlush(projectId);
    return entries;
  }

  clear(projectId: string): void {
    if (!projectId) return;
    this.cache.set(projectId, []);
    this.scheduleFlush(projectId);
  }
}
