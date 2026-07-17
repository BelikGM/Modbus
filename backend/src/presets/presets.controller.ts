import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { PresetsService } from './presets.service';

@Controller('presets')
export class PresetsController {
  constructor(private readonly presetsService: PresetsService) {}

  @Get()
  list(@Query('family') family?: string) {
    return this.presetsService.list(family);
  }

  @Post()
  create(@Body() body: { name: string; family: 'pump' | 'vl'; values?: Record<string, number> }) {
    return this.presetsService.create(body.name, body.family, body.values ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; values?: Record<string, number> }) {
    return this.presetsService.update(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    this.presetsService.delete(id);
    return { success: true };
  }
}
