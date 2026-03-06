import { proxyJson } from "../../../_lib/upstream";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return proxyJson(req, {
    method: "POST",
    path: "/nba/subscriptions/email",
    body
  });
}
