import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

// «Шаблон значений» (пресет) — именованный набор подготовленных значений
// параметров для одного семейства ПЧ (pump | vl). Применение пресета копирует
// его values в pendingWrites каждого выбранного устройства; сам пресет при
// этом не меняется и может переиспользоваться. Хранится глобально в userData
// (не в проекте) — пресеты переживают смену проектов.
export interface ValuePreset {
  id: string;
  name: string;
  // Семейство — произвольная строка: свои типы из редактора могут завести
  // новое семейство, и пресеты для него должны работать так же.
  family: string;
  values: Record<string, number>;
  updatedAt: string;
}

@Injectable()
export class PresetsService {
  private readonly filePath: string;
  private presets: ValuePreset[];

  constructor() {
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    this.filePath = path.join(userDataPath, 'value-presets.json');
    this.presets = this.load();
  }

  private load(): ValuePreset[] {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { /* повреждённый файл — начинаем с пустого списка */ }
    return [];
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.presets, null, 2), 'utf-8');
  }

  list(family?: string): ValuePreset[] {
    return family ? this.presets.filter(p => p.family === family) : this.presets;
  }

  getById(id: string): ValuePreset {
    const preset = this.presets.find(p => p.id === id);
    if (!preset) throw new NotFoundException(`Шаблон значений '${id}' не найден`);
    return preset;
  }

  create(name: string, family: string, values: Record<string, number> = {}): ValuePreset {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new BadRequestException('Укажите название шаблона');
    if (typeof family !== 'string' || !family.trim()) throw new BadRequestException('Не указано семейство ПЧ');
    if (this.presets.some(p => p.name === trimmed && p.family === family)) {
      throw new BadRequestException(`Шаблон «${trimmed}» для этого типа ПЧ уже существует`);
    }
    const preset: ValuePreset = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: trimmed,
      family,
      values,
      updatedAt: new Date().toISOString(),
    };
    this.presets.push(preset);
    this.persist();
    return preset;
  }

  update(id: string, patch: { name?: string; values?: Record<string, number> }): ValuePreset {
    const preset = this.getById(id);
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new BadRequestException('Название шаблона не может быть пустым');
      if (this.presets.some(p => p.id !== id && p.name === trimmed && p.family === preset.family)) {
        throw new BadRequestException(`Шаблон «${trimmed}» для этого типа ПЧ уже существует`);
      }
      preset.name = trimmed;
    }
    if (patch.values !== undefined) preset.values = patch.values;
    preset.updatedAt = new Date().toISOString();
    this.persist();
    return preset;
  }

  delete(id: string): void {
    const idx = this.presets.findIndex(p => p.id === id);
    if (idx === -1) throw new NotFoundException(`Шаблон значений '${id}' не найден`);
    this.presets.splice(idx, 1);
    this.persist();
  }
}
