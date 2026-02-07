import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { GammaClient } from "./gamma.client";
import { ClobClient } from "./clob.client";
import { Event } from "./entities/event.entity";
import { Market } from "./entities/market.entity";
import { Tag } from "./entities/tag.entity";
import { EventTag } from "./entities/event-tag.entity";
import { IngestionState } from "./entities/ingestion-state.entity";

@Injectable()
export class PolymarketService {
  private readonly logger = new Logger(PolymarketService.name);
  private running = false;

  constructor(
    private readonly gammaClient: GammaClient,
    private readonly clobClient: ClobClient,
    private readonly configService: ConfigService,
    @InjectRepository(Event)
    private readonly eventRepo: Repository<Event>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    @InjectRepository(Tag)
    private readonly tagRepo: Repository<Tag>,
    @InjectRepository(EventTag)
    private readonly eventTagRepo: Repository<EventTag>,
    @InjectRepository(IngestionState)
    private readonly ingestionStateRepo: Repository<IngestionState>
  ) {}

  async syncNbaEventsAndMarkets() {
    if (this.running) {
      this.logger.warn("sync already running, skipping");
      return;
    }

    this.running = true;
    const startedAt = new Date();
    try {
      const seriesId = await this.resolveNbaSeriesId();
      const events = await this.fetchEvents(seriesId);

      if (events.length === 0) {
        this.logger.warn("no events returned from gamma api");
        await this.upsertState(startedAt, 0, 0);
        return;
      }

      const tagsPayload: Tag[] = [];
      const eventsPayload: Array<Partial<Event>> = [];
      const marketsPayload: Array<Partial<Market> & { eventPolymarketId?: number }> =
        [];
      const eventTagLinks: Array<{ eventPolymarketId: number; tagId: number }> =
        [];

      const activeEvents = this.filterActiveFutureEvents(events);
      const upcomingEvents = this.filterUpcomingEvents(events);
      const eventsToSync = this.mergeEvents(activeEvents, upcomingEvents);
      if (eventsToSync.length === 0) {
        this.logger.warn("no active or upcoming events found after filtering");
        await this.upsertState(startedAt, 0, 0);
        return;
      }

      const activeEventIds = new Set<number>();
      for (const event of activeEvents) {
        const polymarketEventId = this.parseInt(
          event.id ?? event.eventId ?? event.polymarketEventId
        );
        if (polymarketEventId) {
          activeEventIds.add(polymarketEventId);
        }
      }
      const upcomingEventIds = new Set<number>();
      for (const event of upcomingEvents) {
        const polymarketEventId = this.parseInt(
          event.id ?? event.eventId ?? event.polymarketEventId
        );
        if (polymarketEventId) {
          upcomingEventIds.add(polymarketEventId);
        }
      }

      for (const event of eventsToSync) {
        const polymarketEventId = this.parseInt(
          event.id ?? event.eventId ?? event.polymarketEventId
        );
        if (!polymarketEventId) {
          continue;
        }
        const isActiveEvent = activeEventIds.has(polymarketEventId);
        const isUpcomingEvent = upcomingEventIds.has(polymarketEventId);

        eventsPayload.push({
          polymarketEventId,
          slug: this.pickString(event, ["slug", "ticker"]),
          title: this.pickString(event, ["title", "ticker"]),
          description: this.pickString(event, ["description"]),
          startDate: this.parseDate(
            event.startDate ?? event.eventDate ?? event.startTime
          ),
          endDate: this.parseDate(event.endDate),
          active: this.parseBoolean(event.active),
          closed: this.parseBoolean(event.closed),
          archived: this.parseBoolean(event.archived),
          featured: this.parseBoolean(event.featured ?? event.new),
          restricted: this.parseBoolean(event.restricted),
          liquidity: this.parseNumber(event.liquidityClob ?? event.liquidity),
          volume: this.parseNumber(event.volumeClob ?? event.volume),
          raw: event,
          updatedAt: new Date()
        });

        const tags = this.normalizeTags(event.tags);
        for (const tag of tags) {
          if (!tag.id) {
            continue;
          }
          tagsPayload.push(tag);
          eventTagLinks.push({
            eventPolymarketId: polymarketEventId,
            tagId: tag.id
          });
        }

        const markets = Array.isArray(event.markets) ? event.markets : [];
        for (const market of markets) {
          if (isActiveEvent) {
            if (!this.isActiveFutureMarket(market)) {
              continue;
            }
          } else if (isUpcomingEvent) {
            if (!this.isUpcomingMarket(market)) {
              continue;
            }
          }
          const polymarketMarketId = this.parseInt(
            market.id ?? market.marketId ?? market.polymarketMarketId
          );
          if (!polymarketMarketId) {
            continue;
          }

          marketsPayload.push({
            polymarketMarketId,
            slug: this.pickString(market, ["slug"]),
            question: this.pickString(market, ["question", "questionTitle"]),
            title: this.pickString(market, ["title", "groupItemTitle"]) ||
              this.pickString(market, ["question"]),
            category: this.pickString(market, ["category"]),
            conditionId: this.pickString(market, [
              "conditionId",
              "condition_id"
            ]),
            marketType: this.pickString(market, [
              "marketType",
              "market_type",
              "sportsMarketType"
            ]),
            formatType: this.pickString(market, ["formatType", "format_type"]),
            active: this.parseBoolean(market.active),
            closed: this.parseBoolean(market.closed),
            status: this.pickString(market, ["status", "umaResolutionStatus"]),
            endDate: this.parseDate(market.endDate),
            resolveTime: this.parseDate(market.resolveTime),
            liquidity: this.parseNumber(
              market.liquidityNum ?? market.liquidityClob ?? market.liquidity
            ),
            volume: this.parseNumber(
              market.volumeNum ?? market.volumeClob ?? market.volume
            ),
            volume24hr: this.parseNumber(
              market.volume24hr ?? market.volume24Hour
            ),
            outcomePrices: this.parseJsonArray(market.outcomePrices),
            outcomes: this.parseJsonArray(market.outcomes),
            clobTokenIds: this.parseTextArray(market.clobTokenIds),
            raw: market,
            updatedAt: new Date(),
            eventPolymarketId: polymarketEventId
          });
        }
      }

      const uniqueTags = Array.from(
        new Map(tagsPayload.map((tag) => [tag.id, tag])).values()
      );
      const uniqueEvents = Array.from(
        new Map(
          eventsPayload
            .filter((event) => event.polymarketEventId)
            .map((event) => [event.polymarketEventId!, event])
        ).values()
      );
      const uniqueMarkets = Array.from(
        new Map(
          marketsPayload
            .filter((market) => market.polymarketMarketId)
            .map((market) => [market.polymarketMarketId!, market])
        ).values()
      );
      const uniqueEventTagLinks = Array.from(
        new Map(
          eventTagLinks.map((link) => [
            `${link.eventPolymarketId}:${link.tagId}`,
            link
          ])
        ).values()
      );

      if (uniqueTags.length > 0) {
        await this.tagRepo.upsert(uniqueTags, ["id"]);
      }

      if (uniqueEvents.length > 0) {
        await this.eventRepo.upsert(uniqueEvents, ["polymarketEventId"]);
      }

      const eventIds = uniqueEvents
        .map((event) => event.polymarketEventId)
        .filter((value): value is number => Boolean(value));

      const storedEvents = eventIds.length
        ? await this.eventRepo.find({
            where: {
              polymarketEventId: In(eventIds)
            }
          })
        : [];

      const eventIdByPolymarket = new Map(
        storedEvents.map((event) => [event.polymarketEventId, event.id])
      );

      const eventTagPayload = uniqueEventTagLinks
        .map((link) => ({
          eventId: eventIdByPolymarket.get(link.eventPolymarketId) ?? null,
          tagId: link.tagId
        }))
        .filter(
          (row): row is { eventId: string; tagId: number } =>
            Boolean(row.eventId)
        );

      if (eventTagPayload.length > 0) {
        await this.eventTagRepo
          .createQueryBuilder()
          .insert()
          .values(eventTagPayload)
          .orIgnore()
          .execute();
      }

      const marketsWithEventId = uniqueMarkets
        .map(({ eventPolymarketId, ...market }) => ({
          ...market,
          eventId: eventPolymarketId
            ? eventIdByPolymarket.get(eventPolymarketId) ?? null
            : null
        }))
        .filter((market) => Boolean(market.eventId));

      if (marketsWithEventId.length > 0) {
        await this.marketRepo.upsert(marketsWithEventId, [
          "polymarketMarketId"
        ]);
      }

      await this.upsertState(
        startedAt,
        uniqueEvents.length,
        marketsWithEventId.length
      );

      this.logger.log(
        `synced events=${uniqueEvents.length}, markets=${marketsWithEventId.length}`
      );
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.running = false;
    }
  }

  async listEvents(filters: {
    date?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginationResult<Event>> {
    const page = this.clampPage(filters.page);
    const pageSize = this.clampPageSize(filters.pageSize);
    const qb = this.eventRepo.createQueryBuilder("event");

    if (filters.search) {
      qb.andWhere(
        "(event.title ILIKE :search OR event.slug ILIKE :search)",
        { search: `%${filters.search}%` }
      );
    }

    if (filters.date) {
      const { start, end } = this.dateRange(filters.date);
      qb.andWhere("event.startDate BETWEEN :start AND :end", { start, end });
    }

    qb.orderBy("event.startDate", "DESC");
    qb.addOrderBy("event.polymarketEventId", "DESC");

    return this.paginate(qb, page, pageSize);
  }

  async listMarkets(filters: {
    date?: string;
    search?: string;
    eventId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginationResult<Market>> {
    const page = this.clampPage(filters.page);
    const pageSize = this.clampPageSize(filters.pageSize);
    const qb = this.marketRepo
      .createQueryBuilder("market")
      .leftJoin("market.event", "event");

    if (filters.eventId) {
      qb.andWhere("market.event_id = :eventId", { eventId: filters.eventId });
    }

    if (filters.search) {
      qb.andWhere(
        "(market.question ILIKE :search OR market.title ILIKE :search OR market.slug ILIKE :search OR event.title ILIKE :search)",
        { search: `%${filters.search}%` }
      );
    }

    if (filters.date) {
      const { start, end } = this.dateRange(filters.date);
      qb.andWhere(
        "(event.startDate BETWEEN :start AND :end OR market.endDate BETWEEN :start AND :end)",
        { start, end }
      );
    }

    qb.orderBy("market.updatedAt", "DESC");

    return this.paginate(qb, page, pageSize);
  }

  async getLivePrices(params: {
    tokenId?: string;
    marketId?: number;
    marketIds?: number[];
    side?: string;
  }) {
    const side = this.normalizeSide(params.side);
    if (params.tokenId) {
      const price = await this.clobClient.getPrice(params.tokenId, side);
      return { tokenId: params.tokenId, side, price };
    }

    const marketIds = this.normalizeMarketIds(
      params.marketId,
      params.marketIds
    );
    if (marketIds.length === 0) {
      throw new BadRequestException("tokenId or marketId is required");
    }

    const markets = await this.marketRepo.find({
      where: { polymarketMarketId: In(marketIds) }
    });
    if (markets.length === 0) {
      throw new NotFoundException("market not found");
    }

    const response = await Promise.all(
      markets.map(async (market) => {
        const tokens = this.buildTokenMeta(market);
        const prices = await Promise.all(
          tokens.map(async (token) => ({
            ...token,
            side,
            price: await this.clobClient.getPrice(token.tokenId, side)
          }))
        );
        return {
          marketId: market.polymarketMarketId,
          prices
        };
      })
    );

    return { side, markets: response };
  }

  async getOrderbooks(params: {
    tokenId?: string;
    marketId?: number;
    marketIds?: number[];
  }) {
    if (params.tokenId) {
      const orderbook = await this.clobClient.getOrderbook(params.tokenId);
      return { tokenId: params.tokenId, orderbook };
    }

    const marketIds = this.normalizeMarketIds(
      params.marketId,
      params.marketIds
    );
    if (marketIds.length === 0) {
      throw new BadRequestException("tokenId or marketId is required");
    }

    const markets = await this.marketRepo.find({
      where: { polymarketMarketId: In(marketIds) }
    });
    if (markets.length === 0) {
      throw new NotFoundException("market not found");
    }

    const response = await Promise.all(
      markets.map(async (market) => {
        const tokens = this.buildTokenMeta(market);
        const orderbooks = await Promise.all(
          tokens.map(async (token) => ({
            ...token,
            orderbook: await this.clobClient.getOrderbook(token.tokenId)
          }))
        );
        return {
          marketId: market.polymarketMarketId,
          orderbooks
        };
      })
    );

    return { markets: response };
  }

  private async fetchEvents(seriesId: number) {
    const active = this.parseBoolean(
      this.configService.get<string>("POLYMARKET_NBA_ACTIVE")
    );
    const closed = this.parseBoolean(
      this.configService.get<string>("POLYMARKET_NBA_CLOSED")
    );
    const tagId = this.configService.get<string>("POLYMARKET_NBA_TAG_ID");
    const limit = Number(
      this.configService.get<string>("POLYMARKET_NBA_PAGE_SIZE") || 50
    );
    const maxPages = Number(
      this.configService.get<string>("POLYMARKET_NBA_MAX_PAGES") || 5
    );

    const events: any[] = [];
    let offset = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.gammaClient.listEvents({
        series_id: seriesId,
        active: active ?? undefined,
        closed: closed ?? undefined,
        tag_id: tagId,
        limit,
        offset,
        order: "id",
        ascending: false
      });

      const batch = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.events)
          ? payload.events
          : [];

      if (batch.length === 0) {
        break;
      }

      events.push(...batch);

      if (batch.length < limit) {
        break;
      }

      offset += limit;
    }

    return events;
  }

  private normalizeSide(value?: string) {
    const side = (value || "buy").toLowerCase();
    if (side !== "buy" && side !== "sell") {
      throw new BadRequestException("side must be buy or sell");
    }
    return side;
  }

  private filterRecentEvents(events: any[]) {
    const lookbackDaysRaw = this.configService.get<string>(
      "POLYMARKET_NBA_LOOKBACK_DAYS"
    );
    const lookbackDays = Number(lookbackDaysRaw || 7);
    const lookaheadDaysRaw = this.configService.get<string>(
      "POLYMARKET_NBA_LOOKAHEAD_DAYS"
    );
    const lookaheadDays = Number(lookaheadDaysRaw || 0);
    if (
      (!Number.isFinite(lookbackDays) || lookbackDays < 0) &&
      (!Number.isFinite(lookaheadDays) || lookaheadDays < 0)
    ) {
      return events;
    }

    const now = new Date();
    const windowStart = new Date(now);
    const windowEnd = new Date(now);
    if (Number.isFinite(lookbackDays) && lookbackDays > 0) {
      windowStart.setUTCDate(windowStart.getUTCDate() - lookbackDays);
    }
    if (Number.isFinite(lookaheadDays) && lookaheadDays > 0) {
      windowEnd.setUTCDate(windowEnd.getUTCDate() + lookaheadDays);
    }

    return events.filter((event) => {
      const start = this.parseDate(
        event.startDate ?? event.eventDate ?? event.startTime
      );
      const end = this.parseDate(event.endDate ?? event.resolveTime);

      const isInWindow = (value: Date | null) =>
        value ? value >= windowStart && value <= windowEnd : false;

      if (isInWindow(start)) {
        return true;
      }
      if (isInWindow(end)) {
        return true;
      }
      return false;
    });
  }

  private filterActiveFutureEvents(events: any[]) {
    const now = new Date();
    return events.filter((event) => {
      const isActive = this.parseBoolean(event.active);
      if (isActive !== true) {
        return false;
      }
      const end = this.parseDate(event.endDate ?? event.resolveTime);
      if (!end) {
        return false;
      }
      return end.getTime() > now.getTime();
    });
  }

  private filterUpcomingEvents(events: any[]) {
    const raw = this.configService.get<string>(
      "POLYMARKET_NBA_UPCOMING_DAYS"
    );
    const upcomingDays = Number(raw || 7);
    if (!Number.isFinite(upcomingDays) || upcomingDays <= 0) {
      return [];
    }

    const now = new Date();
    const windowStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      )
    );
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + upcomingDays);
    windowEnd.setUTCHours(23, 59, 59, 999);

    return events.filter((event) => {
      const start = this.parseDate(
        event.startDate ?? event.eventDate ?? event.startTime
      );
      if (!start) {
        return false;
      }
      return start >= windowStart && start <= windowEnd;
    });
  }

  private isActiveFutureMarket(market: any) {
    const isActive = this.parseBoolean(market.active);
    if (isActive !== true) {
      return false;
    }
    const end = this.parseDate(market.endDate ?? market.resolveTime);
    if (!end) {
      return false;
    }
    return end.getTime() > Date.now();
  }

  private isUpcomingMarket(market: any) {
    const end = this.parseDate(market.endDate ?? market.resolveTime);
    if (!end) {
      return true;
    }
    return end.getTime() > Date.now();
  }

  private mergeEvents(primary: any[], secondary: any[]) {
    const merged = new Map<number, any>();
    const addEvent = (event: any) => {
      const polymarketEventId = this.parseInt(
        event?.id ?? event?.eventId ?? event?.polymarketEventId
      );
      if (!polymarketEventId) {
        return;
      }
      if (!merged.has(polymarketEventId)) {
        merged.set(polymarketEventId, event);
      }
    };

    primary.forEach(addEvent);
    secondary.forEach(addEvent);
    return Array.from(merged.values());
  }

  private normalizeMarketIds(
    marketId?: number,
    marketIds?: number[]
  ): number[] {
    const ids = new Set<number>();
    if (marketId) {
      ids.add(marketId);
    }
    if (marketIds) {
      for (const id of marketIds) {
        if (id) {
          ids.add(id);
        }
      }
    }
    return Array.from(ids);
  }

  private buildTokenMeta(market: Market) {
    const tokens = market.clobTokenIds ?? [];
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    return tokens.map((tokenId, index) => ({
      tokenId,
      outcome: this.pickOutcomeName(outcomes[index])
    }));
  }

  private pickOutcomeName(value: any): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "object") {
      return (
        this.pickString(value, ["name", "title", "label", "outcome"]) ??
        null
      );
    }
    return String(value);
  }

  private async resolveNbaSeriesId(): Promise<number> {
    const sports = await this.gammaClient.listSports();
    const nba = Array.isArray(sports)
      ? sports.find((sport) => String(sport.sport).toLowerCase() === "nba")
      : null;
    const seriesId = this.parseInt(
      nba?.series ?? nba?.seriesId ?? nba?.series_id
    );

    if (!seriesId) {
      throw new Error("unable to resolve NBA series id");
    }

    return seriesId;
  }

  private normalizeTags(tags: any): Tag[] {
    if (!tags) {
      return [];
    }

    const tagList = Array.isArray(tags)
      ? tags
      : typeof tags === "string"
        ? tags.split(",")
        : [];

    const normalized: Tag[] = [];

    for (const tag of tagList) {
      if (typeof tag === "string") {
        const id = this.parseInt(tag);
        if (!id) {
          continue;
        }
        normalized.push({ id, label: null, slug: null, forceShow: null, forceHide: null, isCarousel: null, publishedAt: null, createdAt: null, updatedAt: null });
        continue;
      }

      const id = this.parseInt(tag.id ?? tag.tag_id);
      if (!id) {
        continue;
      }

      normalized.push({
        id,
        label: this.pickString(tag, ["label"]),
        slug: this.pickString(tag, ["slug"]),
        forceShow: this.parseBoolean(tag.forceShow ?? tag.force_show),
        forceHide: this.parseBoolean(tag.forceHide ?? tag.force_hide),
        isCarousel: this.parseBoolean(tag.isCarousel ?? tag.is_carousel),
        publishedAt: this.parseDate(tag.publishedAt),
        createdAt: this.parseDate(tag.createdAt),
        updatedAt: this.parseDate(tag.updatedAt)
      });
    }

    return normalized;
  }

  private async upsertState(
    startedAt: Date,
    eventsCount: number,
    marketsCount: number
  ) {
    const payload: Partial<IngestionState> = {
      key: "polymarket_nba_last_sync",
      value: {
        syncedAt: startedAt.toISOString(),
        events: eventsCount,
        markets: marketsCount
      } as Record<string, any>,
      updatedAt: new Date()
    };

    await this.ingestionStateRepo.upsert(payload, ["key"]);
  }

  private clampPage(value?: number) {
    if (!value || value < 1) {
      return 1;
    }
    return Math.floor(value);
  }

  private clampPageSize(value?: number) {
    const size = value && value > 0 ? Math.floor(value) : 50;
    return Math.min(size, 200);
  }

  private async paginate<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    page: number,
    pageSize: number
  ): Promise<PaginationResult<T>> {
    const [data, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      data,
      page,
      pageSize,
      total
    };
  }

  private parseBoolean(value?: any): boolean | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value === "true" || value === "1") {
      return true;
    }
    if (value === "false" || value === "0") {
      return false;
    }
    return null;
  }

  private parseDate(value?: any): Date | null {
    if (!value) {
      return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private dateRange(date: string): { start: Date; end: Date } {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("date must be YYYY-MM-DD");
    }

    const start = new Date(
      Date.UTC(
        parsed.getUTCFullYear(),
        parsed.getUTCMonth(),
        parsed.getUTCDate(),
        0,
        0,
        0
      )
    );
    const end = new Date(
      Date.UTC(
        parsed.getUTCFullYear(),
        parsed.getUTCMonth(),
        parsed.getUTCDate(),
        23,
        59,
        59,
        999
      )
    );

    return { start, end };
  }

  private parseNumber(value?: any): number | null {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseInt(value?: any): number | null {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const parsed = Number.parseInt(String(value), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseJsonArray(value?: any): any[] | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return null;
      }
    }
    return null;
  }

  private parseTextArray(value?: any): string[] | null {
    const parsed = this.parseJsonArray(value);
    if (!parsed) {
      return null;
    }
    return parsed.map((item) => String(item));
  }

  private pickString(obj: any, keys: string[]): string | null {
    for (const key of keys) {
      const value = obj?.[key];
      if (value === undefined || value === null) {
        continue;
      }
      const text = String(value).trim();
      if (text) {
        return text;
      }
    }
    return null;
  }
}

type PaginationResult<T> = {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
};
