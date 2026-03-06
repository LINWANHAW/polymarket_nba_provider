import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import * as nodemailer from "nodemailer";
import { createHmac, timingSafeEqual } from "crypto";
import { EmailSubscription } from "./entities/email-subscription.entity";
import { NbaDailyAnalysisDigest } from "./entities/nba-daily-analysis-digest.entity";
import { GameAnalysisResult, NbaService } from "./nba.service";

type SubscriptionContext = {
  source?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

type SnsEnvelope = {
  Type?: string;
  TopicArn?: string;
  Message?: string;
  SubscribeURL?: string;
};

type SesNotificationMessage = {
  notificationType?: string;
  bounce?: {
    bouncedRecipients?: Array<{ emailAddress?: string }>;
  };
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>;
  };
};

type DailyDigestGameAnalysis = {
  gameId: string;
  dateTimeUtc: string | null;
  status: string | null;
  season: number | null;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  analysis: {
    homeWinPct: number | null;
    awayWinPct: number | null;
    confidence: number | null;
    keyFactors: string[];
    analysis: string;
    model: string;
    generatedAt: string;
    disclaimer: string;
  } | null;
  error: string | null;
};

@Injectable()
export class NbaEmailService {
  private readonly logger = new Logger(NbaEmailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly nbaService: NbaService,
    @InjectRepository(EmailSubscription)
    private readonly emailSubscriptionRepo: Repository<EmailSubscription>,
    @InjectRepository(NbaDailyAnalysisDigest)
    private readonly dailyDigestRepo: Repository<NbaDailyAnalysisDigest>,
    @InjectQueue("nba-email") private readonly queue: Queue
  ) {}

  async subscribe(emailInput: string, context?: SubscriptionContext) {
    const email = this.normalizeAndValidateEmail(emailInput);
    const now = new Date();
    const consentSource = this.normalizeConsentSource(context?.source);
    const consentIp = this.normalizeNullableString(context?.ip, 120);
    const consentUserAgent = this.normalizeNullableString(
      context?.userAgent,
      512
    );

    const insertResult = await this.emailSubscriptionRepo
      .createQueryBuilder()
      .insert()
      .into(EmailSubscription)
      .values({
        email,
        isActive: true,
        subscribedAt: now,
        consentSource,
        consentIp,
        consentUserAgent,
        unsubscribedAt: null,
        unsubscribeReason: null,
        lastWelcomeEmailSentAt: null,
        lastWelcomeEmailError: null,
        updatedAt: now
      })
      .orIgnore()
      .execute();

    const inserted = (insertResult.identifiers?.length ?? 0) > 0;
    let reactivated = false;

    if (!inserted) {
      const reactivateResult = await this.emailSubscriptionRepo
        .createQueryBuilder()
        .update(EmailSubscription)
        .set({
          isActive: true,
          subscribedAt: now,
          consentSource,
          consentIp,
          consentUserAgent,
          unsubscribedAt: null,
          unsubscribeReason: null,
          lastWelcomeEmailError: null,
          updatedAt: now
        })
        .where("email = :email", { email })
        .andWhere("is_active = false")
        .execute();
      reactivated = (reactivateResult.affected ?? 0) > 0;
    }

    const subscription = await this.emailSubscriptionRepo.findOne({
      where: { email }
    });
    if (!subscription) {
      throw new Error("failed to load subscription");
    }

    const shouldQueueWelcome = inserted || reactivated;
    const alreadySubscribed = !shouldQueueWelcome;

    if (shouldQueueWelcome) {
      await this.queue.add("send-subscription-thank-you", {
        subscriptionId: subscription.id
      });
    }

    return {
      id: subscription.id,
      email: subscription.email,
      isActive: subscription.isActive,
      subscribedAt: subscription.subscribedAt,
      consentSource: subscription.consentSource,
      consentIp: subscription.consentIp,
      consentUserAgent: subscription.consentUserAgent,
      alreadySubscribed,
      welcomeEmailQueued: shouldQueueWelcome,
      message: alreadySubscribed
        ? "Email already subscribed."
        : "Subscription successful. Welcome email queued."
    };
  }

  async unsubscribeByToken(input: { token: string; source?: string | null }) {
    const token = String(input.token || "").trim();
    if (!token) {
      throw new BadRequestException("token is required");
    }

    const decoded = this.verifyUnsubscribeToken(token);
    const subscription = await this.emailSubscriptionRepo.findOne({
      where: { id: decoded.subscriptionId }
    });

    if (!subscription || subscription.email !== decoded.email) {
      throw new BadRequestException("invalid unsubscribe token");
    }

    if (!subscription.isActive) {
      return {
        unsubscribed: true,
        alreadyInactive: true,
        email: subscription.email,
        message: "Email is already unsubscribed."
      };
    }

    subscription.isActive = false;
    subscription.unsubscribedAt = new Date();
    subscription.unsubscribeReason =
      this.normalizeConsentSource(input.source) || "user_unsubscribe";
    subscription.updatedAt = new Date();
    await this.emailSubscriptionRepo.save(subscription);

    return {
      unsubscribed: true,
      alreadyInactive: false,
      email: subscription.email,
      message: "Unsubscribed successfully."
    };
  }

  async handleSesFeedback(
    payloadInput: unknown,
    options?: { webhookToken?: string | null }
  ) {
    this.assertSesWebhookToken(options?.webhookToken);

    const payload = this.toRecord(payloadInput);
    const type = this.normalizeNullableString(payload.Type, 64);
    const topicArn = this.normalizeNullableString(payload.TopicArn, 512);
    const allowedTopicArn = this.normalizeNullableString(
      this.configService.get<string>("EMAIL_SES_ALLOWED_TOPIC_ARN"),
      512
    );

    if (allowedTopicArn && topicArn !== allowedTopicArn) {
      return {
        accepted: false,
        ignored: true,
        reason: "topic_not_allowed",
        topicArn
      };
    }

    if (type === "SubscriptionConfirmation") {
      const subscribeURL = this.normalizeNullableString(payload.SubscribeURL, 2048);
      if (!subscribeURL) {
        return { accepted: true, ignored: true, type, reason: "missing_url" };
      }
      const confirmed = await this.confirmSnsSubscription(subscribeURL);
      return { accepted: true, type, confirmed };
    }

    if (type !== "Notification") {
      return { accepted: true, ignored: true, type: type ?? "unknown" };
    }

    const message = this.parseJsonObject<SesNotificationMessage>(payload.Message);
    const notificationType = this.normalizeNullableString(
      message?.notificationType,
      64
    );
    if (!notificationType) {
      return { accepted: true, ignored: true, reason: "missing_notification_type" };
    }

    const normalizedType = notificationType.toLowerCase();
    let emails: string[] = [];
    let reason = "";

    if (normalizedType === "bounce") {
      emails = this.collectEmails(message?.bounce?.bouncedRecipients ?? []);
      reason = "ses_bounce";
    } else if (normalizedType === "complaint") {
      emails = this.collectEmails(message?.complaint?.complainedRecipients ?? []);
      reason = "ses_complaint";
    } else {
      return {
        accepted: true,
        ignored: true,
        notificationType
      };
    }

    if (emails.length === 0) {
      return {
        accepted: true,
        ignored: true,
        notificationType,
        reason: "no_recipients"
      };
    }

    const now = new Date();
    const result = await this.emailSubscriptionRepo
      .createQueryBuilder()
      .update(EmailSubscription)
      .set({
        isActive: false,
        unsubscribedAt: now,
        unsubscribeReason: reason,
        updatedAt: now
      })
      .where("LOWER(email) IN (:...emails)", { emails })
      .andWhere("is_active = true")
      .execute();

    return {
      accepted: true,
      notificationType,
      deactivated: result.affected ?? 0,
      emails
    };
  }

  async sendSubscriptionThankYou(subscriptionId: string) {
    const subscription = await this.emailSubscriptionRepo.findOne({
      where: { id: subscriptionId }
    });
    if (!subscription || !subscription.isActive) {
      return { skipped: true };
    }

    try {
      await this.sendThankYouEmail(subscription);
      subscription.lastWelcomeEmailSentAt = new Date();
      subscription.lastWelcomeEmailError = null;
      subscription.updatedAt = new Date();
      await this.emailSubscriptionRepo.save(subscription);
      return { sent: true, email: subscription.email };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "send_failed");
      subscription.lastWelcomeEmailError = message;
      subscription.updatedAt = new Date();
      await this.emailSubscriptionRepo.save(subscription);
      throw error;
    }
  }

  async enqueueDailyDigestForSubscribers(dateInput?: string) {
    const digest = await this.generateDailyDigest(dateInput);
    const subscribers = await this.emailSubscriptionRepo.find({
      where: { isActive: true },
      order: { createdAt: "ASC" }
    });

    if (subscribers.length === 0) {
      await this.dailyDigestRepo.update(digest.id, {
        subscriberCount: 0,
        queuedCount: 0,
        updatedAt: new Date()
      });
      return {
        digestId: digest.id,
        date: digest.digestDate,
        subscribers: 0,
        queued: 0
      };
    }

    const jobs = subscribers.map((subscription) => ({
      name: "send-daily-analysis-email",
      data: {
        subscriptionId: subscription.id,
        digestId: digest.id
      },
      opts: {
        jobId: `daily-analysis-email:${digest.digestDate}:${subscription.id}`
      }
    }));

    await this.queue.addBulk(jobs as any);
    await this.dailyDigestRepo.update(digest.id, {
      subscriberCount: subscribers.length,
      queuedCount: jobs.length,
      updatedAt: new Date()
    });

    return {
      digestId: digest.id,
      date: digest.digestDate,
      subscribers: subscribers.length,
      queued: jobs.length
    };
  }

  async sendDailyDigestEmail(subscriptionId: string, digestId: string) {
    const [subscription, digest] = await Promise.all([
      this.emailSubscriptionRepo.findOne({ where: { id: subscriptionId } }),
      this.dailyDigestRepo.findOne({ where: { id: digestId } })
    ]);

    if (!subscription || !subscription.isActive || !digest) {
      return { skipped: true };
    }

    const games = Array.isArray(digest.payloadJson?.games)
      ? (digest.payloadJson.games as DailyDigestGameAnalysis[])
      : [];
    if (games.length === 0) {
      return { skipped: true, reason: "no_games" };
    }

    const transporter = this.resolveTransporter();
    const from =
      this.configService.get<string>("EMAIL_FROM")?.trim() ||
      this.configService.get<string>("EMAIL_SMTP_USER")?.trim() ||
      "";
    const appName =
      this.configService.get<string>("EMAIL_APP_NAME")?.trim() ||
      "Polymarket NBA";
    const subjectPrefix =
      this.configService
        .get<string>("EMAIL_DAILY_ANALYSIS_SUBJECT_PREFIX")
        ?.trim() || `${appName} Daily NBA Analysis`;
    const subject = `${subjectPrefix} ${digest.digestDate}`;
    const unsubscribeUrl = this.buildUnsubscribeUrl(subscription);
    const privacyPolicyUrl =
      this.configService.get<string>("EMAIL_PRIVACY_POLICY_URL")?.trim() || "";

    if (!from) {
      throw new Error("missing EMAIL_FROM or EMAIL_SMTP_USER");
    }

    const content = this.buildDailyDigestEmailContent({
      digestDate: digest.digestDate,
      appName,
      games,
      unsubscribeUrl,
      privacyPolicyUrl
    });

    try {
      await transporter.sendMail({
        from,
        to: subscription.email,
        subject,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
        },
        text: content.text,
        html: content.html
      });
      await this.incrementDigestCounter(digest.id, "delivered_count");
      return { sent: true, email: subscription.email, digestDate: digest.digestDate };
    } catch (error) {
      await this.incrementDigestCounter(digest.id, "failed_count");
      throw error;
    }
  }

  async generateDailyDigest(dateInput?: string) {
    const date = this.resolveDailyDigestDate(dateInput);
    const sourceTz = this.resolveDailyDigestTimeZone();
    const existing = await this.dailyDigestRepo.findOne({
      where: { digestDate: date }
    });

    const existingGames = Array.isArray(existing?.payloadJson?.games)
      ? existing?.payloadJson?.games
      : [];
    if (existing && existing.status === "generated" && existingGames.length > 0) {
      return existing;
    }

    try {
      try {
        await this.nbaService.syncScoreboard(date);
      } catch (error) {
        this.logger.warn(
          `daily digest pre-sync scoreboard failed date=${date} error=${error instanceof Error ? error.message : String(error)}`
        );
      }

      const maxGames = this.parsePositiveInt(
        this.configService.get<string>("NBA_DAILY_ANALYSIS_MAX_GAMES"),
        20
      );
      const [teams, gamesPage] = await Promise.all([
        this.nbaService.listTeams(),
        this.nbaService.listGames({
          date,
          page: 1,
          pageSize: maxGames
        })
      ]);
      const teamAbbrevById = new Map(
        teams.map((team) => [team.id, team.abbrev?.toUpperCase() || ""])
      );
      const games = [...(gamesPage.data || [])].sort((a, b) => {
        const aTime = a.dateTimeUtc ? new Date(a.dateTimeUtc).getTime() : 0;
        const bTime = b.dateTimeUtc ? new Date(b.dateTimeUtc).getTime() : 0;
        return aTime - bTime;
      });

      const analyses: DailyDigestGameAnalysis[] = [];
      let analysisCount = 0;

      for (const game of games) {
        const home = teamAbbrevById.get(game.homeTeamId) || "";
        const away = teamAbbrevById.get(game.awayTeamId) || "";
        if (!home || !away) {
          analyses.push({
            gameId: game.id,
            dateTimeUtc: game.dateTimeUtc
              ? new Date(game.dateTimeUtc).toISOString()
              : null,
            status: game.status ?? null,
            season: game.season ?? null,
            home: home || "HOME",
            away: away || "AWAY",
            homeScore: game.homeScore ?? null,
            awayScore: game.awayScore ?? null,
            analysis: null,
            error: "missing_team_abbrev"
          });
          continue;
        }

        try {
          const result = await this.nbaService.analyzeGameByMatchup({
            date,
            home,
            away
          });
          if (!result) {
            analyses.push({
              gameId: game.id,
              dateTimeUtc: game.dateTimeUtc
                ? new Date(game.dateTimeUtc).toISOString()
                : null,
              status: game.status ?? null,
              season: game.season ?? null,
              home,
              away,
              homeScore: game.homeScore ?? null,
              awayScore: game.awayScore ?? null,
              analysis: null,
              error: "analysis_not_available"
            });
            continue;
          }
          analyses.push(this.toDailyDigestGameAnalysis(game, home, away, result));
          analysisCount += 1;
        } catch (error) {
          analyses.push({
            gameId: game.id,
            dateTimeUtc: game.dateTimeUtc
              ? new Date(game.dateTimeUtc).toISOString()
              : null,
            status: game.status ?? null,
            season: game.season ?? null,
            home,
            away,
            homeScore: game.homeScore ?? null,
            awayScore: game.awayScore ?? null,
            analysis: null,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      await this.dailyDigestRepo.upsert(
        {
          digestDate: date,
          sourceTz,
          gameCount: games.length,
          analysisCount,
          status: "generated",
          error: null,
          payloadJson: {
            date,
            sourceTz,
            generatedAt: new Date().toISOString(),
            games: analyses
          } as Record<string, any>,
          generatedAt: new Date(),
          updatedAt: new Date()
        },
        ["digestDate"]
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "digest_failed");
      await this.dailyDigestRepo.upsert(
        {
          digestDate: date,
          sourceTz,
          status: "failed",
          error: message,
          payloadJson: {
            date,
            sourceTz,
            generatedAt: new Date().toISOString(),
            games: []
          } as Record<string, any>,
          updatedAt: new Date()
        },
        ["digestDate"]
      );
      throw error;
    }

    const digest = await this.dailyDigestRepo.findOne({
      where: { digestDate: date }
    });
    if (!digest) {
      throw new Error(`failed to persist daily digest date=${date}`);
    }
    return digest;
  }

  private normalizeAndValidateEmail(emailInput: string) {
    const email = String(emailInput ?? "")
      .trim()
      .toLowerCase();

    if (!email) {
      throw new BadRequestException("email is required");
    }

    if (email.length > 320) {
      throw new BadRequestException("email is too long");
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("email format is invalid");
    }

    return email;
  }

  private normalizeConsentSource(value?: string | null) {
    return this.normalizeNullableString(value, 120);
  }

  private normalizeNullableString(
    value: string | null | undefined,
    maxLength: number
  ) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.slice(0, maxLength);
  }

  private parsePositiveInt(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }

  private resolveDailyDigestTimeZone() {
    return (
      this.configService.get<string>("NBA_DAILY_ANALYSIS_TZ") ||
      "America/New_York"
    );
  }

  private resolveDailyDigestDate(explicitDate?: string) {
    if (explicitDate) {
      return this.parseDateInput(explicitDate);
    }
    return this.formatDateInTimeZone(new Date(), this.resolveDailyDigestTimeZone());
  }

  private parseDateInput(value: string) {
    const normalized = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new BadRequestException("date must be YYYY-MM-DD");
    }
    const parsed = new Date(`${normalized}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException("date must be YYYY-MM-DD");
    }
    return normalized;
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

  private toDailyDigestGameAnalysis(
    game: any,
    home: string,
    away: string,
    result: GameAnalysisResult
  ): DailyDigestGameAnalysis {
    return {
      gameId: game.id,
      dateTimeUtc: game.dateTimeUtc
        ? new Date(game.dateTimeUtc).toISOString()
        : null,
      status: game.status ?? null,
      season: game.season ?? null,
      home,
      away,
      homeScore: game.homeScore ?? null,
      awayScore: game.awayScore ?? null,
      analysis: {
        homeWinPct: result.homeWinPct ?? null,
        awayWinPct: result.awayWinPct ?? null,
        confidence: result.confidence ?? null,
        keyFactors: Array.isArray(result.keyFactors) ? result.keyFactors : [],
        analysis: result.analysis ?? "",
        model: result.model ?? "",
        generatedAt: result.generatedAt ?? "",
        disclaimer: result.disclaimer ?? ""
      },
      error: null
    };
  }

  private buildDailyDigestEmailContent(input: {
    digestDate: string;
    appName: string;
    games: DailyDigestGameAnalysis[];
    unsubscribeUrl: string;
    privacyPolicyUrl?: string;
  }) {
    const lines = [
      `${input.appName} daily analysis for ${input.digestDate}`,
      ""
    ];

    for (const game of input.games) {
      const matchup = `${game.away} @ ${game.home}`;
      const confidence =
        typeof game.analysis?.confidence === "number"
          ? `${game.analysis.confidence.toFixed(1)}%`
          : "N/A";
      const winLine =
        game.analysis &&
        typeof game.analysis.homeWinPct === "number" &&
        typeof game.analysis.awayWinPct === "number"
          ? `${game.home} ${game.analysis.homeWinPct.toFixed(1)}% / ${game.away} ${game.analysis.awayWinPct.toFixed(1)}%`
          : "win probability unavailable";
      const summary = game.analysis?.analysis || game.error || "No analysis";

      lines.push(`- ${matchup}`);
      lines.push(`  confidence: ${confidence}`);
      lines.push(`  ${winLine}`);
      lines.push(`  ${summary}`);
      lines.push("");
    }

    lines.push(`Unsubscribe: ${input.unsubscribeUrl}`);
    if (input.privacyPolicyUrl) {
      lines.push(`Privacy policy: ${input.privacyPolicyUrl}`);
    }

    const rows = input.games
      .map((game) => {
        const matchup = `${game.away} @ ${game.home}`;
        const score =
          game.homeScore !== null && game.awayScore !== null
            ? `${game.away} ${game.awayScore} - ${game.home} ${game.homeScore}`
            : "-";
        const confidence =
          typeof game.analysis?.confidence === "number"
            ? `${game.analysis.confidence.toFixed(1)}%`
            : "N/A";
        const winLine =
          game.analysis &&
          typeof game.analysis.homeWinPct === "number" &&
          typeof game.analysis.awayWinPct === "number"
            ? `${game.home} ${game.analysis.homeWinPct.toFixed(1)}% / ${game.away} ${game.analysis.awayWinPct.toFixed(1)}%`
            : "N/A";
        const summary = game.analysis?.analysis || game.error || "No analysis";
        return `<tr><td>${this.escapeHtml(matchup)}</td><td>${this.escapeHtml(
          score
        )}</td><td>${this.escapeHtml(confidence)}</td><td>${this.escapeHtml(
          winLine
        )}</td><td>${this.escapeHtml(summary)}</td></tr>`;
      })
      .join("");

    const privacyHtml = input.privacyPolicyUrl
      ? `<p><a href="${input.privacyPolicyUrl}">Privacy policy</a></p>`
      : "";

    const html =
      `<p>${this.escapeHtml(input.appName)} daily analysis for <strong>${this.escapeHtml(
        input.digestDate
      )}</strong></p>` +
      '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;">' +
      "<thead><tr><th>Matchup</th><th>Score</th><th>Confidence</th><th>Win Probabilities</th><th>Summary</th></tr></thead>" +
      `<tbody>${rows}</tbody></table>` +
      `<p><a href="${input.unsubscribeUrl}">Unsubscribe</a></p>` +
      privacyHtml;

    return {
      text: lines.join("\n"),
      html
    };
  }

  private escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private async incrementDigestCounter(
    digestId: string,
    counter: "delivered_count" | "failed_count"
  ) {
    await this.dailyDigestRepo.query(
      `UPDATE "nba_daily_analysis_digest"
       SET "${counter}" = "${counter}" + 1,
           "updated_at" = now()
       WHERE "id" = $1`,
      [digestId]
    );
  }

  private parseBoolean(value: string | undefined, fallback = false) {
    if (!value) {
      return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") {
      return true;
    }
    if (normalized === "0" || normalized === "false") {
      return false;
    }
    return fallback;
  }

  private resolveTransporter() {
    if (this.transporter) {
      return this.transporter;
    }

    const host = this.configService.get<string>("EMAIL_SMTP_HOST")?.trim();
    const user = this.configService.get<string>("EMAIL_SMTP_USER")?.trim();
    const pass = this.configService.get<string>("EMAIL_SMTP_PASS")?.trim();
    const port = Number(this.configService.get<string>("EMAIL_SMTP_PORT") || 587);
    const secure = this.parseBoolean(
      this.configService.get<string>("EMAIL_SMTP_SECURE"),
      port === 465
    );

    if (!host || !user || !pass) {
      throw new Error(
        "missing EMAIL_SMTP_HOST / EMAIL_SMTP_USER / EMAIL_SMTP_PASS config"
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass }
    });

    return this.transporter;
  }

  private resolveUnsubscribeSecret() {
    const explicit = this.configService
      .get<string>("EMAIL_UNSUBSCRIBE_SECRET")
      ?.trim();
    const fallback = this.configService.get<string>("EMAIL_SMTP_PASS")?.trim();
    return explicit || fallback || "";
  }

  private createUnsubscribeToken(subscription: EmailSubscription) {
    const secret = this.resolveUnsubscribeSecret();
    if (!secret) {
      throw new Error("missing EMAIL_UNSUBSCRIBE_SECRET");
    }

    const payload = {
      sid: subscription.id,
      email: subscription.email,
      iat: Date.now()
    };
    const payloadText = JSON.stringify(payload);
    const payloadEncoded = Buffer.from(payloadText, "utf8").toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(payloadEncoded)
      .digest("base64url");
    return `${payloadEncoded}.${signature}`;
  }

  private verifyUnsubscribeToken(token: string) {
    const parts = token.split(".");
    if (parts.length !== 2) {
      throw new BadRequestException("invalid unsubscribe token");
    }

    const [payloadEncoded, signature] = parts;
    const secret = this.resolveUnsubscribeSecret();
    if (!secret) {
      throw new BadRequestException("unsubscribe token is not configured");
    }

    const expected = createHmac("sha256", secret)
      .update(payloadEncoded)
      .digest("base64url");
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (
      sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)
    ) {
      throw new BadRequestException("invalid unsubscribe token");
    }

    let payload: { sid?: string; email?: string } = {};
    try {
      payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString("utf8"));
    } catch {
      throw new BadRequestException("invalid unsubscribe token");
    }

    const subscriptionId = this.normalizeNullableString(payload.sid ?? null, 64);
    const email = this.normalizeAndValidateEmail(payload.email ?? "");
    if (!subscriptionId) {
      throw new BadRequestException("invalid unsubscribe token");
    }
    return { subscriptionId, email };
  }

  private resolveUnsubscribeBaseUrl() {
    const configured =
      this.configService.get<string>("EMAIL_UNSUBSCRIBE_BASE_URL") ||
      this.configService.get<string>("PUBLIC_API_BASE") ||
      this.configService.get<string>("CORS_ORIGIN");
    const fallback = "http://localhost:3000";
    return (configured || fallback).split(",")[0].trim().replace(/\/+$/, "");
  }

  private buildUnsubscribeUrl(subscription: EmailSubscription) {
    const token = this.createUnsubscribeToken(subscription);
    const baseUrl = this.resolveUnsubscribeBaseUrl();
    return `${baseUrl}/nba/subscriptions/email/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  private async sendThankYouEmail(subscription: EmailSubscription) {
    const transporter = this.resolveTransporter();
    const from =
      this.configService.get<string>("EMAIL_FROM")?.trim() ||
      this.configService.get<string>("EMAIL_SMTP_USER")?.trim() ||
      "";
    const subject =
      this.configService.get<string>("EMAIL_WELCOME_SUBJECT")?.trim() ||
      "Thanks for subscribing to Polymarket NBA updates";
    const appName =
      this.configService.get<string>("EMAIL_APP_NAME")?.trim() ||
      "Polymarket NBA";
    const unsubscribeUrl = this.buildUnsubscribeUrl(subscription);
    const privacyPolicyUrl =
      this.configService.get<string>("EMAIL_PRIVACY_POLICY_URL")?.trim() || "";

    if (!from) {
      throw new Error("missing EMAIL_FROM or EMAIL_SMTP_USER");
    }

    const plainPrivacy = privacyPolicyUrl
      ? `\nPrivacy policy: ${privacyPolicyUrl}`
      : "";
    const htmlPrivacy = privacyPolicyUrl
      ? `<p><a href="${privacyPolicyUrl}">Privacy policy</a></p>`
      : "";

    await transporter.sendMail({
      from,
      to: subscription.email,
      subject,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      },
      text:
        `Hi,\n\nThanks for subscribing to ${appName} notifications.\n` +
        "We'll keep you updated with NBA related updates.\n\n" +
        `If you want to unsubscribe, open: ${unsubscribeUrl}\n` +
        plainPrivacy +
        `\n\n- ${appName}`,
      html:
        `<p>Hi,</p><p>Thanks for subscribing to <strong>${appName}</strong> notifications.</p>` +
        "<p>We'll keep you updated with NBA related updates.</p>" +
        `<p><a href="${unsubscribeUrl}">Unsubscribe</a></p>` +
        htmlPrivacy +
        `<p>- ${appName}</p>`
    });

    this.logger.log(`welcome email sent to ${subscription.email}`);
  }

  private assertSesWebhookToken(receivedToken?: string | null) {
    const expectedToken = this.normalizeNullableString(
      this.configService.get<string>("EMAIL_SES_WEBHOOK_TOKEN"),
      256
    );
    if (!expectedToken) {
      return;
    }
    const normalizedReceived = this.normalizeNullableString(receivedToken, 256);
    if (!normalizedReceived || normalizedReceived !== expectedToken) {
      throw new UnauthorizedException("invalid webhook token");
    }
  }

  private toRecord(value: unknown): SnsEnvelope {
    if (!value || typeof value !== "object") {
      return {};
    }
    return value as SnsEnvelope;
  }

  private parseJsonObject<T>(value: unknown): T | null {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return parsed as T;
    } catch {
      return null;
    }
  }

  private collectEmails(rows: Array<{ emailAddress?: string }>) {
    const set = new Set<string>();
    for (const row of rows) {
      const normalized = this.normalizeNullableString(row?.emailAddress ?? null, 320);
      if (!normalized) {
        continue;
      }
      try {
        set.add(this.normalizeAndValidateEmail(normalized));
      } catch {
        // Ignore malformed upstream recipient values.
      }
    }
    return Array.from(set);
  }

  private async confirmSnsSubscription(subscribeURL: string) {
    let parsed: URL;
    try {
      parsed = new URL(subscribeURL);
    } catch {
      return false;
    }

    if (parsed.protocol !== "https:") {
      return false;
    }
    if (!parsed.hostname.endsWith(".amazonaws.com")) {
      return false;
    }

    try {
      const response = await fetch(parsed.toString(), {
        method: "GET"
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
