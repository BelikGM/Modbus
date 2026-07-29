import { Controller, Get, Patch, Body, Param } from '@nestjs/common';
import { SettingsService, DeviceUISettings } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  get() {
    return this.settingsService.get();
  }

  @Patch()
  update(@Body() body: Partial<{ siderSide: 'left' | 'right'; siderWidth: number; theme: 'light' | 'dark' }>) {
    return this.settingsService.update(body);
  }

  @Patch('device/:deviceId')
  updateDevice(
    @Param('deviceId') deviceId: string,
    @Body() body: Partial<DeviceUISettings>,
  ) {
    return this.settingsService.updateDeviceSettings(deviceId, body);
  }

  // projectId передаём в ТЕЛЕ, а не в пути: имена проектов бывают кириллицей и
  // с пробелами («Тест_1»), в URL это лишний источник проблем с кодировкой.
  @Patch('device-selection')
  updateDeviceSelection(@Body() body: { projectId: string; selected: string[] }) {
    if (!body?.projectId) return { success: false };
    this.settingsService.saveDeviceSelection(body.projectId, body.selected ?? []);
    return { success: true };
  }

  @Patch('device-order/:projectId')
  updateDeviceOrder(@Param('projectId') projectId: string, @Body() body: { order: string[] }) {
    this.settingsService.saveDeviceOrder(projectId, body.order);
    return { success: true };
  }
}
