import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "nba_analysis_log" })
@Index(["payerAddress"])
@Index(["sessionId"])
@Index(["createdAt"])
export class NbaAnalysisLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "payer_address", type: "text", nullable: true })
  payerAddress!: string | null;

  @Column({ name: "session_id", type: "text", nullable: true })
  sessionId!: string | null;

  @Column({ name: "tx_hash", type: "text", nullable: true })
  txHash!: string | null;

  @Column({ name: "chain_id", type: "integer", nullable: true })
  chainId!: number | null;

  @Column({ name: "request_params", type: "jsonb" })
  requestParams!: Record<string, any>;

  @Column({ name: "response", type: "jsonb", nullable: true })
  response!: Record<string, any> | null;

  @Column({ name: "error", type: "text", nullable: true })
  error!: string | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
