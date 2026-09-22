-- Earlier uploads have no known uploader. New requests require uploaded_by.
ALTER TABLE "ingestion_runs" ADD COLUMN "uploaded_by" TEXT;
