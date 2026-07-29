import { Controller, Get, Post, Delete, Body, Query } from '@nestjs/common';
import { LogsService, LogEntry } from './logs.service';
import { ProjectsService } from '../projects/projects.service';

@Controller('logs')
export class LogsController {
  constructor(
    private readonly logsService: LogsService,
    private readonly projectsService: ProjectsService,
  ) {}

  // Если projectId не передан — берём активный проект (обычный случай с фронта).
  private resolve(projectId?: string): string {
    return projectId || this.projectsService.getActiveProjectId() || '';
  }

  @Get()
  list(@Query('projectId') projectId?: string) {
    return this.logsService.list(this.resolve(projectId));
  }

  @Post()
  append(@Body() body: { projectId?: string; entries: Partial<LogEntry>[] }) {
    return this.logsService.append(this.resolve(body.projectId), body.entries ?? []);
  }

  @Delete()
  clear(@Query('projectId') projectId?: string) {
    this.logsService.clear(this.resolve(projectId));
    return { success: true };
  }
}
