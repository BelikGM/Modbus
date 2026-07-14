import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface DeviceUISettings {
  monitorOrder?: string[];
  monitorVisible?: string[];
  groupOrder?: string[];
  visibleGroups?: string[];
  paramColWidths?: Record<string, number>;
  pendingWrites?: Record<string, any>;
}

export interface ProjectConnection {
  portPath: string;
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

export interface AppSettings {
  activeProject: string | null;
  siderSide: 'left' | 'right';
  deviceSettings?: Record<string, DeviceUISettings>;
  projectConnections?: Record<string, ProjectConnection>;
}

const DEFAULTS: AppSettings = { activeProject: null, siderSide: 'left', deviceSettings: {}, projectConnections: {} };

@Injectable()
export class SettingsService {
  private readonly filePath: string;
  private settings: AppSettings;

  constructor() {
    const userDataPath = process.env.USER_DATA_PATH ?? path.join(process.cwd(), '..');
    this.filePath = path.join(userDataPath, 'settings.json');
    this.settings = this.load();
  }

  private load(): AppSettings {
    try {
      if (fs.existsSync(this.filePath)) {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
      }
    } catch {}
    return { ...DEFAULTS };
  }

  get(): AppSettings {
      return this.settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf-8');
    return this.settings;
  }

  saveProjectConnection(projectId: string, conn: ProjectConnection): void {
    const updated: AppSettings = {
      ...this.settings,
      projectConnections: {
        ...(this.settings.projectConnections ?? {}),
        [projectId]: conn,
      },
    };
    this.settings = updated;
    fs.writeFileSync(this.filePath, JSON.stringify(updated, null, 2), 'utf-8');
  }

  getProjectConnection(projectId: string): ProjectConnection | null {
    return this.settings.projectConnections?.[projectId] ?? null;
  }

  updateDeviceSettings(deviceId: string, patch: Partial<DeviceUISettings>): AppSettings {
    const current = this.load();
    const updated: AppSettings = {
      ...current,
      deviceSettings: {
        ...(current.deviceSettings ?? {}),
        [deviceId]: { ...(current.deviceSettings?.[deviceId] ?? {}), ...patch },
      },
    };
    this.settings = updated;
    fs.writeFileSync(this.filePath, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
  }
}
