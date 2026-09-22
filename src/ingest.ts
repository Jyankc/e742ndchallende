import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logJob } from "./logging.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { parseFile, type Upload } from "./sources.js";

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

export class UploadError extends Error {
  constructor(public status: number, message: string, public run_id?: string) {
    super(message);
  }
}

type RecordData = ReturnType<typeof parseFile>[number];

const INSERT_BATCH_SIZE = 500;

function recordKey(source: Upload["source"], row: Record<string, unknown>): string {
  switch (source) {
    case "orders": return String(row.order_id);
    case "refunds": return String(row.refund_id);
    case "email_events": return String(row.event_id);
    case "ad_spend": {
      const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date;
      return JSON.stringify([date, row.platform, row.campaign_id]);
    }
  }
}

function assertSameRecord(source: Upload["source"], row: RecordData, existing: Record<string, unknown>, index: number) {
  const fields = Object.entries(row).filter(([field, incoming]) => {
    const stored = existing[field];
    const value = stored instanceof Date
      ? (field === "date" ? stored.toISOString().slice(0, 10) : stored.toISOString())
      : stored instanceof Prisma.Decimal ? stored.toFixed(2) : stored;
    return value !== incoming;
  }).map(([field]) => field);
  const values: Record<string, unknown> = row;
  const key = source === "ad_spend" ? `${values.date}/${values.platform}/${values.campaign_id}` : recordKey(source, row);
  throw new UploadError(409, `Record ${index + 1}: Conflicting record "${key}": different fields [${fields.join(", ")}]. The entire upload was rolled back; existing records were kept.`);
}

export async function insertRecords(
  tx: Prisma.TransactionClient, company_id: string, source: Upload["source"], records: RecordData[],
  onProgress: (processed: number) => void = () => {},
) {
  const prepared = records.map(row => ({ row,
    hash: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
  }));
  // Check the entire file, including duplicate IDs across batch boundaries.
  const seen = new Map<string, typeof prepared[number]>();
  for (const [index, entry] of prepared.entries()) {
    const previous = seen.get(recordKey(source, entry.row));
    if (previous && previous.hash !== entry.hash) assertSameRecord(source, entry.row, previous.row, index);
    seen.set(recordKey(source, entry.row), entry);
  }

  let inserted = 0;
  for (let offset = 0; offset < prepared.length; offset += INSERT_BATCH_SIZE) {
    const batch = prepared.slice(offset, offset + INSERT_BATCH_SIZE);
    const data = batch.map(({ row, hash }) => ({ ...row, company_id, record_hash: hash }));
    let count: number;
    let stored: (Record<string, unknown> & { record_hash: string })[];
    // The saved job source selects both parsing (in the worker) and storage.
    // parseFile(source, ...) has already validated these source-specific shapes.
    switch (source) {
      case "orders": {
        const rows = data as Prisma.OrderCreateManyInput[];
        count = await tx.order.createMany({ data: rows, skipDuplicates: true }).then(result => result.count);
        stored = await tx.order.findMany({ where: { company_id, order_id: { in: rows.map(r => r.order_id) } } });
        break;
      }
      case "refunds": {
        const rows = data as Prisma.RefundCreateManyInput[];
        count = await tx.refund.createMany({ data: rows, skipDuplicates: true }).then(result => result.count);
        stored = await tx.refund.findMany({ where: { company_id, refund_id: { in: rows.map(r => r.refund_id) } } });
        break;
      }
      case "email_events": {
        const rows = data as Prisma.EmailEventCreateManyInput[];
        count = await tx.emailEvent.createMany({ data: rows, skipDuplicates: true }).then(result => result.count);
        stored = await tx.emailEvent.findMany({ where: { company_id, event_id: { in: rows.map(r => r.event_id) } } });
        break;
      }
      case "ad_spend": {
        const rows = (data as Prisma.AdSpendCreateManyInput[])
          .map(row => ({ ...row, date: new Date(String(row.date)) }));
        count = await tx.adSpend.createMany({ data: rows, skipDuplicates: true }).then(result => result.count);
        stored = await tx.adSpend.findMany({ where: { company_id, OR: rows.map(({ date, platform, campaign_id }) => ({ date, platform, campaign_id })) } });
        break;
      }
    }
    // Verify AFTER insertion: a concurrent upload may have inserted the same
    // key. skipDuplicates alone would silently hide differing values.
    const byKey = new Map(stored.map(row => [recordKey(source, row), row]));
    for (const [index, entry] of batch.entries()) {
      const existing = byKey.get(recordKey(source, entry.row));
      if (!existing) throw new Error("Inserted record was not found during verification");
      if (existing.record_hash !== entry.hash) assertSameRecord(source, entry.row, existing, offset + index);
    }
    inserted += count;
    onProgress(offset + batch.length);
  }
  return inserted;
}

export async function ingest(input: Upload, file: Express.Multer.File) {
  const company = await db.company.findUnique({ where: { id: input.company_id }, select: { id: true } });
  if (!company) throw new UploadError(400, "Unknown company_id: register the company before uploading");
  const file_hash = createHash("sha256").update(file.buffer).digest("hex");
  const where = { company_id_source_idempotency_key: {
    company_id: input.company_id, source: input.source, idempotency_key: input.idempotency_key,
  } };
  const existing = await db.ingestionRun.findUnique({ where });
  async function replay(run: NonNullable<typeof existing>) {
    if (run.file_hash !== file_hash) throw new UploadError(409, "Idempotency key already belongs to a different file", run.id);
    const retried = await db.ingestionRun.updateMany({
      where: { id: run.id, status: "failed" },
      data: { status: "pending", error: null, error_code: null, attempt_count: 0,
        next_attempt_at: new Date(), claim_token: null, lease_expires_at: null },
    });
    const current = await db.ingestionRun.findUniqueOrThrow({ where });
    logJob(retried.count ? "job.requeued" : "upload.replayed", current.id, {
      status: current.status, attempt: current.attempt_count,
    });
    return { run_id: current.id, status: current.status, replayed: true };
  }
  // A lost HTTP response never requires writing the file again.
  if (existing) return replay(existing);

  const id = randomUUID();
  const filename = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150) || "upload";
  const directory = path.resolve(process.env.STORAGE_DIR ?? "storage_simulation", input.company_id, input.source);
  const file_path = path.join(directory, `${file_hash}_${filename}`);
  logJob("upload.storing", id, { status: "storing", company_id: input.company_id, source: input.source });
  try {
    await mkdir(directory, { recursive: true });
    try { await writeFile(file_path, file.buffer, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } catch (error) {
    logJob("upload.storage_failed", id, { status: "not_registered", error: (error as Error).message });
    throw new UploadError(500, "File storage failed; no job was registered. Retry the upload.");
  }
  logJob("upload.stored", id, { status: "stored" });
  // For this challenge, successful writes/existing files are assumed complete.
  // The job is registered only AFTER storage succeeds.
  try {
    const created = await db.ingestionRun.createMany({
      data: { id, ...input, file_hash, file_path, status: "pending" }, skipDuplicates: true,
    });
    const run = await db.ingestionRun.findUniqueOrThrow({ where });
    if (!created.count) {
      logJob("upload.matched_existing", run.id, { upload_attempt_id: id, status: run.status });
      return replay(run);
    }
    logJob("job.queued", run.id, { status: "pending", attempt: 0 });
    return { run_id: run.id, status: run.status, replayed: false };
  } catch (error) {
    logJob("upload.registration_failed", id, { error: (error as Error).message });
    throw error;
  }
}
