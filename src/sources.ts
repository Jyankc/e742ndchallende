import { parse } from "csv-parse/sync";
import { z } from "zod";
import { companyIdSchema } from "./companies.js";

export const uploadSchema = z.strictObject({
  company_id: companyIdSchema,
  source: z.enum(["orders", "refunds", "email_events", "ad_spend"]),
  idempotency_key: z.string().min(1).max(200),
  uploaded_by: z.string().trim().min(1, "uploaded_by is required").max(200),
});
export type Upload = z.infer<typeof uploadSchema>;

const text = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, "Expected a nonnegative amount with at most 16 whole digits and 2 decimal places")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
  });
const currency = z.string().regex(/^[A-Z]{3}$/, "Expected a three-letter uppercase currency code, such as USD or EUR");

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
          const missing = expected.filter((header) => !headers.includes(header));
          const unexpected = headers.filter((header) => !expected.includes(header));
          const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
          throw new Error(`Invalid headers: missing [${missing.join(", ")}]; unexpected [${unexpected.join(", ")}]; repeated [${duplicates.join(", ")}]. No records were inserted.`);
        }
        return headers;
      },
    });
  }
  if (!records.length) throw new Error("File contains no records");
  return records.map((record, index) => {
    const result = schema.safeParse(record);
    if (!result.success) {
      const details = result.error.issues.map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`).join("; ");
      throw new Error(`Invalid record ${index + 1}: ${details}. No records were inserted.`);
    }
    return result.data;
  });
}
