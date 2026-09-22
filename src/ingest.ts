import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "./generated/prisma/client.js";
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

// INSERT ... ON CONFLICT DO NOTHING handles concurrent duplicates. Then compare
// the stored content: a different record with the same key aborts the transaction.
async function insertRecord(tx: Prisma.TransactionClient, company_id: string, row: RecordData) {
  const record_hash = createHash("sha256").update(JSON.stringify(row)).digest("hex");
  const shared = { company_id, record_hash };
  let inserted: { count: number };
  let existing: { record_hash: string };
  let key: string;
  if ("gross" in row) {
    key = row.order_id;
    inserted = await tx.order.createMany({ data: { ...row, ...shared }, skipDuplicates: true });
    existing = await tx.order.findUniqueOrThrow({
      where: { company_id_order_id: { company_id, order_id: row.order_id } },
      select: { record_hash: true },
    });
  } else if ("refund_id" in row) {
    key = row.refund_id;
    inserted = await tx.refund.createMany({ data: { ...row, ...shared }, skipDuplicates: true });
    existing = await tx.refund.findUniqueOrThrow({
      where: { company_id_refund_id: { company_id, refund_id: row.refund_id } },
      select: { record_hash: true },
    });
  } else if ("event_id" in row) {
    key = row.event_id;
    inserted = await tx.emailEvent.createMany({ data: { ...row, ...shared }, skipDuplicates: true });
    existing = await tx.emailEvent.findUniqueOrThrow({
      where: { company_id_event_id: { company_id, event_id: row.event_id } },
      select: { record_hash: true },
    });
  } else {
    const date = new Date(`${row.date}T00:00:00.000Z`);
    key = `${row.date}/${row.platform}`;
    inserted = await tx.adSpend.createMany({ data: { ...row, ...shared, date }, skipDuplicates: true });
    existing = await tx.adSpend.findUniqueOrThrow({
      where: { company_id_date_platform: { company_id, date, platform: row.platform } },
      select: { record_hash: true },
    });
  }
  if (existing.record_hash !== record_hash) throw new UploadError(409, `Conflicting record: ${key}`);
  return inserted.count;
}

export async function ingest(input: Upload, file: Express.Multer.File) {
  const file_hash = createHash("sha256").update(file.buffer).digest("hex");
  const filename = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150) || "upload";
  const directory = path.resolve(process.env.STORAGE_DIR ?? "storage_simulation", input.company_id, input.source);
  const file_path = path.join(directory, `${file_hash}_${filename}`);
  await mkdir(directory, { recursive: true });
  try { await writeFile(file_path, file.buffer, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }

  const id = randomUUID();
  const claimed = await db.ingestionRun.createMany({
    data: { id, ...input, file_hash, file_path }, skipDuplicates: true,
  });
  let run = await db.ingestionRun.findUniqueOrThrow({
    where: { company_id_source_idempotency_key: input },
  });
  if (!claimed.count) {
    if (run.file_hash !== file_hash) throw new UploadError(409, "Idempotency key already belongs to a different file", run.id);
    if (run.status === "completed") return { run_id: run.id, inserted: run.inserted_count, duplicates: run.duplicate_count, replayed: true };
    if (run.status === "processing") throw new UploadError(409, "This upload is already processing", run.id);
    const retry = await db.ingestionRun.updateMany({
      where: { id: run.id, status: "failed" }, data: { status: "processing", error: null },
    });
    if (!retry.count) throw new UploadError(409, "Another request already retried this upload", run.id);
  }

  try {
    let records: RecordData[];
    try { records = parseFile(input.source, file.buffer); }
    catch (error) { throw new UploadError(422, (error as Error).message); }
    const counts = await db.$transaction(async (tx) => {
      let inserted = 0;
      for (const row of records) inserted += await insertRecord(tx, input.company_id, row);
      const duplicates = records.length - inserted;
      await tx.ingestionRun.update({
        where: { id: run.id },
        data: { status: "completed", inserted_count: inserted, duplicate_count: duplicates, error: null },
      });
      return { inserted, duplicates };
    }, { timeout: 60_000 });
    return { run_id: run.id, ...counts, replayed: false };
  } catch (error) {
    // The source transaction has rolled back. Record the failure separately.
    await db.ingestionRun.update({
      where: { id: run.id }, data: { status: "failed", error: (error as Error).message },
    });
    if (error instanceof UploadError) { error.run_id = run.id; throw error; }
    throw new UploadError(500, "Processing failed; retry this upload with the same key", run.id);
  }
}
