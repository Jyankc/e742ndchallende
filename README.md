# Challenge 2

I focused on ingestion, replay, and running the same code for different companies. The service saves the original files, processes them in a worker, and keeps the status of each run in Postgres.

The reporting part is not built. There is no daily revenue API, finance reconciliation, or weekly board report. The decisions and remaining work are in [TRADEOFFS.md](TRADEOFFS.md).

## Run it

You need Docker with Compose. No local Node.js install is needed.

From the `challenge_2` directory:

```sh
docker compose up --build -d
```

This starts Postgres, runs migrations, and starts the API and worker. The two fixture companies are added by the migration. The API runs at `http://localhost:3000`.

```sh
# See API and worker logs
docker compose logs -f api worker

# Stop everything, keeping database data and uploaded files
docker compose down
```

Uploads are saved in `storage_simulation`, shared by the API and worker. Database data stays in a Docker volume. After changing code, run the build command again. Stop any old API or worker running outside Docker first.

## Upload a file

```sh
curl http://localhost:3000/uploads \
  -F company_id=northwind \
  -F source=orders \
  -F uploaded_by=Juan \
  -F idempotency_key=northwind-orders-01 \
  -F file=@deep-dive-fixtures/northwind/orders/batch_01.csv
```

Sources are `orders`, `refunds`, `email_events`, and `ad_spend`. Email events use NDJSON. The others use CSV. All four text fields and the file are required. The file limit is 10 MiB.

In Postman, use **POST → Body → form-data** for uploads.

A new upload returns HTTP 202:

```json
{"run_id":"...","status":"pending","replayed":false}
```

This means the file is saved and the job is queued. It does not mean the records passed validation.

## Check a run

```sh
curl -X POST http://localhost:3000/runs/YOUR_RUN_ID \
  -H 'Content-Type: application/json' \
  -d '{"company_id":"northwind"}'
```

In Postman, use **POST → Body → raw → JSON** here, not form-data.

The response includes status, attempt count, inserted rows, duplicate rows, and any error. HTTP 200 means the lookup worked; the job itself can still have `status: "failed"`. Missing company ID returns 400. A run that does not belong to the supplied company returns 404.

Logs include the run ID so you can follow it from upload to completion. Progress logs are not committed results; only `job.completed` confirms the transaction finished.

## How processing works

1. Validate the request and check the company exists.
2. If the upload key already exists, check the file hash and return the same run.
3. Save the file. Only after that succeeds, register the job.
4. The worker uses the source saved on the job to select the validation schema and destination table, and inserts up to 500 records per batch. It checks stored hashes after each batch so conflicts cannot be silently skipped.
5. Save the records and mark the run completed in the same transaction.

The worker checks Postgres every two seconds when idle. It processes one file at a time. If it crashes, another attempt can claim the job after its two-minute lease expires. There are at most three automatic attempts. Temporary failures retry; invalid data fails immediately. Resubmitting a failed upload with the same key and bytes requeues it.

| Situation | What happens |
|---|---|
| Same upload key and same file | Return the same run |
| Same upload key and different file | Reject with HTTP 409 |
| New key and a file already completed | Create a run and reuse the earlier result |
| Overlapping files with identical records | Skip those records |
| Same record ID with changed values | Fail the whole file and keep existing data |

Upload keys and duplicate checks include company and source. A corrected file needs a new upload key. Completed file reuse assumes its source records have not been deleted separately.

## Add another company

List companies:

```sh
curl http://localhost:3000/companies
```

Add one configuration record:

```sh
docker compose exec postgres psql -U ingestion -d ingestion \
  -c "INSERT INTO companies (id, name) VALUES ('third_client', 'Third Client');"
```

Then use `third_client` as the company ID. No new models or processing code are needed. IDs can contain letters, numbers, underscores, and hyphens, up to 100 characters.

Authentication is simplified for this challenge: the caller supplies the company ID. We check it and use it to scope the request, but we do not verify that the caller belongs to that company. `uploaded_by` is also caller-supplied.

## Run the fixtures

With the stack running:

```sh
docker compose exec api npm run fixtures
docker compose cp api:/app/fixture-results.json ./fixture-results.json
```

The script reads the manifest, submits each available file through the API handler, and waits for the worker. Re-running it reuses the same upload keys.

The fixture run produced:

- 35 completed files.
- 4 failed ad-spend files: batches 04 and 05 for both companies use `cost_usd` instead of `spend`.
- 1 missing file: `lumen/ad_spend/batch_03.csv`.
- 14 duplicate orders skipped in Northwind batch 03.

Missing files are recorded in the fixture report. They do not create a job or trigger an alert. `finance_summary.csv` is not ingested or reconciled.

## Tests

Use a separate, idle test database. The reset test deletes its data, and queue tests can claim any pending job in that database.

Create it once:

```sh
docker compose exec postgres createdb -U ingestion ingestion_worker_test
```

Then migrate and run the tests:

```sh
docker compose exec \
  -e DATABASE_URL=postgresql://ingestion:ingestion@postgres:5432/ingestion_worker_test \
  api npm run db:migrate

docker compose exec \
  -e TEST_DATABASE_URL=postgresql://ingestion:ingestion@postgres:5432/ingestion_worker_test \
  api npm test
```

Tests cover replay, overlapping files, conflicts, rollback after a killed process, validation, competing workers, company scoping, and the reset script.

## Reset the data

This deletes **all jobs, orders, refunds, email events, ad spend, and companies**, then inserts Northwind and Lumen again. It keeps the schema and files on disk.

```sh
docker compose stop api worker
docker compose run --rm --no-deps api npm run reset:companies
docker compose up -d api worker
```
