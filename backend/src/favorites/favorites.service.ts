import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export type DeviceFamily = 'pump' | 'vl';

// «Избранное» — собственная группа параметров на СЕМЕЙСТВО ПЧ (pump | vl):
// произвольный список конкретных параметров (не групп целиком), собранный
// пользователем. Изначально пуст. Хранится глобально в userData рядом с
// пресетами — переживает смену проекта и относится к модели ПЧ, а не к
// конкретному устройству на шине.
@Injectable()
export class FavoritesService {
  // Рабочая группа «Отладка» начинается ПУСТОЙ и собирается на месте под
  // текущую задачу. Постоянный выверенный набор переехал в шаблон модели
  // (builtinFavorites) и показывается отдельной неизменяемой группой
  // «★ Избранное» — так временные правки на объекте не портят эталонный список.
  private static readonly DEFAULTS: Record<DeviceFamily, string[]> = { pump: [], vl: [] };

  private readonly filePath: string;
  private favorites: Record<DeviceFamily, string[]>;

  constructor() {
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    this.filePath = path.join(userDataPath, 'favorite-params.json');
    this.favorites = this.load();
  }

  // Версия схемы файла. Файлы БЕЗ версии созданы до появления стартового набора
  // «Избранного» — в них набор по умолчанию досыпается один раз (см. load()).
  // После этого пустой список означает осознанное «Очистить избранное» и
  // повторно ничем не заполняется.
  private static readonly SCHEMA_VERSION = 1;

  private load(): Record<DeviceFamily, string[]> {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        const stored = {
          pump: Array.isArray(parsed?.pump) ? parsed.pump : [],
          vl: Array.isArray(parsed?.vl) ? parsed.vl : [],
        };
        if (parsed?.version === FavoritesService.SCHEMA_VERSION) return stored;

        // Разовая миграция старого файла: добавляем стартовый набор, СОХРАНЯЯ
        // всё, что пользователь уже отметил (его пункты идут после наших).
        const merged: Record<DeviceFamily, string[]> = {
          pump: [...new Set([...FavoritesService.DEFAULTS.pump, ...stored.pump])],
          vl: [...new Set([...FavoritesService.DEFAULTS.vl, ...stored.vl])],
        };
        this.favorites = merged;
        this.persist();
        return merged;
      }
    } catch { /* повреждённый файл — начинаем с набора по умолчанию */ }
    return { pump: [...FavoritesService.DEFAULTS.pump], vl: [...FavoritesService.DEFAULTS.vl] };
  }

  private persist(): void {
    const payload = { version: FavoritesService.SCHEMA_VERSION, ...this.favorites };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  private assertFamily(family: string): asserts family is DeviceFamily {
    if (family !== 'pump' && family !== 'vl') {
      throw new BadRequestException(`Неизвестное семейство ПЧ: ${family}`);
    }
  }

  get(family: string): string[] {
    this.assertFamily(family);
    return this.favorites[family];
  }

  getAll(): Record<DeviceFamily, string[]> {
    return this.favorites;
  }

  // Полная замена списка (порядок сохраняем как прислали — это порядок
  // отображения в группе «Избранное»); дубли отбрасываем.
  set(family: string, paramIds: string[]): string[] {
    this.assertFamily(family);
    this.favorites[family] = [...new Set((paramIds ?? []).filter(id => typeof id === 'string' && id.length > 0))];
    this.persist();
    return this.favorites[family];
  }
}
