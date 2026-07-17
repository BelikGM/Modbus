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
}
