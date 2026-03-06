import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "nba_daily_analysis_digest" })
@Index(["digestDate"], { unique: true })
@Index(["status"])
@Index(["createdAt"])
export class NbaDailyAnalysisDigest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "digest_date", type: "date" })
  digestDate!: string;

  @Column({ name: "source_tz", type: "text", default: "America/New_York" })
  sourceTz!: string;

  @Column({ name: "game_count", type: "integer", default: 0 })
  gameCount!: number;

  @Column({ name: "analysis_count", type: "integer", default: 0 })
  analysisCount!: number;

  @Column({ name: "subscriber_count", type: "integer", default: 0 })
  subscriberCount!: number;

  @Column({ name: "queued_count", type: "integer", default: 0 })
  queuedCount!: number;

  @Column({ name: "delivered_count", type: "integer", default: 0 })
  deliveredCount!: number;

  @Column({ name: "failed_count", type: "integer", default: 0 })
  failedCount!: number;

  @Column({ type: "text", default: "generated" })
  status!: string;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @Column({ name: "payload_json", type: "jsonb", default: () => "'{}'::jsonb" })
  payloadJson!: Record<string, any>;

  @Column({ name: "generated_at", type: "timestamptz", default: () => "now()" })
  generatedAt!: Date;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
