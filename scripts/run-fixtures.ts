import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import request from "supertest";
import { app } from "../src/app.js";
import { db } from "../src/ingest.js";

const root = path.resolve("deep-dive-fixtures");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const results: Record<string, unknown>[] = [];

try {
  for (const batch of manifest.batches) {
    let file: Buffer;
    try { file = await readFile(path.join(root, batch.path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      results.push({ file: batch.path, status: "missing" });
      console.log(`MISSING ${batch.path}`);
      continue;
    }
    // Exercise the real HTTP handler without needing a separate server process.
    const response = await request(app).post("/uploads")
      .field("company_id", batch.tenant)
      .field("source", batch.source)
      .field("uploaded_by", "fixture-runner")
      .field("idempotency_key", `fixture:${batch.path}`)
      .attach("file", file, path.basename(batch.path));
    let result = response.body;
    if (response.status === 202 || response.status === 200) {
      const deadline = Date.now() + 300_000;
      while (true) {
        const status = await request(app).post(`/runs/${response.body.run_id}`).send({ company_id: batch.tenant });
        if (status.status !== 200) throw new Error(`Status lookup failed: ${status.status}`);
        result = status.body;
        if (result.status === "completed" || result.status === "failed") break;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${response.body.run_id}; start npm run worker against the same database`);
        await sleep(250);
      }
    }
    results.push({ file: batch.path, http_status: response.status, ...result });
    console.log(`${result.status ?? response.status} ${batch.path}: ${result.error ?? JSON.stringify(result)}`);
  }
  await writeFile("fixture-results.json", JSON.stringify({
    executed_at: new Date().toISOString(),
    note: "Uses the existing database. Replayed counts describe the original upload, not new inserts. Finance summaries are reconciliation references, not upload sources.",
    results,
  }, null, 2) + "\n");
  console.log("Saved fixture-results.json");
  if (results.some((result) => Number(result.http_status) >= 500 || Number(result.error_code) >= 500)) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
