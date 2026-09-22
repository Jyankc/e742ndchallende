export function logJob(event: string, run_id: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, run_id, ...details }));
}
