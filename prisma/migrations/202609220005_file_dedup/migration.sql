ALTER TABLE "ingestion_runs" ADD COLUMN "reused_run_id" UUID;
CREATE INDEX "ingestion_runs_company_id_source_file_hash_status_idx"
    ON "ingestion_runs"("company_id", "source", "file_hash", "status");
