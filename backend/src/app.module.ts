import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { existsSync } from 'fs';
import { DevicesModule } from './devices/devices.module';
import { ModbusModule } from './modbus/modbus.module';
import { GatewayModule } from './gateway/gateway.module';
import { ProjectsModule } from './projects/projects.module';
import { SettingsModule } from './settings/settings.module';
import { PresetsModule } from './presets/presets.module';
import { FavoritesModule } from './favorites/favorites.module';

const staticPath = join(__dirname, '..', 'frontend-dist');
const staticImports = existsSync(staticPath)
  ? [ServeStaticModule.forRoot({ rootPath: staticPath, exclude: ['/api/{*path}'] })]
  : [];

@Module({
  imports: [...staticImports, SettingsModule, ProjectsModule, DevicesModule, ModbusModule, GatewayModule, PresetsModule, FavoritesModule],
})
export class AppModule {}
