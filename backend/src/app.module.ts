import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HealthController } from "./health.controller";
import { join } from "path";
import { NbaModule } from "./modules/nba/nba.module";
import { PolymarketModule } from "./modules/polymarket/polymarket.module";
import { X402Module } from "./modules/x402/x402.module";
import { BullModule } from "@nestjs/bullmq";
import { ScheduleModule } from "@nestjs/schedule";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || "redis",
        port: Number(process.env.REDIS_PORT || 6379)
      }
    }),
    TypeOrmModule.forRoot({
      type: "postgres",
      url: process.env.DATABASE_URL,
      autoLoadEntities: true,
      synchronize: false,
      logging: false,
      migrationsRun: false,
      migrationsTableName: "typeorm_migrations",
      migrations: [join(__dirname, "infra/db/migrations/*{.ts,.js}")]
    }),
    NbaModule,
    PolymarketModule,
    X402Module
  ],
  controllers: [HealthController]
})
export class AppModule {}
