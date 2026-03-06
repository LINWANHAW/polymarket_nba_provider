import { MigrationInterface, QueryRunner } from "typeorm";

export class NbaDailyAnalysisDigest20260306220000
  implements MigrationInterface
{
  name = "NbaDailyAnalysisDigest20260306220000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "nba_daily_analysis_digest" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "digest_date" date NOT NULL,
        "source_tz" text NOT NULL DEFAULT 'America/New_York',
        "game_count" integer NOT NULL DEFAULT 0,
        "analysis_count" integer NOT NULL DEFAULT 0,
        "subscriber_count" integer NOT NULL DEFAULT 0,
        "queued_count" integer NOT NULL DEFAULT 0,
        "delivered_count" integer NOT NULL DEFAULT 0,
        "failed_count" integer NOT NULL DEFAULT 0,
        "status" text NOT NULL DEFAULT 'generated',
        "error" text,
        "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "generated_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_nba_daily_analysis_digest_date" UNIQUE ("digest_date")
      )
    `);

    await queryRunner.query(
      'CREATE INDEX "idx_nba_daily_analysis_digest_status" ON "nba_daily_analysis_digest" ("status")'
    );
    await queryRunner.query(
      'CREATE INDEX "idx_nba_daily_analysis_digest_created_at" ON "nba_daily_analysis_digest" ("created_at")'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_nba_daily_analysis_digest_created_at"'
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_nba_daily_analysis_digest_status"'
    );
    await queryRunner.query('DROP TABLE IF EXISTS "nba_daily_analysis_digest"');
  }
}
