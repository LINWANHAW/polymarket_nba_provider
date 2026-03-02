import type { NextFunction, Request, RequestHandler, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  ensureSessionId,
  isSessionPaid,
  getSessionPayer,
  markSessionPaid,
  setSessionPayer,
} from "./x402.session";

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

type ProtectedRoute = {
  method: string;
  path: string;
  price: string;
  description: string;
  mimeType?: string;
};

function buildRouteKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

let coinbaseFacilitator: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const coinbase = require("@coinbase/x402");
  coinbaseFacilitator = coinbase?.facilitator ?? null;
} catch {
  coinbaseFacilitator = null;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} = require("@x402/core/http");

function extractPayerAddressFromPaymentPayload(
  paymentPayload: any
): string | null {
  if (!paymentPayload || typeof paymentPayload !== "object") {
    return null;
  }
  const payload = (paymentPayload as any).payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  // EIP-3009 payload: payload.authorization.from
  const fromAuth = payload?.authorization?.from;
  if (typeof fromAuth === "string" && fromAuth.length > 0) {
    return fromAuth;
  }
  // Permit2 payload: payload.permit2Authorization.from
  const fromPermit2 = payload?.permit2Authorization?.from;
  if (typeof fromPermit2 === "string" && fromPermit2.length > 0) {
    return fromPermit2;
  }
  return null;
}

function parsePositiveChainId(value: unknown): number | null {
  if (Array.isArray(value)) {
    return parsePositiveChainId(value[0]);
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parsePositiveInt(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function parseChainIdFromNetwork(value: string): number | null {
  if (!value || typeof value !== "string") {
    return null;
  }
  const matched = value.trim().match(/^eip155:(\d+)$/);
  if (!matched) {
    return null;
  }
  const parsed = Number(matched[1]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseMoneyToDecimal(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`invalid numeric money value: ${value}`);
    }
    return value;
  }
  const cleaned = value.replace(/^\$/, "").trim();
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid money value: ${value}`);
  }
  return parsed;
}

function decimalToTokenAmount(value: string | number, decimals: number): string {
  const decimal = parseMoneyToDecimal(value);
  const [intPart, fracPart = ""] = String(decimal).split(".");
  const normalizedInt = intPart.replace(/^0+/, "") || "0";
  const normalizedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const amount = `${normalizedInt}${normalizedFrac}`.replace(/^0+/, "");
  return amount || "0";
}

function applyCorsHeaders(
  req: Request,
  res: Response,
  allowedMethods: string
) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }
  const normalized = normalizeOrigin(origin);
  if (corsOrigins.length === 0 || corsOrigins.includes(normalized)) {
    // Per spec, you must echo the request Origin (not the normalized value).
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT, X-CHAIN-ID, Access-Control-Expose-Headers",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X402-DEBUG-HAS-PAYMENT, X402-DEBUG-PAYMENT-LEN, X402-DEBUG-PAYMENT-VERSION",
  );
  res.setHeader("Access-Control-Allow-Methods", allowedMethods);
}

export function createX402Middleware(): RequestHandler | null {
  const enabled = process.env.X402_ENABLED !== "false";
  if (!enabled) {
    return null;
  }

  const oneTimePrice = process.env.X402_PRICE || "$0.001";
  const analysisPrice = process.env.X402_ANALYSIS_PRICE || oneTimePrice;
  const analysisDescription =
    process.env.X402_ANALYSIS_DESCRIPTION || "NBA AI analysis access";
  const a2aPrice = process.env.X402_A2A_PRICE || analysisPrice;
  const a2aDescription =
    process.env.X402_A2A_DESCRIPTION || "A2A paid task access";

  const protectedRoutes: ProtectedRoute[] = [
    {
      method: "POST",
      path: "/nba/analysis",
      price: analysisPrice,
      description: analysisDescription,
      mimeType: "application/json",
    },
    {
      method: "POST",
      path: "/a2a/tasks",
      price: a2aPrice,
      description: a2aDescription,
      mimeType: "application/json",
    },
  ];
  const protectedRouteKeys = new Set(
    protectedRoutes.map((route) => buildRouteKey(route.method, route.path))
  );
  const allowedMethods = Array.from(
    new Set([
      ...protectedRoutes.map((route) => route.method.toUpperCase()),
      "OPTIONS",
    ])
  ).join(", ");

  const payTo = process.env.X402_PAY_TO;
  if (!payTo) {
    // Don't crash the whole API for a single protected route misconfiguration.
    console.error(
      "[x402] disabled: X402_PAY_TO is required unless X402_ENABLED=false (USDC recipient address)."
    );
    return (req: Request, res: Response, next: NextFunction) => {
      if (!protectedRouteKeys.has(buildRouteKey(req.method, req.path))) {
        return next();
      }
      applyCorsHeaders(req, res, allowedMethods);
      if (req.method.toUpperCase() === "OPTIONS") {
        res.status(204).end();
        return;
      }
      res.status(503).json({
        error: "x402_not_configured",
        message: "x402 is not configured on this server",
      });
    };
  }

  const baseNetworkRaw = process.env.X402_NETWORK || "eip155:84532";
  const baseChainIdParsed = parseChainIdFromNetwork(baseNetworkRaw);
  const baseChainId = baseChainIdParsed ?? 84532;
  const baseNetwork = `eip155:${baseChainId}`;
  if (!baseChainIdParsed) {
    console.warn(
      `[x402] invalid X402_NETWORK="${baseNetworkRaw}", fallback to ${baseNetwork}`
    );
  }

  const polygonNetworkRaw = process.env.X402_POLYGON_NETWORK || "eip155:137";
  const polygonChainIdParsed = parseChainIdFromNetwork(polygonNetworkRaw);
  const polygonChainId = polygonChainIdParsed ?? 137;
  const polygonNetwork = `eip155:${polygonChainId}`;
  if (!polygonChainIdParsed) {
    console.warn(
      `[x402] invalid X402_POLYGON_NETWORK="${polygonNetworkRaw}", fallback to ${polygonNetwork}`
    );
  }
  const polygonFacilitatorUrl =
    process.env.X402_POLYGON_FACILITATOR_URL || "https://facilitator.x402.fi";
  const baseFacilitatorUrl =
    process.env.X402_FACILITATOR_URL || "https://www.x402.org/facilitator";
  const polygonVerifyFallbackEnabled =
    process.env.X402_POLYGON_VERIFY_FALLBACK !== "false";
  const polygonAsset =
    process.env.X402_POLYGON_USDC ||
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const polygonAssetDecimals =
    parsePositiveInt(process.env.X402_POLYGON_USDC_DECIMALS) ?? 6;
  const polygonAssetName = process.env.X402_POLYGON_USDC_NAME || "USD Coin";
  const polygonAssetVersion = process.env.X402_POLYGON_USDC_VERSION || "2";
  const polygonAssetSymbol = process.env.X402_POLYGON_USDC_SYMBOL || "USDC";
  const polygonAssetTransferMethod =
    process.env.X402_POLYGON_USDC_TRANSFER_METHOD || "eip3009";

  const cdpApiKeyId =
    process.env.CDP_API_KEY_ID || process.env.X402_CDP_API_KEY_ID;
  const cdpApiKeySecret =
    process.env.CDP_API_KEY_SECRET || process.env.X402_CDP_API_KEY_SECRET;

  if (!process.env.CDP_API_KEY_ID && process.env.X402_CDP_API_KEY_ID) {
    process.env.CDP_API_KEY_ID = process.env.X402_CDP_API_KEY_ID;
  }
  if (!process.env.CDP_API_KEY_SECRET && process.env.X402_CDP_API_KEY_SECRET) {
    process.env.CDP_API_KEY_SECRET = process.env.X402_CDP_API_KEY_SECRET;
  }

  const useCoinbaseFacilitator = Boolean(cdpApiKeyId && cdpApiKeySecret);
  if (!useCoinbaseFacilitator) {
    console.warn(
      `[x402] base network: CDP keys missing; fallback facilitator=${baseFacilitatorUrl}`
    );
  }
  if (useCoinbaseFacilitator && !coinbaseFacilitator) {
    console.warn(
      `[x402] base network: @coinbase/x402 facilitator unavailable; fallback facilitator=${baseFacilitatorUrl}`
    );
  }

  const buildMiddlewareForNetwork = (
    network: string,
    facilitator: any,
    label: string
  ): RequestHandler | null => {
    try {
      const scheme = new ExactEvmScheme() as any;
      if (typeof scheme.registerMoneyParser === "function") {
        scheme.registerMoneyParser(
          async (amount: number, requestedNetwork: string) => {
            if (requestedNetwork !== polygonNetwork) {
              return null;
            }
            return {
              amount: decimalToTokenAmount(amount, polygonAssetDecimals),
              asset: polygonAsset,
              extra: {
                name: polygonAssetName,
                version: polygonAssetVersion,
                symbol: polygonAssetSymbol,
                decimals: polygonAssetDecimals,
                assetTransferMethod: polygonAssetTransferMethod,
              },
            };
          }
        );
      }
      const server = new x402ResourceServer(facilitator).register(
        network,
        scheme,
      );
      const routes = Object.fromEntries(
        protectedRoutes.map((route) => [
          buildRouteKey(route.method, route.path),
          {
            accepts: [{ scheme: "exact", network, price: route.price, payTo }],
            description: route.description,
            mimeType: route.mimeType ?? "application/json",
          },
        ])
      );
      return paymentMiddleware(routes, server);
    } catch (err: any) {
      console.error(`[x402] ${label} middleware initialization failed.`, err);
      return null;
    }
  };

  type ChainRuntime = {
    chainId: number;
    network: string;
    label: string;
    middleware: RequestHandler | null;
  };

  const runtimes: ChainRuntime[] = [];
  const shouldUseCoinbaseForBase = Boolean(
    useCoinbaseFacilitator && coinbaseFacilitator
  );
  const baseFacilitator = shouldUseCoinbaseForBase
    ? new HTTPFacilitatorClient(coinbaseFacilitator)
    : new HTTPFacilitatorClient({ url: baseFacilitatorUrl });
  if (useCoinbaseFacilitator && coinbaseFacilitator) {
    runtimes.push({
      chainId: baseChainId,
      network: baseNetwork,
      label: "coinbase-base",
      middleware: buildMiddlewareForNetwork(
        baseNetwork,
        baseFacilitator,
        "coinbase-base"
      ),
    });
  } else {
    runtimes.push({
      chainId: baseChainId,
      network: baseNetwork,
      label: "base-fallback",
      middleware: buildMiddlewareForNetwork(
        baseNetwork,
        baseFacilitator,
        "base-fallback"
      ),
    });
  }

  const polygonFacilitatorBase: any = new HTTPFacilitatorClient({
    url: polygonFacilitatorUrl,
  });
  const polygonFacilitator = {
    getSupported: () => polygonFacilitatorBase.getSupported(),
    settle: (paymentPayload: any, paymentRequirements: any) =>
      polygonFacilitatorBase.settle(paymentPayload, paymentRequirements),
    verify: async (paymentPayload: any, paymentRequirements: any) => {
      try {
        const verifyResult = await polygonFacilitatorBase.verify(
          paymentPayload,
          paymentRequirements
        );
        if (
          polygonVerifyFallbackEnabled &&
          verifyResult &&
          verifyResult.isValid === false &&
          verifyResult.invalidReason === "invalid_x402_version"
        ) {
          console.warn(
            "[x402] polygon verify returned invalid_x402_version; fallback to settlement stage."
          );
          return { isValid: true };
        }
        return verifyResult;
      } catch (err: any) {
        const invalidReason =
          typeof err?.invalidReason === "string"
            ? err.invalidReason
            : typeof err?.verifyResponse?.invalidReason === "string"
              ? err.verifyResponse.invalidReason
              : null;
        if (
          polygonVerifyFallbackEnabled &&
          invalidReason === "invalid_x402_version"
        ) {
          console.warn(
            "[x402] polygon verify threw invalid_x402_version; fallback to settlement stage."
          );
          return { isValid: true };
        }
        throw err;
      }
    },
  };
  runtimes.push({
    chainId: polygonChainId,
    network: polygonNetwork,
    label: "polygon-x402fi",
    middleware: buildMiddlewareForNetwork(
      polygonNetwork,
      polygonFacilitator,
      "polygon-x402fi"
    ),
  });

  const runtimeByChainId = new Map<number, ChainRuntime>();
  for (const runtime of runtimes) {
    if (runtimeByChainId.has(runtime.chainId)) {
      console.error(
        `[x402] duplicate chain id ${runtime.chainId} configured; keeping first runtime.`
      );
      continue;
    }
    runtimeByChainId.set(runtime.chainId, runtime);
  }
  const supportedChainIds = Array.from(runtimeByChainId.keys()).sort(
    (a, b) => a - b
  );
  const defaultChainId = baseChainId;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!protectedRouteKeys.has(buildRouteKey(req.method, req.path))) {
      return next();
    }

    // Allow a subset of A2A capabilities without payment.
    // Because x402 runs at middleware level, we gate by query string to avoid consuming body streams.
    if (req.method.toUpperCase() === "POST" && req.path === "/a2a/tasks") {
      const capabilityRaw = (req.query as any)?.capability;
      const capability =
        typeof capabilityRaw === "string" ? capabilityRaw.trim() : "";
      const free = new Set(["nba.matchup_brief"]);
      if (free.has(capability)) {
        return next();
      }
    }

    applyCorsHeaders(req, res, allowedMethods);
    if (req.method.toUpperCase() === "OPTIONS") {
      res.status(204).end();
      return;
    }

    const chainIdHeader = parsePositiveChainId(req.headers["x-chain-id"]);
    const selectedChainId = chainIdHeader ?? defaultChainId;
    const selectedRuntime = runtimeByChainId.get(selectedChainId);
    if (!selectedRuntime) {
      res.status(400).json({
        error: "x402_unsupported_chain",
        message: `unsupported chain id: ${selectedChainId}`,
        supportedChainIds,
      });
      return;
    }

    if (!selectedRuntime.middleware) {
      res.status(503).json({
        error: "x402_unavailable",
        message: `x402 facilitator is unavailable for chain ${selectedRuntime.chainId}; try again later`,
      });
      return;
    }

    const sessionId = ensureSessionId(req, res);
    const paymentHeader =
      typeof req.headers["payment-signature"] === "string"
        ? req.headers["payment-signature"]
        : typeof req.headers["x-payment"] === "string"
          ? req.headers["x-payment"]
          : null;
    let paymentPayloadVersion: number | null = null;
    let payerAddress: string | null = getSessionPayer(sessionId);
    if (paymentHeader) {
      try {
        const decoded = decodePaymentSignatureHeader(paymentHeader);
        if (typeof decoded?.x402Version === "number") {
          paymentPayloadVersion = decoded.x402Version;
        }
        const extracted = extractPayerAddressFromPaymentPayload(decoded);
        if (extracted) {
          payerAddress = extracted;
          setSessionPayer(sessionId, extracted);
        }
      } catch {
        // ignore decode failures
      }
    }
    // Attach for downstream handlers (Nest controller can read this).
    (req as any).x402 = {
      sessionId,
      payerAddress,
      chainId: selectedChainId,
      hasPaymentHeader: Boolean(paymentHeader),
    };
    const debugEnabled =
      process.env.X402_DEBUG === "true" ||
      process.env.NODE_ENV !== "production";
    if (debugEnabled) {
      res.setHeader("X402-DEBUG-HAS-PAYMENT", paymentHeader ? "1" : "0");
      res.setHeader(
        "X402-DEBUG-PAYMENT-LEN",
        paymentHeader ? String(paymentHeader.length) : "0",
      );
      if (paymentPayloadVersion !== null) {
        res.setHeader(
          "X402-DEBUG-PAYMENT-VERSION",
          String(paymentPayloadVersion),
        );
      }
    }
    let sessionMarked = false;
    res.on("finish", () => {
      if (sessionMarked || res.statusCode >= 400) {
        return;
      }
      const paymentResponse =
        res.getHeader("PAYMENT-RESPONSE") ||
        res.getHeader("X-PAYMENT-RESPONSE");
      if (paymentResponse) {
        // Prefer settle response payer if present.
        if (!payerAddress && typeof paymentResponse === "string") {
          try {
            const decoded = decodePaymentResponseHeader(paymentResponse);
            if (decoded?.payer && typeof decoded.payer === "string") {
              payerAddress = decoded.payer;
              setSessionPayer(sessionId, decoded.payer);
              if ((req as any).x402) {
                (req as any).x402.payerAddress = decoded.payer;
              }
            }
          } catch {
            // ignore decode failures
          }
        }
        markSessionPaid(sessionId);
        sessionMarked = true;
      }
    });
    if (isSessionPaid(sessionId)) {
      return next();
    }

    const originalJson = res.json.bind(res);
    res.json = ((body?: any) => {
      if (
        (res.statusCode === 402 || res.statusCode === 412) &&
        (!body || (typeof body === "object" && Object.keys(body).length === 0))
      ) {
        const header = res.getHeader("PAYMENT-REQUIRED");
        if (typeof header === "string") {
          try {
            const decoded = decodePaymentRequiredHeader(header);
            return originalJson(decoded);
          } catch {
            // fall through to original body
          }
        }
      }
      return originalJson(body);
    }) as Response["json"];

    return selectedRuntime.middleware(req, res, (err?: any) => {
      if (err) {
        return next(err);
      }
      return next();
    });
  };
}
