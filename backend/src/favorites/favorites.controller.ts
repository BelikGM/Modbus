import { Controller, Get, Put, Body, Query } from '@nestjs/common';
import { FavoritesService } from './favorites.service';

@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  get(@Query('family') family?: string) {
    return family ? this.favoritesService.get(family) : this.favoritesService.getAll();
  }

  @Put()
  set(@Body() body: { family: string; paramIds: string[] }) {
    return this.favoritesService.set(body.family, body.paramIds ?? []);
  }
}
