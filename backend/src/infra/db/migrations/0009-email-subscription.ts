import { MigrationInterface, QueryRunner } from "typeorm";

export class EmailSubscription20260306120000 implements MigrationInterface {
  name = "EmailSubscription20260306120000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_subscription" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "email" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "subscribed_at" timestamptz NOT NULL DEFAULT now(),
        "last_welcome_email_sent_at" timestamptz,
        "last_welcome_email_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_email_subscription_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(
      'CREATE INDEX "idx_email_subscription_is_active" ON "email_subscription" ("is_active")'
    );
    await queryRunner.query(
      'CREATE INDEX "idx_email_subscription_created_at" ON "email_subscription" ("created_at")'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_email_subscription_created_at"'
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_email_subscription_is_active"'
    );
    await queryRunner.query('DROP TABLE IF EXISTS "email_subscription"');
  }
}
