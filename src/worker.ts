import { setTimeout as sleep } from "node:timers/promises";
import { db } from "./ingest.js";
import { claimNextRun, processRun } from "./queue.js";

let stopping = false;
const idle = new AbortController();
const log = (event: string, details: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, pid: process.pid, ...details }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { stopping = true; idle.abort(); log("worker.stopping", { signal }); });
}
log("worker.started");
try {
  while (!stopping) {
    let run;
    try {
      run = await claimNextRun();
      if (run) await processRun(run);
    } catch (error) {
      log("worker.error", { ...(run ? { run_id: run.id } : {}), error: (error as Error).message });
      run = null;
    }
    if (!run && !stopping) await sleep(2_000, undefined, { signal: idle.signal }).catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
  }
} finally {
  await db.$disconnect();
  log("worker.stopped");
}
