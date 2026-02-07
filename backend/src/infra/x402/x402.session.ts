import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";

const SESSION_COOKIE_NAME =
  process.env.X402_SESSION_COOKIE_NAME || "x402_session";

const sessionMode = String(process.env.X402_SESSION_MODE || "")
  .trim()
  .toLowerCase();
const parsedSessionTtl = Number(process.env.X402_SESSION_TTL_MS);
const SESSION_DISABLED =
  sessionMode === "per_request" ||
  sessionMode === "disabled" ||
  parsedSessionTtl === 0;
const SESSION_TTL_MS =
  Number.isFinite(parsedSessionTtl) && parsedSessionTtl > 0
    ? parsedSessionTtl
    : 12 * 60 * 60 * 1000;

const SESSION_GC_INTERVAL_MS = 15 * 60 * 1000;

const paidSessions = new Map<string, number>();
let gcStarted = false;

function startGc() {
  if (gcStarted) {
    return;
  }
  gcStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, expiresAt] of paidSessions.entries()) {
      if (expiresAt <= now) {
        paidSessions.delete(sessionId);
      }
    }
  }, SESSION_GC_INTERVAL_MS).unref();
}

export function ensureSessionId(req: Request, res: Response) {
  if (SESSION_DISABLED) {
    return "per_request";
  }
  startGc();
  const cookies = parseCookie(req.headers.cookie || "");
  let sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    sessionId = randomUUID();
    res.setHeader(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/"
      })
    );
  }
  return sessionId;
}

export function isSessionPaid(sessionId: string) {
  if (SESSION_DISABLED) {
    return false;
  }
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

export function markSessionPaid(sessionId: string) {
  if (SESSION_DISABLED) {
    return;
  }
  const expiresAt = Date.now() + SESSION_TTL_MS;
  paidSessions.set(sessionId, expiresAt);
}
