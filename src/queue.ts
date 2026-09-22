import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IngestionRun, Prisma } from "./generated/prisma/client.js";
import { db, insertRecords, UploadError } from "./ingest.js";
import { parseFile } from "./sources.js";
import { logJob } from "./logging.js";

const MAX_ATTEMPTS = 3;
class LostClaim extends Error {}

export async function claimNextRun(): Promise<IngestionRun | null> {
  // Optimistic claiming: competing workers may read the same candidate, but
  // only one can update the exact state/token it observed. Losers try again.
  for (let contention = 0; contention < 5; contention++) {
    const now = new Date();
    const eligible: Prisma.IngestionRunWhereInput = { OR: [
      { status: "pending", next_attempt_at: { lte: now } },
      { status: "processing", lease_expires_at: { lte: now } },
    ] };
    const candidate = await db.ingestionRun.findFirst({
      where: eligible, orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });
    if (!candidate) return null;
    const exhausted = candidate.attempt_count >= MAX_ATTEMPTS;
    const [run] = await db.ingestionRun.updateManyAndReturn({
      where: {
        ...eligible, id: candidate.id, status: candidate.status,
        claim_token: candidate.claim_token, attempt_count: candidate.attempt_count,
      },
      data: {
        status: exhausted ? "failed" : "processing",
        claim_token: exhausted ? null : randomUUID(),
        attempt_count: { increment: exhausted ? 0 : 1 },
        lease_expires_at: exhausted ? null : new Date(Date.now() + 120_000),
        error: exhausted ? "Worker lease expired; attempt limit reached" : null,
        error_code: exhausted ? 500 : null,
      },
    });
    if (!run) continue;
    logJob(run.status === "failed" ? "job.failed" : "job.claimed", run.id, {
      status: run.status, attempt: run.attempt_count,
      lease_expires_at: run.lease_expires_at, error: run.error,
    });
    return run;
  }
  return null;
}

function isTransient(error: unknown): boolean {
  const codes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "P1001", "P1002", "P1008", "P1017", "P2024", "P2034", "40001", "40P01", "57P01", "08006"]);
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as { code?: string; cause?: unknown; meta?: { code?: string; driverAdapterError?: unknown } };
    if (codes.has(e.code ?? "") || codes.has(e.meta?.code ?? "")) return true;
    current = e.cause ?? e.meta?.driverAdapterError;
  }
  return false;
}

export async function failAttempt(run: IngestionRun, error: unknown) {
  const retry = isTransient(error) && run.attempt_count < MAX_ATTEMPTS;
  const message = `${run.company_id}/${run.source}/${path.basename(run.file_path).slice(65)}: ${(error as Error).message}`;
  const next_attempt_at = new Date(Date.now() + run.attempt_count * 5_000);
  const updated = await db.ingestionRun.updateMany({
    where: { id: run.id, status: "processing", claim_token: run.claim_token },
    data: { status: retry ? "pending" : "failed", error: message,
      error_code: error instanceof UploadError ? error.status : 500,
      claim_token: null, lease_expires_at: null, next_attempt_at },
  });
  logJob(updated.count ? (retry ? "job.retry_scheduled" : "job.failed") : "job.claim_lost", run.id, {
    attempt: run.attempt_count, ...(updated.count ? { status: retry ? "pending" : "failed", error: message,
      ...(retry ? { next_attempt_at } : {}) } : {}),
  });
}

export async function processRun(run: IngestionRun) {
  if (run.status !== "processing") return;
  const started = Date.now();
  const log = (event: string, details: Record<string, unknown> = {}) =>
    logJob(event, run.id, { attempt: run.attempt_count, status: "processing", ...details });
  try {
    log("job.reading_file");
    // Resolve against shared storage so uploads made on the host remain usable
    // after moving the worker into a container with a different absolute path.
    const filePath = path.join(path.resolve(process.env.STORAGE_DIR ?? "storage_simulation"),
      run.company_id, run.source, path.basename(run.file_path));
    const buffer = await readFile(filePath);
    if (createHash("sha256").update(buffer).digest("hex") !== run.file_hash) {
      throw new UploadError(422, "Stored file hash does not match the upload");
    }
    const completed = await db.ingestionRun.findFirst({ where: {
      company_id: run.company_id, source: run.source, file_hash: run.file_hash, status: "completed",
    }, orderBy: { created_at: "asc" } });
    let records: ReturnType<typeof parseFile> = [];
    if (!completed) {
      log("job.validating");
      try { records = parseFile(run.source, buffer); }
      catch (error) { throw new UploadError(422, (error as Error).message); }
      log("job.validated", { records: records.length });
    }
    const counts = await db.$transaction(async (tx) => {
      // A guarded update acquires the row lock until this transaction ends.
      const owns = await tx.ingestionRun.updateMany({
        where: { id: run.id, status: "processing", claim_token: run.claim_token,
          lease_expires_at: { gt: new Date() } },
        data: { claim_token: run.claim_token },
      });
      if (!owns.count) throw new LostClaim();
      let inserted = 0;
      if (completed) {
        log("job.file_reused", { reused_run_id: completed.id });
      } else {
        log("job.inserting", { records: records.length });
        inserted = await insertRecords(tx, run.company_id, run.source, records, processed => {
          log("job.progress", { processed, total: records.length, committed: false });
        });
      }
      const duplicates = completed ? completed.inserted_count + completed.duplicate_count : records.length - inserted;
      // A lease may have elapsed while parsing/inserting. Roll back instead of
      // letting an expired worker commit. The row stays locked until commit.
      const updated = await tx.ingestionRun.updateMany({
        where: { id: run.id, status: "processing", claim_token: run.claim_token,
          lease_expires_at: { gt: new Date() } },
        data: { status: "completed", inserted_count: inserted,
          duplicate_count: duplicates, reused_run_id: completed?.id ?? null,
          error: null, error_code: null, claim_token: null, lease_expires_at: null },
      });
      if (!updated.count) throw new LostClaim();
      return { inserted, duplicates, reused_run_id: completed?.id ?? null };
    }, { timeout: 60_000 });
    log("job.completed", { status: "completed", ...counts, duration_ms: Date.now() - started });
  } catch (error) {
    if (error instanceof LostClaim) { log("job.claim_lost", { status: "claim_lost" }); return; }
    await failAttempt(run, error);
  }
}
