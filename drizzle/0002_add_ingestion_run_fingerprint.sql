ALTER TABLE "ingestion_run" DROP CONSTRAINT "ingestion_run_status_check";--> statement-breakpoint
ALTER TABLE "ingestion_run" ADD COLUMN "key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "ingestion_run" ADD COLUMN "environment_name" text;--> statement-breakpoint
CREATE INDEX "ingestion_run_key_fingerprint_idx" ON "ingestion_run" USING btree ("key_fingerprint");--> statement-breakpoint
ALTER TABLE "ingestion_run" ADD CONSTRAINT "ingestion_run_status_check" CHECK ("ingestion_run"."status" in ('running', 'success', 'partial', 'failed', 'skipped_budget', 'skipped_circuit'));