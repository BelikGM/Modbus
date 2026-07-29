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
  // Стартовый набор «Избранного» — то, что чаще всего нужно при пусконаладке:
  // управление приводом, задание частоты, разгон/торможение, паспорт двигателя,
  // источники команд/задания и защиты. Пользователь может изменить или очистить
  // список; тогда сохранится именно его выбор.
  private static readonly DEFAULTS: Record<DeviceFamily, string[]> = {
    pump: [
      'CMD', 'FREQ_SET', 'STATUS',                  // пуск/стоп, задание частоты, состояние
      'F1.00',                                       // предустановленная выходная частота
      'F1.01', 'F1.02',                              // источник задания частоты / команд управления
      'F1.05', 'F1.06',                              // макс./мин. выходная частота
      'F1.07', 'F1.08',                              // время ускорения / замедления
      'F2.00', 'F2.01',                              // способ запуска / остановки двигателя
      'F2.09', 'F2.10', 'F2.12', 'F2.15',            // паспорт двигателя: напряжение, ток, обороты, частота
      'F0.01', 'F0.02', 'F0.03', 'F0.06',            // заданная/выходная частота, ток, температура
      'F0.27',                                       // текущий код аварийного состояния
    ],
    vl: [
      'CMD', 'FREQ_SET', 'STATUS', 'FAULT_CODE',
      'P0.02', 'P0.03',                    // источник команд / задания частоты
      'P0.08',                             // предустановленная частота
      'P0.12', 'P0.14',                    // верхняя граница частоты, нижняя
      'P0.17', 'P0.18',                    // время разгона / торможения
      'P1.00', 'P1.01', 'P1.02', 'P1.03',  // паспорт двигателя
      'D0.00', 'D0.01', 'D0.04', 'D0.05',  // выход/задание/ток/мощность
      'P7.07',                             // температура IGBT
    ],
  };

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
          // Пустой массив в файле — это осознанный выбор пользователя
          // («Очистить избранное»), его не подменяем набором по умолчанию.
          pump: Array.isArray(parsed?.pump) ? parsed.pump : [...FavoritesService.DEFAULTS.pump],
          vl: Array.isArray(parsed?.vl) ? parsed.vl : [...FavoritesService.DEFAULTS.vl],
        };
      }
    } catch { /* повреждённый файл — начинаем с набора по умолчанию */ }
    return { pump: [...FavoritesService.DEFAULTS.pump], vl: [...FavoritesService.DEFAULTS.vl] };
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
