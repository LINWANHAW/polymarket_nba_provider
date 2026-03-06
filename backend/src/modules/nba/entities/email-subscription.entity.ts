import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "email_subscription" })
@Index(["email"], { unique: true })
@Index(["isActive"])
@Index(["createdAt"])
export class EmailSubscription {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  email!: string;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "subscribed_at", type: "timestamptz", default: () => "now()" })
  subscribedAt!: Date;

  @Column({ name: "consent_source", type: "text", nullable: true })
  consentSource!: string | null;

  @Column({ name: "consent_ip", type: "text", nullable: true })
  consentIp!: string | null;

  @Column({ name: "consent_user_agent", type: "text", nullable: true })
  consentUserAgent!: string | null;

  @Column({ name: "unsubscribed_at", type: "timestamptz", nullable: true })
  unsubscribedAt!: Date | null;

  @Column({ name: "unsubscribe_reason", type: "text", nullable: true })
  unsubscribeReason!: string | null;

  @Column({
    name: "last_welcome_email_sent_at",
    type: "timestamptz",
    nullable: true
  })
  lastWelcomeEmailSentAt!: Date | null;

  @Column({ name: "last_welcome_email_error", type: "text", nullable: true })
  lastWelcomeEmailError!: string | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
