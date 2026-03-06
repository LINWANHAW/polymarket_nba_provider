import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { NbaEmailService } from "./nba.email.service";

@Processor("nba-email")
export class NbaEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(NbaEmailProcessor.name);

  constructor(private readonly nbaEmailService: NbaEmailService) {
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
        case "send-subscription-thank-you":
          result = await this.nbaEmailService.sendSubscriptionThankYou(
            String(job.data?.subscriptionId || "")
          );
          break;
        case "send-daily-analysis-digest":
          result = await this.nbaEmailService.enqueueDailyDigestForSubscribers(
            typeof job.data?.date === "string" ? job.data.date : undefined
          );
          break;
        case "send-daily-analysis-email":
          result = await this.nbaEmailService.sendDailyDigestEmail(
            String(job.data?.subscriptionId || ""),
            String(job.data?.digestId || "")
          );
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
      const durationMs = Date.now() - startedAt;
      this.logger.error(
        `[job:fail] ${job.name} id=${job.id} durationMs=${durationMs} error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined
      );
      throw error;
    }
  }
}
