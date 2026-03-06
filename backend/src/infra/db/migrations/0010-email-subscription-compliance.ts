import { MigrationInterface, QueryRunner } from "typeorm";

export class EmailSubscriptionCompliance20260306180000
  implements MigrationInterface
{
  name = "EmailSubscriptionCompliance20260306180000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "email_subscription"
      ADD COLUMN IF NOT EXISTS "consent_source" text,
      ADD COLUMN IF NOT EXISTS "consent_ip" text,
      ADD COLUMN IF NOT EXISTS "consent_user_agent" text,
      ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "unsubscribe_reason" text
    `);

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "idx_email_subscription_unsubscribed_at" ON "email_subscription" ("unsubscribed_at")'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_email_subscription_unsubscribed_at"'
    );
    await queryRunner.query(`
      ALTER TABLE "email_subscription"
      DROP COLUMN IF EXISTS "unsubscribe_reason",
      DROP COLUMN IF EXISTS "unsubscribed_at",
      DROP COLUMN IF EXISTS "consent_user_agent",
      DROP COLUMN IF EXISTS "consent_ip",
      DROP COLUMN IF EXISTS "consent_source"
    `);
  }
}
