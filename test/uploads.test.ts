import "dotenv/config";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import request from "supertest";

if (!process.env.TEST_DATABASE_URL || process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a separate, migrated, idle test database; workers claim any pending job.");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { app } = await import("../src/app.js");
const { db } = await import("../src/ingest.js");
const { claimNextRun, processRun, failAttempt } = await import("../src/queue.js");
const prefix = `test_${randomUUID()}_`;
const storage = await mkdtemp(path.join(tmpdir(), "ingestion-test-"));
process.env.STORAGE_DIR = storage;
const header = "order_id,created_at,channel,gross,currency,customer_email\n";
const row = (id: string, amount = "12.50") => `${prefix}${id},2026-01-06T00:00:00Z,direct,${amount},USD,a@example.com\n`;
const upload = (key: string, content: string, source = "orders", company = "northwind") =>
  request(app).post("/uploads").field("company_id", company).field("source", source)
    .field("uploaded_by", "integration-test").field("idempotency_key", prefix + key)
    .attach("file", Buffer.from(content), "batch.csv");
const get = (id: string) => db.ingestionRun.findUniqueOrThrow({ where: { id } });
async function execute(id: string) {
  const claimed = await claimNextRun();
  assert.equal(claimed?.id, id, "Use an otherwise idle test database");
  await processRun(claimed!);
  return get(id);
}
async function ingest(key: string, content: string, source = "orders", company = "northwind") {
  const accepted = await upload(key, content, source, company).expect(202);
  return execute(accepted.body.run_id);
}
after(async () => {
  await db.order.deleteMany({ where: { order_id: { startsWith: prefix } } });
  await db.refund.deleteMany({ where: { refund_id: { startsWith: prefix } } });
  await db.emailEvent.deleteMany({ where: { event_id: { startsWith: prefix } } });
  await db.adSpend.deleteMany({ where: { campaign_id: { startsWith: prefix } } });
  await db.ingestionRun.deleteMany({ where: { idempotency_key: { startsWith: prefix } } });
  await db.$disconnect();
  await rm(storage, { recursive: true, force: true });
});

test("stores before enqueue; pending and completed replays return the original job", async () => {
  const content = header + row("replay");
  const accepted = await upload("replay", content).expect(202);
  const id = accepted.body.run_id;
  const pending = await get(id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.file_hash, createHash("sha256").update(content).digest("hex"));
  assert.equal(await readFile(pending.file_path, "utf8"), content);
  assert.equal(await db.order.count({ where: { order_id: prefix + "replay" } }), 0);
  // Even if storage becomes inaccessible, replay uses the existing registration.
  process.env.STORAGE_DIR = path.join(storage, "not-used");
  try { assert.equal((await upload("replay", content).expect(202)).body.run_id, id); }
  finally { process.env.STORAGE_DIR = storage; }
  const complete = await execute(id);
  assert.equal(complete.status, "completed");
  assert.equal(complete.uploaded_by, "integration-test");
  assert.equal(complete.inserted_count, 1);
  const status = await request(app).post(`/runs/${id}`).send({ company_id: "northwind" }).expect(200);
  assert.equal(status.body.status, "completed");
  assert.equal(status.body.attempt_count, 1);
  assert.equal(status.body.claim_token, undefined);
  assert.equal((await upload("replay", content).expect(200)).body.run_id, id);
  await upload("replay", header + row("replay", "99.00")).expect(409);
  await request(app).post("/runs/not-a-uuid").expect(400);
  await request(app).post(`/runs/${randomUUID()}`).send({ company_id: "northwind" }).expect(404);
});

test("storage failure returns no job and creates no run", async () => {
  const blocker = path.join(storage, "regular-file");
  await writeFile(blocker, "not a directory");
  process.env.STORAGE_DIR = blocker;
  try {
    const response = await upload("storage-failure", header + row("storage-failure")).expect(500);
    assert.equal(response.body.run_id, undefined);
    assert.equal(await db.ingestionRun.count({ where: { idempotency_key: prefix + "storage-failure" } }), 0);
  } finally { process.env.STORAGE_DIR = storage; }
  assert.equal((await ingest("storage-failure", header + row("storage-failure"))).status, "completed");
});

test("simultaneous retries resolve to one job", async () => {
  const responses = await Promise.all([upload("same-key", header + row("same")), upload("same-key", header + row("same"))]);
  assert.deepEqual(responses.map(r => r.status), [202, 202]);
  assert.equal(responses[0].body.run_id, responses[1].body.run_id);
  assert.equal((await execute(responses[0].body.run_id)).inserted_count, 1);
});

test("overlapping exports skip normalized duplicates; conflicts roll back earlier inserts", async () => {
  await ingest("overlap-a", header + row("existing", "12.5"));
  const complete = await ingest("overlap-b", header + row("existing") + row("new"));
  assert.equal(complete.inserted_count, 1);
  assert.equal(complete.duplicate_count, 1);
  const before = await db.order.findUniqueOrThrow({ where: {
    company_id_order_id: { company_id: "northwind", order_id: prefix + "existing" },
  } });
  const failed = await ingest("conflict", header + row("rollback") + row("existing", "99.00"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, 409);
  assert.equal(failed.error, `northwind/orders/batch.csv: Record 2: Conflicting record "${prefix}existing": different fields [gross]. The entire upload was rolled back; existing records were kept.`);
  const after = await db.order.findUniqueOrThrow({ where: {
    company_id_order_id: { company_id: "northwind", order_id: prefix + "existing" },
  } });
  assert.deepEqual(after, before);
  assert.equal(after.gross.toFixed(2), "12.50");
  const response = await request(app).post(`/runs/${failed.id}`).send({ company_id: "northwind" }).expect(200);
  assert.equal(response.body.status, "failed");
  assert.equal(response.body.error_code, 409);
  assert.equal(response.body.error, failed.error);
  assert.equal(await db.order.count({ where: { order_id: prefix + "rollback" } }), 0);
});

test("batch insertion counts duplicates across batches and rolls back earlier batches on conflict", async () => {
  const rows = Array.from({ length: 1100 }, (_, i) => row(`bulk-${i}`));
  const success = await ingest("bulk", header + rows.join("") + rows[0] + rows[500]);
  assert.equal(success.status, "completed");
  assert.equal(success.inserted_count, 1100);
  assert.equal(success.duplicate_count, 2);
  const changed = Array.from({ length: 501 }, (_, i) => row(`bulk-rollback-${i}`));
  const failed = await ingest("bulk-conflict", header + changed.join("") + row("bulk-0", "99.00"));
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /Record 502:.*different fields \[gross\]/);
  assert.equal(await db.order.count({ where: { order_id: { startsWith: prefix + "bulk-rollback-" } } }), 0);
  const original = await db.order.findUniqueOrThrow({ where: {
    company_id_order_id: { company_id: "northwind", order_id: prefix + "bulk-0" },
  } });
  assert.equal(original.gross.toFixed(2), "12.50");
  const internal = await ingest("bulk-internal", header + changed.join("") + row("bulk-rollback-0", "99.00"));
  assert.equal(internal.status, "failed");
  assert.match(internal.error!, /Record 502:.*different fields \[gross\]/);
  assert.equal(await db.order.count({ where: { order_id: { startsWith: prefix + "bulk-rollback-" } } }), 0);
});

test("internal conflicts fail atomically; explicit retries reuse the run and reset attempts", async () => {
  const content = header + row("internal") + row("internal", "99.00");
  const first = await ingest("internal", content);
  assert.equal(first.status, "failed");
  const retry = await upload("internal", content).expect(202);
  assert.equal(retry.body.run_id, first.id);
  assert.equal((await get(first.id)).attempt_count, 0);
  assert.equal((await execute(first.id)).status, "failed");
  assert.equal(await db.order.count({ where: { order_id: prefix + "internal" } }), 0);
});

test("invalid contents fail once; invalid request fields never enqueue", async () => {
  for (const content of [header.replace("gross", "cost_usd") + row("invalid"), header + row("valid-first") + row("invalid", "oops"), header + row("date").replace("2026-01-06", "2026-02-30")]) {
    const failed = await ingest(randomUUID(), content);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error_code, 422);
    assert.equal(failed.attempt_count, 1);
    assert.equal(await claimNextRun(), null);
  }
  assert.equal(await db.order.count({ where: { order_id: prefix + "valid-first" } }), 0);
  await upload("bad-source", header, "invalid").expect(400);
  await upload("bad-company", header, "orders", "../escape").expect(400);
  for (const uploader of [undefined, "   "]) {
    const req = request(app).post("/uploads").field("company_id", "northwind").field("source", "orders")
      .field("idempotency_key", prefix + "no-uploader");
    if (uploader !== undefined) req.field("uploaded_by", uploader);
    await req.attach("file", Buffer.from(header), "batch.csv").expect(400);
  }
  assert.equal(await db.ingestionRun.count({ where: { idempotency_key: { in: ["bad-source", "bad-company", "no-uploader"].map(k => prefix + k) } } }), 0);
});

test("all sources retain schema validation and campaign-scoped spend keys", async () => {
  for (const [source, content] of [
    ["refunds", `refund_id,refunded_at,order_id,amount,currency\n${prefix}refund,2026-01-06T00:00:00Z,unknown,2.50,USD\n`],
    ["email_events", JSON.stringify({ event_id: prefix + "event", type: "open", email: "a@example.com", campaign_id: "c1", occurred_at: "2026-01-06T00:00:00Z" })],
    ["ad_spend", `date,campaign_id,platform,spend\n2026-01-06,${prefix}c1,google,10.00\n2026-01-06,${prefix}c2,google,20.00\n`],
  ]) assert.equal((await ingest(source, content, source)).status, "completed");
  assert.equal((await ingest("bad-json", "{broken", "email_events")).error_code, 422);
  const adHeader = "date,campaign_id,platform,spend\n";
  assert.equal((await ingest("ad-duplicate", adHeader + `2026-01-06,${prefix}c2,google,20.00\n`, "ad_spend")).duplicate_count, 1);
  assert.equal((await ingest("ad-conflict", adHeader + `2026-01-07,${prefix}c1,google,10.00\n2026-01-06,${prefix}c2,google,99.00\n`, "ad_spend")).status, "failed");
  assert.equal(await db.adSpend.count({ where: { campaign_id: { startsWith: prefix } } }), 2);
});

test("file hash reuse is scoped by company and source", async () => {
  const content = header + row("reuse");
  const first = await ingest("reuse-a", content);
  const reused = await ingest("reuse-b", content);
  assert.equal(reused.reused_run_id, first.id);
  assert.equal(reused.inserted_count, 0);
  assert.equal(reused.duplicate_count, 1);
  assert.equal((await ingest("reuse-a", content, "orders", "lumen")).inserted_count, 1);
  assert.equal((await ingest("reuse-source", content, "refunds")).error_code, 422);
});

test("concurrent workers processing overlapping files commit each record once", async () => {
  await upload("parallel-a", header + row("parallel")).expect(202);
  await upload("parallel-b", header + row("parallel")).expect(202);
  const [a, b] = await Promise.all([claimNextRun(), claimNextRun()]);
  assert.ok(a && b && a.id !== b.id);
  await Promise.all([processRun(a), processRun(b)]);
  assert.equal((await get(a.id)).inserted_count + (await get(b.id)).inserted_count, 1);
  assert.equal(await db.order.count({ where: { order_id: prefix + "parallel" } }), 1);
});

test("one claim per job; superseded workers cannot insert or overwrite state", async () => {
  const accepted = await upload("claim", header + row("claim")).expect(202);
  const claims = await Promise.all([claimNextRun(), claimNextRun()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean)!;
  await db.ingestionRun.update({ where: { id: old.id }, data: { lease_expires_at: new Date(0) } });
  const current = await claimNextRun();
  assert.equal(current?.id, accepted.body.run_id);
  assert.notEqual(current?.claim_token, old.claim_token);
  await processRun(old);
  await failAttempt(old, new Error("Old worker must not change the new claim"));
  assert.equal(await db.order.count({ where: { order_id: prefix + "claim" } }), 0);
  assert.equal((await get(old.id)).claim_token, current?.claim_token);
  await processRun(current!);
  assert.equal((await get(old.id)).status, "completed");
});

test("temporary failures back off and stop after three attempts", async () => {
  const accepted = await upload("retry", header + row("retry")).expect(202);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claimed = await claimNextRun();
    assert.equal(claimed?.attempt_count, attempt);
    await failAttempt(claimed!, Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }));
    const run = await get(accepted.body.run_id);
    assert.equal(run.status, attempt < 3 ? "pending" : "failed");
    assert.equal(await claimNextRun(), null);
    if (attempt < 3) await db.ingestionRun.update({ where: { id: run.id }, data: { next_attempt_at: new Date(0) } });
  }
});

test("repeated crashed claims exhaust the attempt budget", async () => {
  const accepted = await upload("exhaust", header + row("exhaust")).expect(202);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await claimNextRun())?.attempt_count, attempt);
    await db.ingestionRun.update({ where: { id: accepted.body.run_id }, data: { lease_expires_at: new Date(0) } });
  }
  assert.equal((await claimNextRun())?.status, "failed");
  assert.equal(await claimNextRun(), null);
});

test("a killed process rolls back partial inserts; recovery and overlapping replay preserve totals", async () => {
  const accepted = await upload("crash", header + row("crash-a") + row("crash-b") + row("crash-c")).expect(202);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { claimNextRun } from './src/queue.ts';
    import { db, insertRecords } from './src/ingest.ts';
    import { parseFile } from './src/sources.ts';
    import { readFile } from 'node:fs/promises';
    const run = await claimNextRun();
    const rows = parseFile(run.source, await readFile(run.file_path));
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT id FROM ingestion_runs WHERE id = $1::uuid FOR UPDATE', run.id);
      await insertRecords(tx, run.company_id, run.source, [rows[0]]);
      console.log('PARTIAL_INSERT');
      await new Promise(resolve => setTimeout(resolve, 60000));
    }, { timeout: 65000 });
  `], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Child never inserted a row")), 10_000);
      let output = "";
      child.stdout.on("data", data => { output += data; if (output.includes("PARTIAL_INSERT")) { clearTimeout(timer); resolve(); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Child exited ${code}`)); });
    });
    assert.equal(await claimNextRun(), null);
  } finally { child.kill("SIGKILL"); await exited; }
  await db.ingestionRun.update({ where: { id: accepted.body.run_id }, data: { lease_expires_at: new Date(0) } });
  assert.equal(await db.order.count({ where: { order_id: { startsWith: prefix + "crash-" } } }), 0);
  const recovered = await execute(accepted.body.run_id);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.inserted_count, 3);
  const overlap = await ingest("crash-overlap", header + row("crash-b") + row("crash-c"));
  assert.equal(overlap.inserted_count, 0);
  assert.equal(overlap.duplicate_count, 2);
  const totals = await db.order.aggregate({ where: { order_id: { startsWith: prefix + "crash-" } }, _sum: { gross: true } });
  assert.equal(totals._sum.gross?.toFixed(2), "37.50");
});

test("standalone worker completes queued work and emits run-correlated lifecycle logs", async () => {
  const accepted = await upload("worker", header + row("worker")).expect(202);
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 10_000;
    while ((await get(accepted.body.run_id)).status !== "completed" && Date.now() < deadline) await sleep(50);
    assert.equal((await get(accepted.body.run_id)).status, "completed");
  } finally { child.kill("SIGTERM"); await exited; }
  const entries = output.trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const events = entries.filter(e => e.run_id === accepted.body.run_id).map(e => e.event);
  for (const event of ["job.claimed", "job.reading_file", "job.validating", "job.validated", "job.inserting", "job.progress", "job.completed"]) assert.ok(events.includes(event), event);
  assert.equal(entries.find(e => e.event === "job.completed").inserted, 1);
  assert.ok(entries.some(e => e.event === "worker.stopped"));
});


test("company configuration enables a third tenant and run lookup requires its company", async () => {
  const company = prefix + "third";
  const content = header + row("tenant-shared");
  await upload("third", content, "orders", company).expect(400);
  await db.company.create({ data: { id: company, name: "Third client" } });
  try {
    const third = await ingest("third", content, "orders", company);
    const northwind = await ingest("third", content);
    assert.equal(third.inserted_count, 1);
    assert.equal(northwind.inserted_count, 1);
    assert.notEqual(third.id, northwind.id);
    await request(app).post(`/runs/${third.id}`).expect(400);
    await request(app).post(`/runs/${third.id}`).query({ company_id: company }).expect(400);
    await request(app).post(`/runs/${third.id}`).send({ company_id: 123 }).expect(400);
    await request(app).post(`/runs/${third.id}`).set("Content-Type", "application/json").send("{broken").expect(400);
    await request(app).get(`/runs/${third.id}`).query({ company_id: company }).expect(404);
    await request(app).post(`/runs/${third.id}`).send({ company_id: "northwind" }).expect(404);
    await request(app).post(`/runs/${third.id}`).send({ company_id: "unknown" }).expect(404);
    await request(app).post(`/runs/${northwind.id}`).send({ company_id: company }).expect(404);
    const own = await request(app).post(`/runs/${third.id}`).send({ company_id: company }).expect(200);
    assert.equal(own.body.company_id, company);
    await assert.rejects(db.company.delete({ where: { id: company } }), { code: "P2003" });
  } finally {
    await db.order.deleteMany({ where: { company_id: company } });
    await db.ingestionRun.deleteMany({ where: { company_id: company } });
    await db.company.delete({ where: { id: company } });
  }
});

test("database rejects runs referencing an unregistered company", async () => {
  await assert.rejects(db.ingestionRun.create({ data: {
    company_id: prefix + "unknown", source: "orders", idempotency_key: prefix + "invalid-company",
    file_path: "unused", file_hash: "unused",
  } }), { code: "P2003" });
});


test("lists configured company IDs and names, including newly registered companies", async () => {
  const company = { id: prefix + "listed", name: "Listed Client" };
  await db.company.create({ data: company });
  try {
    const response = await request(app).get("/companies").expect(200);
    assert.ok(response.body.some((item: { id: string }) => item.id === "northwind"));
    assert.ok(response.body.some((item: { id: string }) => item.id === "lumen"));
    assert.deepEqual(response.body.find((item: { id: string }) => item.id === company.id), company);
    for (const item of response.body) assert.deepEqual(Object.keys(item).sort(), ["id", "name"]);
  } finally { await db.company.delete({ where: { id: company.id } }); }
});


test("reset script clears jobs and all source tables and recreates exactly two companies", async () => {
  await db.company.create({ data: { id: prefix + "reset-extra", name: "Remove me" } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/reset-companies.ts"], {
      env: process.env, timeout: 10_000,
    });
    assert.deepEqual(await db.company.findMany({ orderBy: { id: "asc" } }), [
      { id: "lumen", name: "Lumen" }, { id: "northwind", name: "Northwind" },
    ]);
    assert.deepEqual(await Promise.all([
      db.ingestionRun.count(), db.order.count(), db.refund.count(), db.emailEvent.count(), db.adSpend.count(),
    ]), [0, 0, 0, 0, 0]);
  }
});
