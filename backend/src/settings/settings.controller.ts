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

  @Patch('device-selection/:projectId')
  updateDeviceSelection(@Param('projectId') projectId: string, @Body() body: { selected: string[] }) {
    this.settingsService.saveDeviceSelection(projectId, body.selected ?? []);
    return { success: true };
  }

  @Patch('device-order/:projectId')
  updateDeviceOrder(@Param('projectId') projectId: string, @Body() body: { order: string[] }) {
    this.settingsService.saveDeviceOrder(projectId, body.order);
    return { success: true };
  }
}
