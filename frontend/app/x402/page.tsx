import Link from "next/link";
import { X402Client } from "./x402-client";

export default function X402Page() {
  return (
    <main>
      <div className="badge">x402 Paywall</div>
      <h1>One-time Session Unlock</h1>
      <p>
        This endpoint is protected by x402. The first call in a session requires
        a 0.001 USDC payment on Base. After a successful payment, the session is
        unlocked and subsequent calls are free until the session ends.
      </p>

      <section className="x402-card">
        <div className="x402-head">
          <div>
            <div className="card-title">Protected API</div>
            <div className="hint">GET /x402/one-time</div>
          </div>
          <Link className="inline-link" href="/">
            Back to dashboard
          </Link>
        </div>
        <X402Client />
      </section>
    </main>
  );
}
