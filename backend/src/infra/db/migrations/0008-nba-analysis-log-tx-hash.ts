import { MigrationInterface, QueryRunner } from "typeorm";

export class NbaAnalysisLogTxHash20260301170000 implements MigrationInterface {
  name = "NbaAnalysisLogTxHash20260301170000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "nba_analysis_log"
      ADD COLUMN IF NOT EXISTS "tx_hash" text,
      ADD COLUMN IF NOT EXISTS "chain_id" integer
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "nba_analysis_log"
      DROP COLUMN IF EXISTS "chain_id",
      DROP COLUMN IF EXISTS "tx_hash"
    `);
  }
}
