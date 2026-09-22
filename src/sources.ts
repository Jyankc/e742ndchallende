import { parse } from "csv-parse/sync";
import { z } from "zod";

export const uploadSchema = z.strictObject({
  company_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  source: z.enum(["orders", "refunds", "email_events", "ad_spend"]),
  idempotency_key: z.string().min(1).max(200),
});
export type Upload = z.infer<typeof uploadSchema>;

const text = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
  });
const currency = z.string().regex(/^[A-Z]{3}$/);

export const schemas = {
  orders: z.strictObject({
    order_id: text, created_at: timestamp, channel: text, gross: money,
    currency, customer_email: z.email(),
  }),
  refunds: z.strictObject({
    refund_id: text, refunded_at: timestamp, order_id: text, amount: money, currency,
  }),
  email_events: z.strictObject({
    event_id: text, type: text, email: z.email(), campaign_id: text, occurred_at: timestamp,
  }),
  ad_spend: z.strictObject({
    date: z.iso.date(), campaign_id: text, platform: text, spend: money,
  }),
};

export function parseFile(source: Upload["source"], buffer: Buffer) {
  const schema = schemas[source];
  const content = buffer.toString("utf8").replace(/^\uFEFF/, "");
  let records: unknown[];
  if (source === "email_events") {
    records = content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`Invalid JSON at record ${index + 1}`); }
    });
  } else {
    records = parse(content, {
      skip_empty_lines: true,
      columns: (headers: string[]) => {
        const expected = Object.keys(schema.shape);
        if (headers.length !== expected.length || new Set(headers).size !== headers.length ||
            headers.some((header) => !expected.includes(header))) {
          throw new Error(`Invalid headers. Expected: ${expected.join(",")}; received: ${headers.join(",")}`);
        }
        return headers;
      },
    });
  }
  if (!records.length) throw new Error("File contains no records");
  return records.map((record, index) => {
    const result = schema.safeParse(record);
    if (!result.success) throw new Error(`Invalid record ${index + 1}: ${result.error.message}`);
    return result.data;
  });
}
