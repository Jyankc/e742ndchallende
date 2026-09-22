ALTER TABLE ingestion_runs
  ALTER COLUMN status SET DEFAULT 'pending',
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_expires_at timestamptz(3),
  ADD COLUMN next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  ADD COLUMN error_code integer;
CREATE INDEX ingestion_runs_status_next_attempt_at_created_at_idx ON ingestion_runs (status, next_attempt_at, created_at);
CREATE INDEX ingestion_runs_status_lease_expires_at_idx ON ingestion_runs (status, lease_expires_at);
-- Stop the old synchronous API before migrating. Its abandoned runs can now retry.
UPDATE ingestion_runs SET status = 'pending', updated_at = now() WHERE status = 'processing';
