import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags
} from "@nestjs/swagger";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { NbaService } from "./nba.service";
import { NbaEmailService } from "./nba.email.service";
import {
  EmailSubscriptionRequestDto,
  EmailSubscriptionResponseDto,
  DailyDigestEnqueueResponseDto,
  EmailSesFeedbackResponseDto,
  EmailUnsubscribeRequestDto,
  EmailUnsubscribeResponseDto,
  GameAnalysisRequestDto,
  GameAnalysisResponseDto,
  GameContextResponseDto,
  GameDto,
  GameMarketsResponseDto,
  InjuryReportEntriesResponseDto,
  PaginatedNbaAnalysisLogDto,
  PaginatedDataConflictDto,
  PaginatedGameDto,
  PaginatedInjuryReportDto,
  PaginatedPlayerDto,
  PaginatedPlayerGameStatDto,
  PaginatedTeamGameStatDto,
  PlayerDto,
  SyncJobResponseDto,
  TeamDto
} from "./dto/swagger.dto";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decodePaymentResponseHeader } = require("@x402/core/http");

@Controller("nba")
@ApiTags("NBA")
export class NbaController {
  private static readonly MANUAL_SYNC_COOLDOWN_MS = 30 * 60 * 1000;

  constructor(
    private readonly nbaService: NbaService,
    private readonly nbaEmailService: NbaEmailService,
    @InjectQueue("nba-sync") private readonly queue: Queue
  ) {}

  @Post("sync/scoreboard")
  @ApiOperation({ summary: "Enqueue scoreboard sync" })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD" })
  @ApiOkResponse({
    description: "BullMQ job enqueued for scoreboard sync.",
    type: SyncJobResponseDto
  })
  async syncScoreboard(@Query("date") date?: string) {
    return this.enqueueManualSync("sync-scoreboard", date ? { date } : {});
  }

  @Post("sync/final-results")
  @ApiOperation({ summary: "Enqueue final results sync" })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD" })
  @ApiOkResponse({
    description: "BullMQ job enqueued for final results sync.",
    type: SyncJobResponseDto
  })
  async syncFinalResults(@Query("date") date?: string) {
    return this.enqueueManualSync(
      "sync-final-results",
      date ? { date } : {}
    );
  }

  @Post("sync/player-game-stats")
  @ApiOperation({ summary: "Enqueue player game stats sync" })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "gameId", required: false, description: "NBA GAME_ID" })
  @ApiOkResponse({
    description: "BullMQ job enqueued for player game stats sync.",
    type: SyncJobResponseDto
  })
  async syncPlayerGameStats(
    @Query("date") date?: string,
    @Query("gameId") gameId?: string
  ) {
    if (!date && !gameId) {
      throw new BadRequestException("date or gameId is required");
    }
    return this.enqueueManualSync("sync-player-game-stats", { date, gameId });
  }

  @Post("sync/players")
  @ApiOperation({ summary: "Enqueue players sync" })
  @ApiQuery({ name: "season", required: true, description: "e.g. 2024-25" })
  @ApiOkResponse({
    description: "BullMQ job enqueued for players sync.",
    type: SyncJobResponseDto
  })
  async syncPlayers(@Query("season") season: string) {
    if (!season) {
      throw new BadRequestException("season is required, e.g. 2024-25");
    }
    return this.enqueueManualSync("sync-players", { season });
  }

  @Post("sync/player-season-teams")
  @ApiOperation({ summary: "Enqueue player season teams sync" })
  @ApiQuery({ name: "season", required: true, description: "e.g. 2024-25" })
  @ApiOkResponse({
    description: "BullMQ job enqueued for player season teams sync.",
    type: SyncJobResponseDto
  })
  async syncPlayerSeasonTeams(@Query("season") season: string) {
    if (!season) {
      throw new BadRequestException("season is required, e.g. 2024-25");
    }
    return this.enqueueManualSync("sync-player-season-teams", { season });
  }

  @Post("sync/injury-report")
  @ApiOperation({ summary: "Enqueue injury report sync" })
  @ApiOkResponse({
    description: "BullMQ job enqueued for injury report sync.",
    type: SyncJobResponseDto
  })
  async syncInjuryReport() {
    return this.enqueueManualSync("sync-injury-report", {});
  }

  @Post("sync/range")
  @ApiOperation({ summary: "Enqueue range sync" })
  @ApiQuery({ name: "from", required: true, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "to", required: true, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "mode", required: false, description: "scoreboard|final|player|both" })
  @ApiOkResponse({
    description: "Range sync enqueued (executed asynchronously via queue).",
    type: SyncJobResponseDto
  })
  async syncRange(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("mode") mode?: string
  ) {
    if (!from || !to) {
      throw new BadRequestException("from/to are required, e.g. 2026-02-01");
    }

    const fromDate = this.parseDate(from);
    const toDate = this.parseDate(to);
    if (toDate.getTime() < fromDate.getTime()) {
      throw new BadRequestException("to must be >= from");
    }
    const maxDays = Number(process.env.NBA_SYNC_RANGE_MAX_DAYS || 0);
    const days =
      Math.floor((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)) +
      1;
    if (maxDays > 0 && days > maxDays) {
      throw new BadRequestException(`range too large, max days = ${maxDays}`);
    }

    return this.enqueueManualSync("sync-range", { from, to, mode });
  }

  @Post("subscriptions/email")
  @ApiOperation({ summary: "Subscribe email and enqueue thank-you email" })
  @ApiBody({ type: EmailSubscriptionRequestDto })
  @ApiOkResponse({
    description: "Email subscription created or already exists.",
    type: EmailSubscriptionResponseDto
  })
  async subscribeEmail(
    @Req() req: Request,
    @Body() body: EmailSubscriptionRequestDto
  ) {
    return this.nbaEmailService.subscribe(body?.email, {
      source: body?.source,
      ip: this.resolveClientIp(req),
      userAgent: this.resolveUserAgent(req)
    });
  }

  @Get("subscriptions/email/unsubscribe")
  @ApiOperation({ summary: "Unsubscribe email by token" })
  @ApiQuery({ name: "token", required: true })
  @ApiOkResponse({
    description: "Email unsubscribed using secure token.",
    type: EmailUnsubscribeResponseDto
  })
  async unsubscribeEmailByQuery(
    @Query("token") token?: string,
    @Query("source") source?: string
  ) {
    if (!token) {
      throw new BadRequestException("token is required");
    }
    return this.nbaEmailService.unsubscribeByToken({ token, source });
  }

  @Post("subscriptions/email/unsubscribe")
  @ApiOperation({
    summary: "Unsubscribe email (supports one-click List-Unsubscribe POST)"
  })
  @ApiQuery({ name: "token", required: false })
  @ApiBody({ type: EmailUnsubscribeRequestDto })
  @ApiOkResponse({
    description: "Email unsubscribed using secure token.",
    type: EmailUnsubscribeResponseDto
  })
  async unsubscribeEmail(
    @Query("token") queryToken?: string,
    @Body() body?: EmailUnsubscribeRequestDto
  ) {
    const token = queryToken || body?.token;
    if (!token) {
      throw new BadRequestException("token is required");
    }
    return this.nbaEmailService.unsubscribeByToken({
      token,
      source: body?.source
    });
  }

  @Post("subscriptions/email/ses-feedback")
  @ApiOperation({
    summary: "SES/SNS feedback webhook (bounce/complaint auto deactivation)"
  })
  @ApiOkResponse({
    description: "Webhook accepted and processed.",
    type: EmailSesFeedbackResponseDto
  })
  async receiveSesFeedback(@Req() req: Request, @Body() body: Record<string, any>) {
    const rawToken = req.headers["x-email-feedback-token"];
    const webhookToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    return this.nbaEmailService.handleSesFeedback(body, {
      webhookToken:
        typeof webhookToken === "string" ? webhookToken : undefined
    });
  }

  @Post("subscriptions/email/daily-digest")
  @ApiOperation({
    summary: "Manually enqueue daily NBA analysis digest for all subscribers"
  })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD (ET)" })
  @ApiOkResponse({
    description: "Daily digest generated/backed up and send jobs queued.",
    type: DailyDigestEnqueueResponseDto
  })
  async enqueueDailyDigest(@Query("date") date?: string) {
    return this.nbaEmailService.enqueueDailyDigestForSubscribers(date);
  }

  @Get("teams")
  @ApiOperation({ summary: "List teams" })
  @ApiOkResponse({
    description: "List NBA teams.",
    type: TeamDto,
    isArray: true
  })
  async listTeams() {
    return this.nbaService.listTeams();
  }

  @Get("teams/:id")
  @ApiOperation({ summary: "Get team" })
  @ApiParam({ name: "id", required: true })
  @ApiOkResponse({
    description: "Get a team by id.",
    type: TeamDto
  })
  async getTeam(@Param("id") id: string) {
    const team = await this.nbaService.getTeam(id);
    if (!team) {
      throw new NotFoundException("team not found");
    }
    return team;
  }

  @Get("games")
  @ApiOperation({ summary: "List games" })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "from", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "to", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "season", required: false })
  @ApiQuery({ name: "teamId", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List games with pagination.",
    type: PaginatedGameDto
  })
  async listGames(
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
    @Query("season") season?: string,
    @Query("teamId") teamId?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    if ((from && !to) || (!from && to)) {
      throw new BadRequestException("from/to must be used together");
    }
    if (date && (from || to)) {
      throw new BadRequestException("date and from/to are mutually exclusive");
    }
    if (from && to) {
      const fromDate = this.parseDate(from);
      const toDate = this.parseDate(to);
      if (toDate.getTime() < fromDate.getTime()) {
        throw new BadRequestException("to must be >= from");
      }
    }

    return this.nbaService.listGames({
      date,
      from,
      to,
      status,
      season: season ? Number(season) : undefined,
      teamId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("games/context")
  @ApiOperation({
    summary: "Get game context by date + team abbreviations"
  })
  @ApiQuery({ name: "date", required: true, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "home", required: true, description: "Home team abbrev" })
  @ApiQuery({ name: "away", required: true, description: "Away team abbrev" })
  @ApiQuery({ name: "matchupLimit", required: false })
  @ApiQuery({ name: "recentLimit", required: false })
  @ApiQuery({ name: "marketPage", required: false })
  @ApiQuery({ name: "marketPageSize", required: false })
  @ApiOkResponse({
    description: "Aggregated context for a single matchup.",
    type: GameContextResponseDto
  })
  async getGameContextByMatchup(
    @Query("date") date?: string,
    @Query("home") home?: string,
    @Query("away") away?: string,
    @Query("matchupLimit") matchupLimit?: string,
    @Query("recentLimit") recentLimit?: string,
    @Query("marketPage") marketPage?: string,
    @Query("marketPageSize") marketPageSize?: string
  ) {
    if (!date) {
      throw new BadRequestException("date is required, YYYY-MM-DD");
    }
    if (!home || !away) {
      throw new BadRequestException("home and away are required");
    }
    this.parseDate(date);

    const context = await this.nbaService.getGameContextByMatchup({
      date,
      home,
      away,
      matchupLimit: matchupLimit ? Number(matchupLimit) : undefined,
      recentLimit: recentLimit ? Number(recentLimit) : undefined,
      marketPage: marketPage ? Number(marketPage) : undefined,
      marketPageSize: marketPageSize ? Number(marketPageSize) : undefined
    });
    if (!context) {
      throw new NotFoundException("game not found");
    }
    return this.stripContextFields(context);
  }

  @Get("games/:id")
  @ApiOperation({ summary: "Get game" })
  @ApiParam({ name: "id", required: true })
  @ApiOkResponse({
    description: "Get a game by id.",
    type: GameDto
  })
  async getGame(@Param("id") id: string) {
    const game = await this.nbaService.getGame(id);
    if (!game) {
      throw new NotFoundException("game not found");
    }
    return game;
  }

  @Get("games/:id/markets")
  @ApiOperation({ summary: "List Polymarket markets for game" })
  @ApiParam({ name: "id", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "Polymarket event and markets for the given game.",
    type: GameMarketsResponseDto
  })
  async listGameMarkets(
    @Param("id") id: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listPolymarketMarketsForGame(id, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Post("analysis")
  @ApiOperation({ summary: "AI analysis for a matchup (x402 paid)" })
  @ApiBody({ type: GameAnalysisRequestDto })
  @ApiOkResponse({
    description: "AI analysis result with win probabilities.",
    type: GameAnalysisResponseDto
  })
  async analyzeGame(@Req() req: Request, @Body() body: GameAnalysisRequestDto) {
    this.validateAnalysisBody(body);

    const x402 = (req as any).x402 as
      | {
          sessionId?: string;
          payerAddress?: string | null;
          txHash?: string | null;
          chainId?: number | null;
        }
      | undefined;
    const chainId = this.resolveChainIdFromRequest(req, x402?.chainId ?? null);
    const requestParams = {
      date: body.date,
      home: body.home,
      away: body.away,
      matchupLimit:
        body.matchupLimit !== undefined ? Number(body.matchupLimit) : undefined,
      recentLimit:
        body.recentLimit !== undefined ? Number(body.recentLimit) : undefined
    };

    let recorded = false;
    let analysisLogId: string | null = null;
    const response = req.res;
    let txHashBackfillRegistered = false;
    const registerTxHashBackfill = () => {
      if (!response || txHashBackfillRegistered) {
        return;
      }
      txHashBackfillRegistered = true;
      response.on("finish", () => {
        if (!analysisLogId) {
          return;
        }
        const txHash = this.extractTxHashFromResponse(response);
        if (!txHash) {
          return;
        }
        void this.nbaService.updateAnalysisLogTxHash(analysisLogId, txHash);
      });
    };

    const recordOnce = async (payload: {
      payerAddress?: string | null;
      sessionId?: string | null;
      txHash?: string | null;
      chainId?: number | null;
      requestParams: Record<string, any>;
      response?: Record<string, any> | null;
      error?: string | null;
    }) => {
      if (recorded) {
        return;
      }
      recorded = true;
      analysisLogId = await this.nbaService.recordAnalysisLog(payload);
      registerTxHashBackfill();
    };

    try {
      const result = await this.runAnalysis(body);

      if (!result) {
        await recordOnce({
          payerAddress: x402?.payerAddress ?? null,
          sessionId: x402?.sessionId ?? null,
          txHash: x402?.txHash ?? null,
          chainId,
          requestParams,
          response: null,
          error: "game_not_found"
        });
        throw new NotFoundException("game not found");
      }

      await recordOnce({
        payerAddress: x402?.payerAddress ?? null,
        sessionId: x402?.sessionId ?? null,
        txHash: x402?.txHash ?? null,
        chainId,
        requestParams,
        response: result as any,
        error: null
      });

      return result;
    } catch (err: any) {
      // Best-effort: still record error, but don't change the thrown exception.
      await recordOnce({
        payerAddress: x402?.payerAddress ?? null,
        sessionId: x402?.sessionId ?? null,
        txHash: x402?.txHash ?? null,
        chainId,
        requestParams,
        response: null,
        error:
          err?.message || (typeof err === "string" ? err : "analysis_failed")
      });
      throw err;
    }
  }

  @Post("analysis/free")
  @ApiOperation({ summary: "AI analysis for a matchup (no x402)" })
  @ApiBody({ type: GameAnalysisRequestDto })
  @ApiOkResponse({
    description: "AI analysis result with win probabilities.",
    type: GameAnalysisResponseDto
  })
  async analyzeGameFree(@Body() body: GameAnalysisRequestDto) {
    const result = await this.runAnalysis(body);
    if (!result) {
      throw new NotFoundException("game not found");
    }
    return result;
  }

  @Get("analysis-log")
  @ApiOperation({
    summary: "List AI analysis purchase logs (filter by payer wallet/session)"
  })
  @ApiQuery({ name: "payerAddress", required: false })
  @ApiQuery({ name: "sessionId", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List AI analysis logs with pagination.",
    type: PaginatedNbaAnalysisLogDto
  })
  async listAnalysisLogs(
    @Query("payerAddress") payerAddress?: string,
    @Query("sessionId") sessionId?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    const normalizedPayerAddress = payerAddress?.trim();
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedPayerAddress && !normalizedSessionId) {
      throw new BadRequestException("payerAddress or sessionId is required");
    }

    return this.nbaService.listAnalysisLogs({
      payerAddress: normalizedPayerAddress,
      sessionId: normalizedSessionId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("players")
  @ApiOperation({ summary: "List players" })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "isActive", required: false, description: "true|false" })
  @ApiQuery({ name: "teamId", required: false })
  @ApiQuery({ name: "season", required: false })
  @ApiQuery({ name: "currentOnly", required: false, description: "true|false" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List players with pagination.",
    type: PaginatedPlayerDto
  })
  async listPlayers(
    @Query("search") search?: string,
    @Query("isActive") isActive?: string,
    @Query("teamId") teamId?: string,
    @Query("season") season?: string,
    @Query("currentOnly") currentOnly?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listPlayers({
      search,
      isActive: this.parseBoolean(isActive),
      teamId,
      season: season ? Number(season) : undefined,
      currentOnly: this.parseBoolean(currentOnly) ?? false,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("players/:id")
  @ApiOperation({ summary: "Get player" })
  @ApiParam({ name: "id", required: true })
  @ApiOkResponse({
    description: "Get a player by id.",
    type: PlayerDto
  })
  async getPlayer(@Param("id") id: string) {
    const player = await this.nbaService.getPlayer(id);
    if (!player) {
      throw new NotFoundException("player not found");
    }
    return player;
  }

  @Get("team-stats")
  @ApiOperation({ summary: "List team stats" })
  @ApiQuery({ name: "gameId", required: false })
  @ApiQuery({ name: "teamId", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List team game stats with pagination.",
    type: PaginatedTeamGameStatDto
  })
  async listTeamStats(
    @Query("gameId") gameId?: string,
    @Query("teamId") teamId?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listTeamStats({
      gameId,
      teamId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("team-game-stat")
  @ApiOperation({ summary: "List team game stats" })
  @ApiQuery({ name: "gameId", required: false })
  @ApiQuery({ name: "teamId", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List team game stats with pagination (alias of team-stats).",
    type: PaginatedTeamGameStatDto
  })
  async listTeamGameStat(
    @Query("gameId") gameId?: string,
    @Query("teamId") teamId?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listTeamStats({
      gameId,
      teamId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("player-stats")
  @ApiOperation({ summary: "List player stats" })
  @ApiQuery({ name: "gameId", required: false })
  @ApiQuery({ name: "playerId", required: false })
  @ApiQuery({ name: "teamId", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List player stats with pagination.",
    type: PaginatedPlayerGameStatDto
  })
  async listPlayerStats(
    @Query("gameId") gameId?: string,
    @Query("playerId") playerId?: string,
    @Query("teamId") teamId?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listPlayerStats({
      gameId,
      playerId,
      teamId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("player-game-stat")
  @ApiOperation({ summary: "List player game stats" })
  @ApiQuery({ name: "gameId", required: false })
  @ApiQuery({ name: "playerId", required: false })
  @ApiQuery({ name: "teamId", required: false })
  @ApiQuery({ name: "autoSync", required: false, description: "true|false" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List player game stats with pagination (supports autoSync).",
    type: PaginatedPlayerGameStatDto
  })
  async listPlayerGameStat(
    @Query("gameId") gameId?: string,
    @Query("playerId") playerId?: string,
    @Query("teamId") teamId?: string,
    @Query("autoSync") autoSync?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listPlayerStats({
      gameId,
      playerId,
      teamId,
      autoSync: this.parseBoolean(autoSync) ?? false,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("conflicts")
  @ApiOperation({ summary: "List data conflicts" })
  @ApiQuery({ name: "conflictType", required: false })
  @ApiQuery({ name: "playerId", required: false })
  @ApiQuery({ name: "season", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List data conflicts with pagination.",
    type: PaginatedDataConflictDto
  })
  async listConflicts(
    @Query("conflictType") conflictType?: string,
    @Query("playerId") playerId?: string,
    @Query("season") season?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listConflicts({
      conflictType,
      playerId,
      season: season ? Number(season) : undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("injury-reports/latest")
  @ApiOperation({ summary: "Get latest injury report entries" })
  @ApiQuery({ name: "reportId", required: false })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "from", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "to", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "team", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "Latest injury report with paginated entries.",
    type: InjuryReportEntriesResponseDto
  })
  async listLatestInjuryReport(
    @Query("reportId") reportId?: string,
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("team") team?: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listInjuryReportEntries({
      reportId,
      date,
      from,
      to,
      team,
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("injury-reports")
  @ApiOperation({ summary: "List injury reports" })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "from", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "to", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "List injury reports with pagination.",
    type: PaginatedInjuryReportDto
  })
  async listInjuryReports(
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listInjuryReports({
      date,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  @Get("injury-reports/entries")
  @ApiOperation({ summary: "List injury report entries" })
  @ApiQuery({ name: "reportId", required: false })
  @ApiQuery({ name: "date", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "from", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "to", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({ name: "team", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOkResponse({
    description: "Injury report entries with the resolved report metadata.",
    type: InjuryReportEntriesResponseDto
  })
  async listInjuryReportEntries(
    @Query("reportId") reportId?: string,
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("team") team?: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.nbaService.listInjuryReportEntries({
      reportId,
      date,
      from,
      to,
      team,
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined
    });
  }

  private parseBoolean(value?: string) {
    if (value === undefined) {
      return undefined;
    }
    if (value === "true" || value === "1") {
      return true;
    }
    if (value === "false" || value === "0") {
      return false;
    }
    return undefined;
  }

  private resolveClientIp(req: Request) {
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof forwardedValue === "string" && forwardedValue.trim()) {
      const first = forwardedValue.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }
    if (typeof req.ip === "string" && req.ip.trim()) {
      return req.ip.trim();
    }
    return null;
  }

  private resolveUserAgent(req: Request) {
    const raw = req.headers["user-agent"];
    const ua = Array.isArray(raw) ? raw[0] : raw;
    if (typeof ua === "string" && ua.trim()) {
      return ua.trim();
    }
    return null;
  }

  private resolveChainIdFromRequest(
    req: Request,
    fallback?: number | null
  ): number | null {
    const rawHeader = req.headers["x-chain-id"];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof headerValue === "string" && headerValue.trim()) {
      const parsed = Number(headerValue.trim());
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
    if (
      typeof fallback === "number" &&
      Number.isInteger(fallback) &&
      fallback > 0
    ) {
      return fallback;
    }
    return null;
  }

  private extractTxHashFromResponse(response: Request["res"]) {
    if (!response) {
      return null;
    }
    const rawHeader =
      response.getHeader("PAYMENT-RESPONSE") ??
      response.getHeader("X-PAYMENT-RESPONSE");
    const paymentResponseHeader = Array.isArray(rawHeader)
      ? rawHeader.find((entry) => typeof entry === "string")
      : rawHeader;
    if (typeof paymentResponseHeader !== "string") {
      return null;
    }
    try {
      const decoded = decodePaymentResponseHeader(paymentResponseHeader) as
        | { transaction?: string | null }
        | null;
      return typeof decoded?.transaction === "string" &&
        decoded.transaction.trim()
        ? decoded.transaction.trim()
        : null;
    } catch {
      return null;
    }
  }

  private async enqueueManualSync(name: string, data: Record<string, any>) {
    const redis = await this.queue.client;
    const cooldownKey = `manual-sync:cooldown:${name}`;
    const jobKey = `manual-sync:job:${name}`;

    // Only allow one manual enqueue per endpoint within the cooldown window.
    const claimed = await redis.set(
      cooldownKey,
      String(Date.now()),
      "PX",
      NbaController.MANUAL_SYNC_COOLDOWN_MS,
      "NX"
    );

    if (claimed) {
      const job = await this.queue.add(name, data);
      await redis.set(
        jobKey,
        String(job.id),
        "PX",
        NbaController.MANUAL_SYNC_COOLDOWN_MS
      );
      return job;
    }

    // Cooldown active: return the existing job (if known) so callers can wait on it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingJobId = await redis.get(jobKey);
      if (existingJobId) {
        const existing = await this.queue.getJob(existingJobId);
        if (existing) {
          return existing;
        }
      }
      // Small wait to allow the enqueuer to persist the job id (race window).
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Fallback: no job id cached (race), return a useful error.
    const retryAfterMs = await redis.pttl(cooldownKey);
    throw new HttpException(
      `manual sync cooldown active; retry after ${Math.max(0, retryAfterMs)}ms`,
      HttpStatus.TOO_MANY_REQUESTS
    );
  }

  private parseDate(value: string) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException("date must be YYYY-MM-DD");
    }
    return parsed;
  }

  private validateAnalysisBody(body: GameAnalysisRequestDto) {
    if (!body?.date) {
      throw new BadRequestException("date is required, YYYY-MM-DD");
    }
    if (!body?.home || !body?.away) {
      throw new BadRequestException("home and away are required");
    }
    this.parseDate(body.date);
  }

  private runAnalysis(body: GameAnalysisRequestDto) {
    this.validateAnalysisBody(body);
    return this.nbaService.analyzeGameByMatchup(
      {
        date: body.date,
        home: body.home,
        away: body.away
      },
      {
        matchupLimit:
          body.matchupLimit !== undefined ? Number(body.matchupLimit) : undefined,
        recentLimit:
          body.recentLimit !== undefined ? Number(body.recentLimit) : undefined
      }
    );
  }

  private stripContextFields<T>(value: T): T {
    const shouldOmit = (key: string) => {
      const normalized = key.toLowerCase();
      if (normalized === "id") {
        return true;
      }
      if (normalized.endsWith("id") || normalized.endsWith("_id")) {
        return true;
      }
      if (
        normalized === "createdat" ||
        normalized === "updatedat" ||
        normalized === "created_at" ||
        normalized === "updated_at"
      ) {
        return true;
      }
      return false;
    };

    const visit = (input: any): any => {
      if (input === null || input === undefined) {
        return input;
      }
      if (input instanceof Date) {
        return input;
      }
      if (Array.isArray(input)) {
        return input.map(visit);
      }
      if (typeof input === "object") {
        const result: Record<string, any> = {};
        for (const [key, val] of Object.entries(input)) {
          if (shouldOmit(key)) {
            continue;
          }
          result[key] = visit(val);
        }
        return result;
      }
      return input;
    };

    return visit(value);
  }
}
