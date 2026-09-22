import { z } from "zod";
import { Prisma } from "./generated/prisma/client.js";

const Decimal = Prisma.Decimal.clone({ precision: 40 });

// Historical reference rates are not necessarily the client's accounting rates.
export async function convertToUsd(amount: string, currency: "EUR" | "USD", date: string) {
  z.string().regex(/^\d{1,16}(\.\d{1,2})?$/).parse(amount);
  z.enum(["EUR", "USD"]).parse(currency);
  z.iso.date().parse(date);
  if (date > new Date().toISOString().slice(0, 10)) throw new Error("Cannot convert using a future date");

  if (currency === "USD") {
    return { amount_usd: new Decimal(amount).toFixed(2), rate: "1", rate_date: date };
  }

  const response = await fetch(`https://api.frankfurter.dev/v2/rate/EUR/USD?date=${date}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Exchange rate lookup failed: HTTP ${response.status}`);

  const result = z.object({
    date: z.iso.date(), base: z.literal("EUR"), quote: z.literal("USD"),
    rate: z.number().positive().finite(),
  }).parse(await response.json());
  if (result.date > date) throw new Error("Exchange rate is newer than the requested date");

  return {
    amount_usd: new Decimal(amount).mul(String(result.rate)).toFixed(2, Decimal.ROUND_HALF_UP),
    rate: String(result.rate),
    rate_date: result.date,
  };
}
