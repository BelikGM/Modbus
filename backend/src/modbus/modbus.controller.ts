import {
  Controller,
  Get,
  Post,
  Body,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ModbusService } from './modbus.service';
import { DevicesService } from '../devices/devices.service';

@Controller('modbus')
export class ModbusController {
  constructor(
    private readonly modbusService: ModbusService,
    private readonly devicesService: DevicesService,
  ) {}

  @Get('status')
  getStatus() {
    return this.modbusService.getStatus();
  }

  @Get('ports')
  async listPorts() {
    return this.modbusService.listPorts();
  }

  @Post('scan')
  async scan(@Body() body: { baudRate?: number }) {
    const result = await this.modbusService.findAdapterPort(body);
    if (!result) throw new ServiceUnavailableException('USB→RS-485 адаптер не найден');
    return result;
  }

  @Post('connect')
  async connect(
    @Body() body: {
      portPath: string;
      baudRate?: number;
      dataBits?: 7 | 8;
      stopBits?: 1 | 2;
      parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    },
  ) {
    if (!body.portPath) throw new BadRequestException('portPath is required');
    await this.modbusService.connect({
      portPath: body.portPath,
      baudRate: body.baudRate ?? 9600,
      dataBits: body.dataBits,
      stopBits: body.stopBits,
      parity: body.parity,
    });
    return { success: true };
  }

  @Post('disconnect')
  async disconnect() {
    await this.modbusService.disconnect();
    return { success: true };
  }

  @Post('probe')
  async probe(@Body() body: { slaveId: number }) {
    if (!this.modbusService.isConnected())
      throw new BadRequestException('Not connected to Modbus');
    if (!body.slaveId) throw new BadRequestException('slaveId is required');
    return this.modbusService.probeDevice(body.slaveId);
  }

  @Post('read')
  async read(@Body() body: { deviceId: string; paramId: string }) {
    if (!this.modbusService.isConnected())
      throw new BadRequestException('Not connected to Modbus');
    const device = this.devicesService.getById(body.deviceId);
    if (!device) throw new NotFoundException(`Device '${body.deviceId}' not found`);
    const param = this.devicesService.findParam(body.deviceId, body.paramId);
    if (!param) throw new NotFoundException(`Param '${body.paramId}' not found`);
    const slaveId = device.connection.slaveId ?? 1;
    try {
      const rawValue = await this.modbusService.readRegister(param.register, slaveId);
      const scale = param.scale ?? 1;
      return {
        paramId: param.id,
        rawValue,
        value: rawValue * scale,
        unit: param.unit ?? '',
      };
    } catch (e) {
      throw this.wrapModbusError(e, param.id, param.register);
    }
  }

  @Post('write')
  async write(
    @Body() body: { deviceId: string; paramId: string; value: number },
  ) {
    if (!this.modbusService.isConnected())
      throw new BadRequestException('Not connected to Modbus');
    const device = this.devicesService.getById(body.deviceId);
    if (!device) throw new NotFoundException(`Device '${body.deviceId}' not found`);
    const param = this.devicesService.findParam(body.deviceId, body.paramId);
    if (!param) throw new NotFoundException(`Param '${body.paramId}' not found`);
    if (!this.devicesService.isParamWritable(device, param))
      throw new BadRequestException(`Param '${body.paramId}' is read-only`);
    const slaveId = device.connection.slaveId ?? 1;
    const scale = param.scale ?? 1;
    try {
      await this.modbusService.writeRegister(param.register, Math.round(body.value / scale), slaveId);
    } catch (e) {
      throw this.wrapModbusError(e, param.id, param.register);
    }
    return { success: true };
  }

  private wrapModbusError(e: any, paramId: string, register: number) {
    const code: number | undefined = e?.modbusCode;
    const descriptions: Record<number, string> = {
      1: 'недопустимая функция',
      2: 'регистр не поддерживается устройством',
      3: 'недопустимое значение данных',
      4: 'ошибка устройства',
    };
    const detail = code !== undefined
      ? `Modbus exception ${code}: ${descriptions[code] ?? 'неизвестная ошибка'}`
      : (e?.message ?? String(e));
    return new UnprocessableEntityException(
      `${paramId} (рег. ${register}): ${detail}`,
    );
  }
}
