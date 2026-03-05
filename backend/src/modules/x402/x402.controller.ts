import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Query,
  Param,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

@Controller("x402")
@ApiTags("x402")
export class X402Controller {
  private matchesBazaarQuery(item: any, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return true;
    }

    const texts: string[] = [];
    const pushText = (value: unknown) => {
      if (typeof value === "string" && value.trim()) {
        texts.push(value.toLowerCase());
      }
    };

    pushText(item?.resource);
    pushText(item?.type);
    pushText(item?.metadata?.provider);
    pushText(item?.metadata?.category);
    pushText(item?.metadata?.description);
    pushText(item?.metadata?.method);
    pushText(item?.metadata?.path);
    pushText(item?.metadata?.name);

    const accepts = Array.isArray(item?.accepts) ? item.accepts : [];
    for (const accept of accepts) {
      pushText(accept?.scheme);
      pushText(accept?.network);
      pushText(accept?.asset);
      pushText(accept?.description);
      pushText(accept?.extra?.name);
      pushText(accept?.extra?.symbol);
    }

    return texts.some((text) => text.includes(needle));
  }

  private matchesBazaarSeller(item: any, seller: string): boolean {
    const needle = seller.trim().toLowerCase();
    if (!needle) {
      return true;
    }
    const resource = typeof item?.resource === "string" ? item.resource : "";
    const itemSeller = typeof item?.seller === "string" ? item.seller : "";
    return (
      resource.toLowerCase().includes(needle) ||
      itemSeller.toLowerCase().includes(needle)
    );
  }

  private parseChainIdFromNetwork(value?: string): number | null {
    if (!value || typeof value !== "string") {
      return null;
    }
    const match = value.trim().match(/^eip155:(\d+)$/);
    if (!match) {
      return null;
    }
    const parsed = Number(match[1]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private resolveBazaarBaseUrl(network?: string): string {
    const explicit = process.env.X402_BAZAAR_SERVICE_URL?.trim();
    if (explicit) {
      return explicit.replace(/\/+$/, "");
    }
    const chainId = this.parseChainIdFromNetwork(network);
    if (chainId === 137) {
      return (
        process.env.X402_POLYGON_BAZAAR_SERVICE_URL ||
        process.env.X402_POLYGON_FACILITATOR_URL ||
        "https://facilitator.x402.fi"
      ).replace(/\/+$/, "");
    }
    return (
      process.env.X402_BASE_BAZAAR_SERVICE_URL ||
      process.env.X402_CDP_DISCOVERY_URL ||
      "https://api.cdp.coinbase.com/platform/v2/x402"
    ).replace(/\/+$/, "");
  }

  private parsePositiveInt(value: unknown, fallback: number): number {
    if (typeof value !== "string" || !value.trim()) {
      return fallback;
    }
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      return fallback;
    }
    return parsed;
  }

  private appendIfString(params: URLSearchParams, key: string, value: unknown) {
    if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
    }
  }

  private async requestBazaar(pathWithQuery: string, network?: string) {
    const bazaarBaseUrl = this.resolveBazaarBaseUrl(network);
    const response = await fetch(`${bazaarBaseUrl}${pathWithQuery}`, {
      headers: {
        Accept: "application/json",
      },
    });
    const text = await response.text();
    let payload: any = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      throw new HttpException(
        {
          error: "bazaar_upstream_error",
          statusCode: response.status,
          upstream: payload,
        },
        response.status,
      );
    }
    return payload;
  }

  @Get("bazaar/resources")
  @ApiOperation({ summary: "List Bazaar discovery resources" })
  @ApiQuery({ name: "query", required: false })
  @ApiQuery({ name: "seller", required: false })
  @ApiQuery({
    name: "network",
    required: false,
    description: "e.g. eip155:137",
  })
  @ApiQuery({ name: "type", required: false, description: "http | mcp" })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "default 20, max 100",
  })
  @ApiQuery({ name: "offset", required: false, description: "default 0" })
  async listBazaarResources(
    @Query("query") query?: string,
    @Query("seller") seller?: string,
    @Query("network") network?: string,
    @Query("type") type?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const parsedLimit = Math.min(
      100,
      Math.max(1, this.parsePositiveInt(limit, 20)),
    );
    const parsedOffset = this.parsePositiveInt(offset, 0);
    if (network && !/^eip155:\d+$/.test(network.trim())) {
      throw new BadRequestException(
        "network must be in CAIP-2 format, e.g. eip155:137",
      );
    }
    if (type && !["http", "mcp"].includes(type.trim())) {
      throw new BadRequestException("type must be one of: http, mcp");
    }

    const params = new URLSearchParams();
    params.set("limit", String(parsedLimit));
    params.set("offset", String(parsedOffset));
    this.appendIfString(params, "query", query);
    this.appendIfString(params, "seller", seller);
    this.appendIfString(params, "network", network);
    this.appendIfString(params, "type", type);

    const trimmedQuery = query?.trim() ?? "";
    const trimmedSeller = seller?.trim() ?? "";
    const shouldUseLocalFilter = Boolean(trimmedQuery || trimmedSeller);
    if (!shouldUseLocalFilter) {
      return this.requestBazaar(`/discovery/resources?${params.toString()}`, network);
    }

    // Some discovery endpoints currently do not apply query/seller reliably.
    // Apply deterministic local filtering over multiple pages.
    const scanLimitPerPage = 100;
    const maxScan =
      Number.parseInt(process.env.X402_BAZAAR_LOCAL_FILTER_MAX_SCAN ?? "2000", 10) ||
      2000;
    const maxPages = Math.max(1, Math.floor(maxScan / scanLimitPerPage));

    const localFilterParams = new URLSearchParams();
    localFilterParams.set("limit", String(scanLimitPerPage));
    localFilterParams.set("offset", "0");
    this.appendIfString(localFilterParams, "network", network);
    this.appendIfString(localFilterParams, "type", type);

    const collected: any[] = [];
    let basePayload: any = null;
    for (let page = 0; page < maxPages; page += 1) {
      localFilterParams.set("offset", String(page * scanLimitPerPage));
      let payload: any;
      try {
        payload = await this.requestBazaar(
          `/discovery/resources?${localFilterParams.toString()}`,
          network,
        );
      } catch {
        break;
      }
      if (!basePayload) {
        basePayload = payload;
      }
      const pageItems = Array.isArray(payload?.items) ? payload.items : [];
      if (pageItems.length === 0) {
        break;
      }
      collected.push(...pageItems);
      if (pageItems.length < scanLimitPerPage) {
        break;
      }
    }

    const filteredItems = collected.filter(
      (item: any) =>
        this.matchesBazaarQuery(item, trimmedQuery) &&
        this.matchesBazaarSeller(item, trimmedSeller),
    );
    const pagedItems = filteredItems.slice(parsedOffset, parsedOffset + parsedLimit);
    const pagination =
      basePayload?.pagination && typeof basePayload.pagination === "object"
        ? basePayload.pagination
        : {};

    return {
      ...(basePayload || {}),
      items: pagedItems,
      pagination: {
        ...pagination,
        offset: parsedOffset,
        limit: parsedLimit,
        total: filteredItems.length,
        filteredByQuery: true,
        localFilterScanCount: collected.length,
      },
    };
  }

  @Get("bazaar/resources/:resourceId")
  @ApiOperation({ summary: "Get Bazaar discovery resource by id" })
  @ApiQuery({
    name: "network",
    required: false,
    description: "e.g. eip155:137",
  })
  async getBazaarResource(
    @Param("resourceId") resourceId: string,
    @Query("network") network?: string,
  ) {
    if (!resourceId?.trim()) {
      throw new BadRequestException("resourceId is required");
    }
    if (network && !/^eip155:\d+$/.test(network.trim())) {
      throw new BadRequestException(
        "network must be in CAIP-2 format, e.g. eip155:137",
      );
    }
    const params = new URLSearchParams();
    this.appendIfString(params, "network", network);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.requestBazaar(
      `/discovery/resources/${encodeURIComponent(resourceId.trim())}${suffix}`,
      network,
    );
  }
}
