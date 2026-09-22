import { db } from "../src/ingest.js";

try {
  const result = await db.$transaction(async (tx) => {
    // Delete referencing rows first; retain schema, migrations, and stored files.
    const runs = await tx.ingestionRun.deleteMany();
    const orders = await tx.order.deleteMany();
    const refunds = await tx.refund.deleteMany();
    const events = await tx.emailEvent.deleteMany();
    const spend = await tx.adSpend.deleteMany();
    const companies = await tx.company.deleteMany();
    await tx.company.createMany({ data: [
      { id: "northwind", name: "Northwind" },
      { id: "lumen", name: "Lumen" },
    ] });
    return { deleted: {
      ingestion_runs: runs.count, orders: orders.count, refunds: refunds.count,
      email_events: events.count, ad_spend: spend.count, companies: companies.count,
    }, companies: await tx.company.findMany({ orderBy: { id: "asc" } }) };
  }, { timeout: 30_000 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("Company reset failed; the transaction was rolled back.", error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
