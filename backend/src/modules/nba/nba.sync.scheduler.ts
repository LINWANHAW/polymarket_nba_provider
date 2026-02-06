import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

@Injectable()
export class NbaSyncScheduler {
  private readonly logger = new Logger(NbaSyncScheduler.name);
  constructor(
    private readonly configService: ConfigService,
    @InjectQueue("nba-sync") private readonly queue: Queue
  ) {}

  private resolveDate(explicit?: string) {
    return explicit || this.formatToday();
  }

  private resolveDays(value?: string, fallback = 7) {
    if (!value) {
      return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return fallback;
    }
    return parsed;
  }

  private buildDateRange(startDate: string, daysAhead: number) {
    const start = new Date(`${startDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) {
      return [startDate];
    }
    const dates: string[] = [];
    for (let offset = 0; offset <= daysAhead; offset += 1) {
      const current = new Date(start);
      current.setUTCDate(start.getUTCDate() + offset);
      dates.push(current.toISOString().slice(0, 10));
    }
    return dates;
  }

  private formatToday() {
    const tzRaw =
      this.configService.get<string>("NBA_SYNC_DATE_TZ") || "UTC";
    const tz = tzRaw.toUpperCase();
    if (tz === "ET" || tz === "EST" || tz === "EDT" || tz === "AMERICA/NEW_YORK") {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
    }
    return new Date().toISOString().slice(0, 10);
  }

  @Cron(process.env.NBA_SCOREBOARD_CRON || "*/10 * * * *")
  async enqueueScoreboard() {
    const date = this.resolveDate(
      this.configService.get<string>("NBA_SCOREBOARD_DATE")
    );
    await this.queue.add(
      "sync-scoreboard",
      { date },
      {}
    );
    this.logger.log(
      `[cron] enqueue sync-scoreboard date=${date} at ${new Date().toISOString()}`
    );
  }

  @Cron(process.env.NBA_FINAL_RESULTS_CRON || "*/15 * * * *")
  async enqueueFinalResults() {
    const date = this.resolveDate(
      this.configService.get<string>("NBA_FINAL_RESULTS_DATE")
    );
    await this.queue.add(
      "sync-final-results",
      { date },
      {}
    );
    this.logger.log(
      `[cron] enqueue sync-final-results date=${date} at ${new Date().toISOString()}`
    );
  }

  @Cron(process.env.NBA_HOURLY_CRON || "0 * * * *")
  async enqueueHourly() {
    const enabled = this.configService.get<string>("NBA_HOURLY_ENABLED");
    if (enabled !== "true") {
      return;
    }

    const date = this.resolveDate(
      this.configService.get<string>("NBA_HOURLY_DATE")
    );
    await this.queue.add("sync-scoreboard", { date }, {});
    await this.queue.add("sync-final-results", { date }, {});
    this.logger.log(
      `[cron] enqueue hourly sync-scoreboard+sync-final-results date=${date} at ${new Date().toISOString()}`
    );
  }

  @Cron(process.env.NBA_INJURY_REPORT_CRON || "30 * * * *")
  async enqueueInjuryReport() {
    await this.queue.add("sync-injury-report", {}, {});
    this.logger.log(
      `[cron] enqueue sync-injury-report at ${new Date().toISOString()}`
    );
  }

  @Cron(process.env.NBA_UPCOMING_SCHEDULE_CRON || "20 0 * * *")
  async enqueueUpcomingSchedule() {
    const enabled = this.configService.get<string>(
      "NBA_UPCOMING_SCHEDULE_ENABLED"
    );
    if (enabled === "false") {
      return;
    }

    const startDate = this.resolveDate(
      this.configService.get<string>("NBA_UPCOMING_SCHEDULE_DATE")
    );
    const daysAhead = this.resolveDays(
      this.configService.get<string>("NBA_UPCOMING_SCHEDULE_DAYS"),
      7
    );
    const dates = this.buildDateRange(startDate, daysAhead);

    for (const date of dates) {
      await this.queue.add("sync-scoreboard", { date }, {});
      this.logger.log(
        `[cron] enqueue sync-scoreboard (upcoming) date=${date} at ${new Date().toISOString()}`
      );
    }

    this.logger.log(
      `[cron] enqueue upcoming schedule range ${dates[0]}..${dates[dates.length - 1]} count=${dates.length} at ${new Date().toISOString()}`
    );
  }
}
