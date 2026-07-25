import { Controller, Get, Post, Patch, Delete, Param, Body, NotFoundException, Res, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import { DevicesService } from './devices.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  getAll() {
    return this.devicesService.getAll();
  }

  @Get('templates')
  getTemplates() {
    return this.devicesService.getTemplates();
  }

  @Get('images/:filename')
  getImage(@Param('filename') filename: string, @Res() res: Response) {
    const safeName = path.basename(filename);
    const filePath = path.join(this.devicesService.devicesPath, 'images', safeName);
    if (!fs.existsSync(filePath)) throw new NotFoundException('Image not found');
    res.sendFile(filePath);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    const device = this.devicesService.getById(id);
    if (!device) throw new NotFoundException(`Device '${id}' not found`);
    return device;
  }

  @Get(':id/pending-writes')
  getPendingWrites(@Param('id') id: string) {
    // Отдаём «эффективные» значения: заводские по умолчанию во всех полях +
    // сохранённые правки поверх. Так колонка «Значение для записи» на фронте
    // сразу заполнена во всех группах, а не пустая.
    return this.devicesService.getEffectivePendingWrites(id);
  }

  // Массовая правка подготовленных значений сразу у нескольких ПЧ (опция «Все
  // выбранные ПЧ»). Объявлен ДО ':id/pending-writes', но статический путь
  // 'pending-writes/bulk' с ним и так не пересекается (второй сегмент 'bulk').
  @Patch('pending-writes/bulk')
  updatePendingWritesBulk(
    @Body() body: { deviceIds: string[]; pendingWrites: Record<string, any> },
  ) {
    this.devicesService.mergeManyDevicesPendingWrites(body.deviceIds ?? [], body.pendingWrites ?? {});
    return { success: true };
  }

  @Patch(':id/pending-writes')
  updatePendingWrites(
    @Param('id') id: string,
    @Body() body: { pendingWrites: Record<string, any>; merge?: boolean },
  ) {
    // merge=true — вливаем присланные ключи в уже сохранённые подготовленные
    // значения (null удаляет ключ), не затирая остальные. Используется при
    // групповом наборе значений и применении шаблона значений — у каждого ПЧ
    // могут быть свои индивидуальные правки, которые нельзя терять.
    if (body.merge) this.devicesService.mergeDevicePendingWrites(id, body.pendingWrites);
    else this.devicesService.updateDevicePendingWrites(id, body.pendingWrites);
    return { success: true };
  }

  @Get(':id/current-values')
  getCurrentValues(@Param('id') id: string) {
    return this.devicesService.getDeviceCurrentValues(id);
  }

  @Patch(':id/current-values')
  updateCurrentValues(@Param('id') id: string, @Body() body: { currentValues: Record<string, any> }) {
    this.devicesService.updateDeviceCurrentValues(id, body.currentValues);
    return { success: true };
  }

  @Post()
  create(@Body() body: { templateId: string; name: string; slaveId: number }) {
    return this.devicesService.createDevice(body.templateId, body.name, body.slaveId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; slaveId?: number }) {
    return this.devicesService.updateDevice(id, body);
  }

  @Get(':id/notes')
  getNotes(@Param('id') id: string) {
    return this.devicesService.getDeviceNotes(id);
  }

  @Post(':id/notes')
  addNote(@Param('id') id: string, @Body() body: { text: string }) {
    return this.devicesService.addDeviceNote(id, body.text);
  }

  @Patch(':id/notes/:noteId')
  updateNote(@Param('id') id: string, @Param('noteId') noteId: string, @Body() body: { text: string }) {
    return this.devicesService.updateDeviceNote(id, noteId, body.text);
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(204)
  deleteNote(@Param('id') id: string, @Param('noteId') noteId: string) {
    this.devicesService.deleteDeviceNote(id, noteId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.devicesService.deleteDevice(id);
    return { success: true };
  }
}
