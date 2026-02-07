import { ApiProperty } from "@nestjs/swagger";

export class EventDto {
  @ApiProperty({ example: "2f5b3f44-2d2f-4b5f-9d2f-1e8c0b7f3e2a" })
  id!: string;

  @ApiProperty({ example: 12345 })
  polymarketEventId!: number;

  @ApiProperty({ example: "nba-lakers-vs-celtics" })
  slug!: string | null;

  @ApiProperty({ example: "Lakers vs Celtics" })
  title!: string | null;

  @ApiProperty({ example: "Moneyline market for Lakers vs Celtics" })
  description!: string | null;

  @ApiProperty({ example: "2026-02-06T00:00:00.000Z" })
  startDate!: Date | null;

  @ApiProperty({ example: "2026-02-06T06:00:00.000Z" })
  endDate!: Date | null;

  @ApiProperty({ example: true })
  active!: boolean | null;

  @ApiProperty({ example: false })
  closed!: boolean | null;

  @ApiProperty({ example: false })
  archived!: boolean | null;

  @ApiProperty({ example: true })
  featured!: boolean | null;

  @ApiProperty({ example: false })
  restricted!: boolean | null;

  @ApiProperty({ example: 15234.12 })
  liquidity!: number | null;

  @ApiProperty({ example: 90321.55 })
  volume!: number | null;

  @ApiProperty({ example: { series_id: 123 } })
  raw!: Record<string, any> | null;

  @ApiProperty({ example: "2026-02-06T00:01:00.000Z" })
  createdAt!: Date;

  @ApiProperty({ example: "2026-02-06T00:05:00.000Z" })
  updatedAt!: Date;
}

export class MarketDto {
  @ApiProperty({ example: "b1bb2a32-7d4e-44b8-9b6e-0a4b5b0a1b1a" })
  id!: string;

  @ApiProperty({ example: 98765 })
  polymarketMarketId!: number;

  @ApiProperty({ example: "lakers-vs-celtics-moneyline" })
  slug!: string | null;

  @ApiProperty({ example: "Will the Lakers win?" })
  question!: string | null;

  @ApiProperty({ example: "Lakers win" })
  title!: string | null;

  @ApiProperty({ example: "NBA" })
  category!: string | null;

  @ApiProperty({ example: "0xcond" })
  conditionId!: string | null;

  @ApiProperty({ example: "moneyline" })
  marketType!: string | null;

  @ApiProperty({ example: "binary" })
  formatType!: string | null;

  @ApiProperty({ example: true })
  active!: boolean | null;

  @ApiProperty({ example: false })
  closed!: boolean | null;

  @ApiProperty({ example: "active" })
  status!: string | null;

  @ApiProperty({ example: "2026-02-06T06:00:00.000Z" })
  endDate!: Date | null;

  @ApiProperty({ example: null })
  resolveTime!: Date | null;

  @ApiProperty({ example: 3210.5 })
  liquidity!: number | null;

  @ApiProperty({ example: 25123.75 })
  volume!: number | null;

  @ApiProperty({ example: 1123.44 })
  volume24hr!: number | null;

  @ApiProperty({ example: ["0.55", "0.45"] })
  outcomePrices!: any[] | null;

  @ApiProperty({ example: ["Yes", "No"] })
  outcomes!: any[] | null;

  @ApiProperty({ example: ["0xTokenYes", "0xTokenNo"] })
  clobTokenIds!: string[] | null;

  @ApiProperty({ example: "2026-02-06T00:10:00.000Z" })
  lastDetailSyncedAt!: Date | null;

  @ApiProperty({ example: "2f5b3f44-2d2f-4b5f-9d2f-1e8c0b7f3e2a" })
  eventId!: string | null;

  @ApiProperty({ example: { id: 98765, slug: "market" } })
  raw!: Record<string, any> | null;

  @ApiProperty({ example: "2026-02-06T00:01:00.000Z" })
  createdAt!: Date;

  @ApiProperty({ example: "2026-02-06T00:05:00.000Z" })
  updatedAt!: Date;
}

export class PaginatedEventDto {
  @ApiProperty({ type: [EventDto] })
  data!: EventDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 50 })
  pageSize!: number;

  @ApiProperty({ example: 120 })
  total!: number;
}

export class PaginatedMarketDto {
  @ApiProperty({ type: [MarketDto] })
  data!: MarketDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 50 })
  pageSize!: number;

  @ApiProperty({ example: 240 })
  total!: number;
}

export class PolymarketPriceTokenDto {
  @ApiProperty({ example: "0xTokenYes" })
  tokenId!: string;

  @ApiProperty({ example: "Yes" })
  outcome!: string | null;

  @ApiProperty({ example: { price: "0.55", size: "120" } })
  price!: Record<string, any>;
}

export class PolymarketPriceMarketDto {
  @ApiProperty({ example: 98765 })
  marketId!: number;

  @ApiProperty({ type: [PolymarketPriceTokenDto] })
  prices!: PolymarketPriceTokenDto[];
}

export class PolymarketPriceResponseDto {
  @ApiProperty({ example: "buy", required: false })
  side?: string;

  @ApiProperty({ example: "0xTokenYes", required: false })
  tokenId?: string;

  @ApiProperty({ example: { price: "0.55", size: "120" }, required: false })
  price?: Record<string, any>;

  @ApiProperty({ type: [PolymarketPriceMarketDto], required: false })
  markets?: PolymarketPriceMarketDto[];
}

export class PolymarketOrderbookTokenDto {
  @ApiProperty({ example: "0xTokenYes" })
  tokenId!: string;

  @ApiProperty({ example: "Yes" })
  outcome!: string | null;

  @ApiProperty({
    example: {
      bids: [["0.55", "200"]],
      asks: [["0.56", "150"]]
    }
  })
  orderbook!: Record<string, any>;
}

export class PolymarketOrderbookMarketDto {
  @ApiProperty({ example: 98765 })
  marketId!: number;

  @ApiProperty({ type: [PolymarketOrderbookTokenDto] })
  orderbooks!: PolymarketOrderbookTokenDto[];
}

export class PolymarketOrderbookResponseDto {
  @ApiProperty({ example: "0xTokenYes", required: false })
  tokenId?: string;

  @ApiProperty({
    example: {
      bids: [["0.55", "200"]],
      asks: [["0.56", "150"]]
    },
    required: false
  })
  orderbook?: Record<string, any>;

  @ApiProperty({ type: [PolymarketOrderbookMarketDto], required: false })
  markets?: PolymarketOrderbookMarketDto[];
}
