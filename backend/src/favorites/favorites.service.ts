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
  private readonly filePath: string;
  private favorites: Record<DeviceFamily, string[]>;

  constructor() {
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    this.filePath = path.join(userDataPath, 'favorite-params.json');
    this.favorites = this.load();
  }

  private load(): Record<DeviceFamily, string[]> {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        return {
          pump: Array.isArray(parsed?.pump) ? parsed.pump : [],
          vl: Array.isArray(parsed?.vl) ? parsed.vl : [],
        };
      }
    } catch { /* повреждённый файл — начинаем с пустых списков */ }
    return { pump: [], vl: [] };
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.favorites, null, 2), 'utf-8');
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
