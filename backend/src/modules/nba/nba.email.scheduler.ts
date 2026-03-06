import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

@Injectable()
export class NbaEmailScheduler {
  private readonly logger = new Logger(NbaEmailScheduler.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue("nba-email") private readonly queue: Queue
  ) {}

  @Cron(process.env.NBA_DAILY_ANALYSIS_CRON || "0 0 * * *", {
    timeZone: process.env.NBA_DAILY_ANALYSIS_TZ || "America/New_York"
  })
  async enqueueDailyDigest() {
    const enabled = this.configService.get<string>("NBA_DAILY_ANALYSIS_ENABLED");
    if (enabled !== "true") {
      return;
    }

    const tz =
      this.configService.get<string>("NBA_DAILY_ANALYSIS_TZ") ||
      "America/New_York";
    const date =
      this.configService.get<string>("NBA_DAILY_ANALYSIS_DATE") ||
      this.formatDateInTimeZone(new Date(), tz);
    const jobId = `daily-analysis-digest:${date}`;
    await this.queue.add(
      "send-daily-analysis-digest",
      { date, trigger: "cron" },
      { jobId }
    );
    this.logger.log(
      `[cron] enqueue send-daily-analysis-digest date=${date} tz=${tz}`
    );
  }

  private formatDateInTimeZone(date: Date, timeZone: string) {
    if (timeZone.toUpperCase() === "UTC") {
      return date.toISOString().slice(0, 10);
    }
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }
}
