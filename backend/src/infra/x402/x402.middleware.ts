import type { NextFunction, Request, RequestHandler, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  ensureSessionId,
  isSessionPaid,
  markSessionPaid,
} from "./x402.session";

const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
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
const { decodePaymentRequiredHeader } = require("@x402/core/http");

function applyCorsHeaders(
  req: Request,
  res: Response,
  allowedMethods: string
) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }
  if (corsOrigins.length === 0 || corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X402-DEBUG-HAS-PAYMENT, X402-DEBUG-PAYMENT-LEN",
  );
  res.setHeader("Access-Control-Allow-Methods", allowedMethods);
}

export function createX402Middleware(): RequestHandler | null {
  const enabled = process.env.X402_ENABLED !== "false";
  if (!enabled) {
    return null;
  }

  const payTo = process.env.X402_PAY_TO;
  if (!payTo) {
    throw new Error(
      "X402_PAY_TO is required unless X402_ENABLED=false (USDC recipient address).",
    );
  }

  const facilitatorUrl =
    process.env.X402_FACILITATOR_URL || "https://www.x402.org/facilitator";
  const network = process.env.X402_NETWORK || "eip155:84532";
  const oneTimePrice = process.env.X402_PRICE || "$0.001";
  const analysisPrice = process.env.X402_ANALYSIS_PRICE || oneTimePrice;
  const analysisDescription =
    process.env.X402_ANALYSIS_DESCRIPTION || "NBA AI analysis access";

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
  if (useCoinbaseFacilitator && !coinbaseFacilitator) {
    throw new Error(
      "CDP API keys provided but @coinbase/x402 facilitator is unavailable.",
    );
  }

  const facilitator = useCoinbaseFacilitator
    ? new HTTPFacilitatorClient(coinbaseFacilitator)
    : new HTTPFacilitatorClient({ url: facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(
    network,
    new ExactEvmScheme(),
  );

  const protectedRoutes: ProtectedRoute[] = [
    {
      method: "POST",
      path: "/nba/analysis",
      price: analysisPrice,
      description: analysisDescription,
      mimeType: "application/json",
    },
  ];

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
  const protectedRouteKeys = new Set(Object.keys(routes));
  const allowedMethods = Array.from(
    new Set([...protectedRoutes.map((route) => route.method.toUpperCase()), "OPTIONS"])
  ).join(", ");

  const x402Middleware = paymentMiddleware(routes, server);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!protectedRouteKeys.has(buildRouteKey(req.method, req.path))) {
      return next();
    }

    applyCorsHeaders(req, res, allowedMethods);
    if (req.method.toUpperCase() === "OPTIONS") {
      res.status(204).end();
      return;
    }

    const sessionId = ensureSessionId(req, res);
    const paymentHeader =
      typeof req.headers["payment-signature"] === "string"
        ? req.headers["payment-signature"]
        : typeof req.headers["x-payment"] === "string"
          ? req.headers["x-payment"]
          : null;
    const debugEnabled =
      process.env.X402_DEBUG === "true" ||
      process.env.NODE_ENV !== "production";
    if (debugEnabled) {
      res.setHeader("X402-DEBUG-HAS-PAYMENT", paymentHeader ? "1" : "0");
      res.setHeader(
        "X402-DEBUG-PAYMENT-LEN",
        paymentHeader ? String(paymentHeader.length) : "0",
      );
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

    return x402Middleware(req, res, (err?: any) => {
      if (err) {
        return next(err);
      }
      return next();
    });
  };
}
