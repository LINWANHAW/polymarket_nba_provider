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
  private resolveBazaarBaseUrl(): string {
    const configured =
      process.env.X402_BAZAAR_SERVICE_URL || "https://api-hoobs.polyox.io";
    return configured.replace(/\/+$/, "");
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

  private async requestBazaar(pathWithQuery: string) {
    const bazaarBaseUrl = this.resolveBazaarBaseUrl();
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

    return this.requestBazaar(`/discovery/resources?${params.toString()}`);
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
    );
  }
}
