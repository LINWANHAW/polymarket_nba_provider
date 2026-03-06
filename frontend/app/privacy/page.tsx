import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main>
      <div className="badge">Privacy Policy</div>
      <h1>Email Subscription Privacy</h1>
      <p>
        We collect your email for subscription notifications, and we also record
        consent metadata including subscription time, source, IP, and user-agent
        for compliance and abuse prevention.
      </p>
      <section>
        <div className="section-header">
          <h2>How We Use Data</h2>
          <Link className="inline-link" href="/subscribe">
            Back to subscribe
          </Link>
        </div>
        <p>
          We use this data to send subscription-related emails and to process
          unsubscribe requests, bounce events, and complaint feedback.
        </p>
        <p>
          You can unsubscribe anytime from the unsubscribe link included in
          emails.
        </p>
      </section>
    </main>
  );
}
