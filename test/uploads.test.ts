import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { app } from "../src/app.js";
import { db } from "../src/ingest.js";

const company_id = `test_${randomUUID()}`;
const storage = await mkdtemp(path.join(tmpdir(), "ingestion-test-"));
process.env.STORAGE_DIR = storage;
const header = "order_id,created_at,channel,gross,currency,customer_email\n";
const order = (id: string, gross = "12.50") => `${id},2026-01-06T00:28:00Z,direct,${gross},USD,a@example.com\n`;
const upload = (key: string, content: string, source = "orders", company = company_id) =>
  request(app).post("/uploads").field("company_id", company).field("source", source)
    .field("idempotency_key", key).attach("file", Buffer.from(content), "batch.csv");

after(async () => {
  for (const company of [company_id, `${company_id}_other`]) {
    await db.order.deleteMany({ where: { company_id: company } });
    await db.refund.deleteMany({ where: { company_id: company } });
    await db.emailEvent.deleteMany({ where: { company_id: company } });
    await db.adSpend.deleteMany({ where: { company_id: company } });
    await db.ingestionRun.deleteMany({ where: { company_id: company } });
  }
  await db.$disconnect();
  await rm(storage, { recursive: true, force: true });
});

test("stores the file and returns the same result for an upload replay", async () => {
  const content = header + order("replay");
  const first = await upload("replay", content).expect(200);
  assert.equal(first.body.inserted, 1);
  const second = await upload("replay", content).expect(200);
  assert.equal(second.body.run_id, first.body.run_id);
  assert.equal(second.body.replayed, true);
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: first.body.run_id } });
  assert.equal(run.status, "completed");
  assert.equal(run.file_hash, createHash("sha256").update(content).digest("hex"));
  assert.equal(await readFile(run.file_path, "utf8"), content);
  await upload("replay", header + order("replay", "99.00")).expect(409);
});

test("overlapping uploads ignore identical records, including normalized money", async () => {
  await upload("overlap-1", header + order("overlap-a", "12.5")).expect(200);
  const response = await upload("overlap-2", header + order("overlap-a") + order("overlap-b")).expect(200);
  assert.equal(response.body.inserted, 1);
  assert.equal(response.body.duplicates, 1);
});

test("a conflicting later row rolls back the entire file", async () => {
  await upload("conflict-base", header + order("existing")).expect(200);
  const response = await upload("conflict", header + order("must-rollback") + order("existing", "99.00")).expect(409);
  assert.equal(await db.order.count({ where: { company_id, order_id: "must-rollback" } }), 0);
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: response.body.run_id } });
  assert.equal(run.status, "failed");
  assert.match(run.error!, /Conflicting record/);
});

test("conflicts inside one file also roll back; failed runs can be retried", async () => {
  const content = header + order("internal") + order("internal", "99.00");
  const first = await upload("internal", content).expect(409);
  const retry = await upload("internal", content).expect(409);
  assert.equal(first.body.run_id, retry.body.run_id);
  assert.equal(await db.order.count({ where: { company_id, order_id: "internal" } }), 0);
});

test("invalid headers or row values fail before inserting any records", async () => {
  for (const [key, content] of [
    ["drift", header.replace("gross", "total") + order("bad-header")],
    ["bad-money", header + order("valid-first") + order("bad-money", "oops")],
    ["bad-date", header + order("bad-date").replace("2026-01-06", "2026-02-30")],
  ]) {
    const response = await upload(key, content).expect(422);
    const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: response.body.run_id } });
    assert.equal(run.status, "failed");
  }
  assert.equal(await db.order.count({ where: { company_id, order_id: "valid-first" } }), 0);
  await upload("unsafe", header + order("unsafe"), "orders", "../escape").expect(400);
});

test("refunds, NDJSON email events, and ad spend use their fixed schemas", async () => {
  await upload("refund", "refund_id,refunded_at,order_id,amount,currency\nr1,2026-01-06T00:00:00Z,missing-order,2.50,USD\n", "refunds").expect(200);
  const event = JSON.stringify({ event_id: "e1", type: "open", email: "a@example.com", campaign_id: "c1", occurred_at: "2026-01-06T00:00:00Z" });
  await upload("email", event, "email_events").expect(200);
  await upload("bad-json", event + "\n{broken", "email_events").expect(422);
  const adHeader = "date,campaign_id,platform,spend\n";
  await upload("ad", adHeader + "2026-01-06,c1,google,10.00\n", "ad_spend").expect(200);
  await upload("ad-conflict", adHeader + "2026-01-07,c1,google,10.00\n2026-01-06,c2,google,10.00\n", "ad_spend").expect(409);
  assert.equal(await db.adSpend.count({ where: { company_id } }), 1);
});

test("concurrent overlapping uploads insert each record once", async () => {
  const results = await Promise.all([
    upload("concurrent-a", header + order("concurrent")),
    upload("concurrent-b", header + order("concurrent")),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal(results.reduce((count, r) => count + r.body.inserted, 0), 1);
  assert.equal(await db.order.count({ where: { company_id, order_id: "concurrent" } }), 1);
});

test("company is part of both the upload and record keys", async () => {
  await upload("shared-key", header + order("shared-id")).expect(200);
  await upload("shared-key", header + order("shared-id", "99.00"), "orders", `${company_id}_other`).expect(200);
});
