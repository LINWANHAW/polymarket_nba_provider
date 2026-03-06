import { proxyJson } from "../../../../api/_lib/upstream";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const source = url.searchParams.get("source") || "";
  const query = new URLSearchParams();
  if (token) {
    query.set("token", token);
  }
  if (source) {
    query.set("source", source);
  }
  return proxyJson(req, {
    method: "GET",
    path: `/nba/subscriptions/email/unsubscribe?${query.toString()}`
  });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const source = url.searchParams.get("source") || "";
  const query = new URLSearchParams();
  if (token) {
    query.set("token", token);
  }
  if (source) {
    query.set("source", source);
  }
  const body = await req.json().catch(() => ({}));
  return proxyJson(req, {
    method: "POST",
    path: `/nba/subscriptions/email/unsubscribe?${query.toString()}`,
    body
  });
}
