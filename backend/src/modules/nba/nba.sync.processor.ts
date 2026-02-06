import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { NbaService } from "./nba.service";

@Processor("nba-sync")
export class NbaSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(NbaSyncProcessor.name);
  constructor(private readonly nbaService: NbaService) {
    super();
  }

  async process(job: Job) {
    const startedAt = Date.now();
    this.logger.log(
      `[job:start] ${job.name} id=${job.id} data=${JSON.stringify(job.data ?? {})}`
    );
    try {
      let result: unknown;
      switch (job.name) {
        case "sync-scoreboard":
          result = await this.nbaService.syncScoreboard(job.data?.date);
          break;
        case "sync-final-results":
          result = await this.nbaService.syncFinalResults(job.data?.date);
          break;
        case "sync-player-game-stats":
          result = await this.nbaService.syncPlayerGameStats(
            job.data?.date,
            job.data?.gameId
          );
          break;
        case "sync-players":
          result = await this.nbaService.syncPlayers(job.data?.season);
          break;
        case "sync-player-season-teams":
          result = await this.nbaService.syncPlayerSeasonTeams(job.data?.season);
          break;
        case "sync-injury-report":
          result = await this.nbaService.syncInjuryReport();
          break;
        default:
          result = { skipped: true };
          break;
      }
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[job:ok] ${job.name} id=${job.id} durationMs=${durationMs} result=${JSON.stringify(result)}`
      );
      return result;
    } catch (error) {
      const seasonMatch = String(job.data?.season || "").match(/(\d{4})/);
      const season = seasonMatch ? Number(seasonMatch[1]) : undefined;
      await this.nbaService.recordConflict({
        conflictType: "job_failed",
        season,
        jobId: job.id,
        detailsJson: {
          name: job.name,
          message: error instanceof Error ? error.message : String(error)
        }
      });
      const durationMs = Date.now() - startedAt;
      this.logger.error(
        `[job:fail] ${job.name} id=${job.id} durationMs=${durationMs} error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined
      );
      throw error;
    }
  }
}
