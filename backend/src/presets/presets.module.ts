import { Module } from '@nestjs/common';
import { PresetsService } from './presets.service';
import { PresetsController } from './presets.controller';

@Module({
  providers: [PresetsService],
  controllers: [PresetsController],
  exports: [PresetsService],
})
export class PresetsModule {}
