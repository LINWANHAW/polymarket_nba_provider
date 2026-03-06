import Link from "next/link";
import { SubscribeClient } from "./subscribe-client";

export default function SubscribePage() {
  return (
    <main>
      <div className="badge">Email Subscription</div>
      <h1>Subscribe for NBA Updates</h1>
      <p>
        Enter your email to subscribe. After success, a thank-you email will be
        sent asynchronously through the backend queue.
      </p>

      <section>
        <div className="section-header">
          <h2>Join the List</h2>
          <Link className="inline-link" href="/">
            Back to dashboard
          </Link>
        </div>
        <SubscribeClient />
      </section>
    </main>
  );
}
