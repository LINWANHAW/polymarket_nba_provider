import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { NbaController } from "./nba.controller";
import { NbaService } from "./nba.service";
import { Game } from "./entities/game.entity";
import { Team } from "./entities/team.entity";
import { TeamGameStat } from "./entities/team-game-stat.entity";
import { Player } from "./entities/player.entity";
import { PlayerGameStats } from "./entities/player-game-stats.entity";
import { PlayerSeasonTeam } from "./entities/player-season-team.entity";
import { DataConflict } from "./entities/data-conflict.entity";
import { InjuryReport } from "./entities/injury-report.entity";
import { InjuryReportEntry } from "./entities/injury-report-entry.entity";
import { NbaAnalysisLog } from "./entities/nba-analysis-log.entity";
import { EmailSubscription } from "./entities/email-subscription.entity";
import { NbaDailyAnalysisDigest } from "./entities/nba-daily-analysis-digest.entity";
import { NbaSyncProcessor } from "./nba.sync.processor";
import { NbaSyncScheduler } from "./nba.sync.scheduler";
import { NbaEmailService } from "./nba.email.service";
import { NbaEmailProcessor } from "./nba.email.processor";
import { NbaEmailScheduler } from "./nba.email.scheduler";
import { Event } from "../polymarket/entities/event.entity";
import { Market } from "../polymarket/entities/market.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Team,
      Game,
      TeamGameStat,
      Player,
      PlayerGameStats,
      PlayerSeasonTeam,
      DataConflict,
      InjuryReport,
      InjuryReportEntry,
      NbaAnalysisLog,
      EmailSubscription,
      NbaDailyAnalysisDigest,
      Event,
      Market
    ]),
    BullModule.registerQueue({
      name: "nba-sync",
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 30000
        },
        removeOnComplete: 100,
        removeOnFail: 100
      }
    }),
    BullModule.registerQueue({
      name: "nba-email",
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 30000
        },
        removeOnComplete: 100,
        removeOnFail: 100
      }
    })
  ],
  providers: [
    NbaService,
    NbaSyncProcessor,
    NbaSyncScheduler,
    NbaEmailService,
    NbaEmailProcessor,
    NbaEmailScheduler
  ],
  controllers: [NbaController],
  exports: [NbaService]
})
export class NbaModule {}
