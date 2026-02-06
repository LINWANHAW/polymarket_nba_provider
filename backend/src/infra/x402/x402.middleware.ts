import type { Request, RequestHandler, Response } from "express";
import crypto from "crypto";
import cookie from "cookie";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";

const ROUTE_METHOD = "GET";
const ROUTE_PATH = "/x402/one-time";
const ROUTE_KEY = `${ROUTE_METHOD} ${ROUTE_PATH}`;

const SESSION_COOKIE_NAME =
  process.env.X402_SESSION_COOKIE_NAME || "x402_session";
const parsedSessionTtl = Number(process.env.X402_SESSION_TTL_MS);
const SESSION_TTL_MS =
  Number.isFinite(parsedSessionTtl) && parsedSessionTtl > 0
    ? parsedSessionTtl
    : 12 * 60 * 60 * 1000;
const SESSION_GC_INTERVAL_MS = 15 * 60 * 1000;

const paidSessions = new Map<string, number>();
let sessionGcStarted = false;

function isProtectedRoute(req: Request) {
  return req.method.toUpperCase() === ROUTE_METHOD && req.path === ROUTE_PATH;
}

function startSessionGc() {
  if (sessionGcStarted) {
    return;
  }
  sessionGcStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, expiresAt] of paidSessions.entries()) {
      if (expiresAt <= now) {
        paidSessions.delete(sessionId);
      }
    }
  }, SESSION_GC_INTERVAL_MS).unref();
}

function ensureSessionId(req: Request, res: Response) {
  const cookies = cookie.parse(req.headers.cookie || "");
  let sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    res.setHeader(
      "Set-Cookie",
      cookie.serialize(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/"
      })
    );
  }
  return sessionId;
}

function isSessionPaid(sessionId: string) {
  const expiresAt = paidSessions.get(sessionId);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    paidSessions.delete(sessionId);
    return false;
  }
  return true;
}

function markSessionPaid(sessionId: string) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  paidSessions.set(sessionId, expiresAt);
}

export function createX402Middleware(): RequestHandler | null {
  const enabled = process.env.X402_ENABLED !== "false";
  if (!enabled) {
    return null;
  }

  const payTo = process.env.X402_PAY_TO;
  if (!payTo) {
    throw new Error(
      "X402_PAY_TO is required unless X402_ENABLED=false (USDC recipient address)."
    );
  }

  const facilitatorUrl =
    process.env.X402_FACILITATOR_URL ||
    "https://api.cdp.coinbase.com/platform/v2/x402";
  const network = process.env.X402_NETWORK || "eip155:8453";
  const price = process.env.X402_PRICE || "$0.001";
  const description =
    process.env.X402_DESCRIPTION || "One-time session access";

  const cdpApiKeyId = process.env.X402_CDP_API_KEY_ID;
  const cdpApiKeySecret = process.env.X402_CDP_API_KEY_SECRET;
  const facilitatorUrlObj = new URL(facilitatorUrl);
  const facilitatorBasePath = facilitatorUrlObj.pathname.replace(/\/$/, "");

  const facilitator = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    createAuthHeaders:
      cdpApiKeyId && cdpApiKeySecret
        ? async () => {
            const baseAuth = {
              apiKeyId: cdpApiKeyId,
              apiKeySecret: cdpApiKeySecret,
              requestHost: facilitatorUrlObj.host
            };
            return {
              verify: await getAuthHeaders({
                ...baseAuth,
                requestMethod: "POST",
                requestPath: `${facilitatorBasePath}/verify`
              }),
              settle: await getAuthHeaders({
                ...baseAuth,
                requestMethod: "POST",
                requestPath: `${facilitatorBasePath}/settle`
              }),
              supported: await getAuthHeaders({
                ...baseAuth,
                requestMethod: "GET",
                requestPath: `${facilitatorBasePath}/supported`
              })
            };
          }
        : undefined
  });
  const server = new x402ResourceServer(facilitator).register(
    network,
    new ExactEvmScheme()
  );

  const routes = {
    [ROUTE_KEY]: {
      accepts: [{ scheme: "exact", network, price, payTo }],
      description,
      mimeType: "application/json"
    }
  };

  const x402Middleware = paymentMiddleware(routes, server);

  startSessionGc();

  return (req, res, next) => {
    if (!isProtectedRoute(req)) {
      return next();
    }

    const sessionId = ensureSessionId(req, res);
    if (isSessionPaid(sessionId)) {
      return next();
    }

    const hasPaymentHeader =
      typeof req.headers["payment-signature"] === "string" ||
      typeof req.headers["x-payment"] === "string";

    return x402Middleware(req, res, (err?: any) => {
      if (err) {
        return next(err);
      }
      if (hasPaymentHeader) {
        markSessionPaid(sessionId);
      }
      return next();
    });
  };
}
