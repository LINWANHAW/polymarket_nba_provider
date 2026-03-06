"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";

type SubscribePayload = {
  id?: string;
  email?: string;
  isActive?: boolean;
  subscribedAt?: string;
  alreadySubscribed?: boolean;
  welcomeEmailQueued?: boolean;
  message?: string;
  error?: string;
};

function parseApiMessage(payload: SubscribePayload | null) {
  if (!payload) {
    return "Request failed.";
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }
  return "Request failed.";
}

export function SubscribeClient() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SubscribePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedEmail = useMemo(() => email.trim(), [email]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!trimmedEmail) {
      setError("Email is required.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/nba/subscriptions/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          email: trimmedEmail,
          source: "frontend_subscribe_page"
        })
      });
      const text = await response.text();
      let payload: SubscribePayload | null = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }

      if (!response.ok) {
        setError(parseApiMessage(payload));
        return;
      }

      setResult(payload ?? { message: "Subscribed." });
      setEmail("");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="subscribe-card">
      <form className="query-form" onSubmit={onSubmit}>
        <div className="form-row">
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
        </div>
        <button type="submit" disabled={loading}>
          {loading ? "Submitting..." : "Subscribe"}
        </button>
      </form>
      <div className="hint">
        By subscribing, you agree to our{" "}
        <Link className="inline-link" href="/privacy">
          Privacy Policy
        </Link>
        .
      </div>

      {error ? <div className="error">{error}</div> : null}

      {result ? (
        <div className="subscribe-result">
          <div className="subscribe-result-title">Subscription Result</div>
          <div className="hint">{result.message ?? "Subscribed."}</div>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}
