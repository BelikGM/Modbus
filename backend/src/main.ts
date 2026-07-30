import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  // bodyParser у Express по умолчанию режет JSON на 100 КБ — фотография
  // устройства, приходящая в base64 при создании своего типа ПЧ, в этот лимит
  // не влезает и запрос отваливался бы с 413.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '25mb' });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableCors({ origin: '*' });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(3000);
  console.log('Backend running on http://localhost:3000');
}
bootstrap();
