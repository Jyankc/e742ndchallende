# Challenge 2 ingestion

A small Express service using TypeScript, Prisma, Zod, and Postgres. One upload request saves the original file, validates every record, and inserts the whole file in a database transaction. There is no authentication.

## Run locally

Requires Node.js 22.12+ and Docker Compose (or an existing Postgres database).

```sh
cd challenge_2
cp .env.example .env
npm ci
docker compose up -d
# Wait until Postgres is accepting connections.
npm run generate
npm run db:migrate
npm run dev
```

If using an existing Postgres database, set `DATABASE_URL` in `.env` and skip Docker. For a compiled build, run `npm run build` followed by `npm start`.

```sh
curl http://localhost:3000/uploads \
  -F company_id=northwind \
  -F source=orders \
  -F idempotency_key=northwind-orders-batch-01 \
  -F file=@deep-dive-fixtures/northwind/orders/batch_01.csv
```

`source` is `orders`, `refunds`, `email_events`, or `ad_spend`. Email events use NDJSON; the other sources use CSV. The request has exactly these three text fields and one `file`, limited to 10 MiB. Company IDs allow letters, numbers, underscores, and hyphens.

A successful response contains `run_id`, `inserted`, `duplicates`, and `replayed`. Reusing a completed upload key with identical bytes returns its original counts. A different file with the same key returns 409. Invalid requests return 400, invalid file content returns 422, conflicting records return 409, and processing errors return 500.

## Current behavior

- Original files live at `storage_simulation/<company_id>/<source>/<sha256>_<filename>`. The hash prefix prevents different files with the same original name from overwriting each other. Failed files are retained.
- `ingestion_runs` stores the upload key, file hash, path, status, counts, and failure reason. Keys are unique per company and source. Failed uploads can be retried with the same key and identical bytes; corrected files need a new key.
- Fixed headers must match exactly, although their order may differ. Missing, extra, renamed, or duplicate columns fail the file. NDJSON objects likewise reject unknown or missing fields.
- Zod validates all records before any source rows are inserted. Amounts are nonnegative decimals with at most two decimal places; currencies are three uppercase letters. Timestamps, dates, and emails are validated. Amounts and timestamps are normalized before comparison.
- Each source has its own table. Order, refund, and email keys use their respective IDs. Ad spend uses date + platform. Every key also includes company ID.
- Identical records are ignored, even across different upload keys. Different content with the same record key fails the entire transaction, including any earlier inserts from that file. Completing the run is part of the same transaction.
- Refunds can be stored before their orders; there is no foreign key to orders at this ingestion stage.

## Deliberate limits of this first step

Ad spend fixtures are per campaign, but the current agreed key is date + platform. Multiple campaigns on the same date and platform therefore conflict and fail the upload. We have not changed that decision or aggregated campaigns implicitly.

There is no queue, background retry, reporting model, reconciliation, missing-file monitoring, or authentication. Company-scoped keys are not access control.

A process crash may leave a run in `processing`. Automatic crash recovery is not implemented. After verifying the old worker has stopped, an operator can mark that run failed and retry the same upload. Filesystem writes and database writes are not atomic together: a failure before run creation can leave an unreferenced file. Transaction failures roll back source rows; recording a failure also requires the database to be available.

The whole file is held in memory, and records are inserted sequentially inside a transaction with a 60-second timeout. This is intentionally a small starting implementation.

## Tests

With the schema migrated and `DATABASE_URL` configured:

```sh
npm run build
npm test
```

Tests exercise the HTTP endpoint against real Postgres. They create uniquely named test companies and temporary file storage, then remove their own data. Coverage includes replay, overlapping files, conflicts and rollback, validation, all four formats, and concurrent duplicates.

The npm overrides pin Prisma's transitive `deepmerge-ts` and `mysql2` dependencies to patched versions. Recheck these overrides when upgrading Prisma; remove them once Prisma supplies patched versions itself.
