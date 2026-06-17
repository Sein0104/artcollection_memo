import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);
  app.useBodyParser("json", { limit: "12mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "12mb" });
  app.enableCors({
    origin: config.get<string>("FRONTEND_ORIGIN") || true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  await app.listen(Number(config.get<string>("PORT") || 3001));
}

void bootstrap();
