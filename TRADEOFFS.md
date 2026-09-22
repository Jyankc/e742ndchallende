# Tradeoffs

## What I focused on

I focused on ingestion and replay: save the file, register the job, process it safely, and make failures easy to follow.

Original files are kept on disk. Validated records go into Postgres. The staging and reporting layers are not built.

## Replay

Each file runs in one transaction. If the worker dies partway through, its partial inserts roll back and the job can be retried after its lease expires.

The upload key handles request retries. The file hash catches identical files. Company-scoped record keys catch overlapping exports. The fixtures had 14 overlapping orders, which were skipped. 

If the same record ID arrives with changed values, the whole file fails. Existing data stays unchanged, and the error identifies the conflicting fields. I did not implement updates because the materials do not explain which version should win.

## Schema drift

I chose to fail loudly. Later ad-spend batches use `cost_usd` instead of `spend`. They fail with a clear error and no inserted rows.

I did not automatically rename the field because it could mean something different. The original file is kept for review.

## Queue and storage

The worker runs separately and polls Postgres every two seconds when idle. No extra queue service is needed. Prisma conditional updates prevent two workers from winning the same claim, although workers can wait on database locks.

This has limits: a two-minute lease, a 60-second processing transaction, three automatic attempts. Files are held in memory. Rows are inserted in batches of 500, then checked against stored values. All batches share one transaction, so a conflict in a later batch rolls back the earlier ones too.

For this challenge, a successful file write is assumed complete. Storage and job registration are separate operations, so a failed registration can leave a file without a job. Retrying can reuse it.

## Adding another company

Insert its ID and name into `companies`. No new models or client-specific processing code are needed.

Foreign keys require a registered company. Record keys include the company ID, and run lookups require both company and run ID.

Authentication is simplified: the caller supplies the company. That scopes the request, but does not prove they are allowed to access that company. Real authentication still needs to be added.

## Late arrivals and reporting

The client wants exact finance totals and published days that never change. Late data can make those requirements conflict.

A real example: Northwind's January 11 refunds total $45.67 in the early batches. Batch 03 adds a $53.29 refund dated January 11. The total becomes $98.96. If $45.67 was already published, we cannot both keep it unchanged and match the new total.

My proposal is:

- Prepare daily finance figures at end of day for the next day's report, and reconcile them before publication.
- Save each weekly board report as a fixed snapshot with a clear cutoff.
- Keep published numbers unchanged and show late changes as separate prior-period adjustments in a later report.
- Keep checking older dates so discrepancies remain visible.

This reporting proposal is not implemented. A daily cutoff does not guarantee all data has arrived. The client must agree on when a day is final and how adjustments reconcile with finance. Scheduling alone does not solve the conflict.

## What is still missing and Next steps

There is no revenue API, finance reconciliation, or report snapshot system. The currency helper is separate and is not applied during ingestion.   
The finance calculation rules and remaining differences need clear specifcied finance rules to process the information as the clients intend.

The fixture runner reports the missing Lumen ad-spend file, but there is no scheduled missing-source check or alert. Missing data should not become zero spend in a report.

