import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToUsd } from "../src/currency.js";

test("converts EUR with decimal rounding and exposes the actual rate date", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.frankfurter.dev/v2/rate/EUR/USD?date=2026-01-11");
    return Response.json({ date: "2026-01-09", base: "EUR", quote: "USD", rate: 1.1721 });
  });
  assert.deepEqual(await convertToUsd("100.00", "EUR", "2026-01-11"), {
    amount_usd: "117.21", rate: "1.1721", rate_date: "2026-01-09",
  });
  assert.equal((await convertToUsd("0.05", "EUR", "2026-01-11")).amount_usd, "0.06");
});

test("USD requires no external lookup", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
  assert.equal((await convertToUsd("9999999999999999.99", "USD", "2026-01-06")).amount_usd, "9999999999999999.99");
});

test("lookup errors fail explicitly instead of substituting a rate", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(convertToUsd("10", "EUR", "2026-01-06"), /HTTP 503/);
});

test("rejects malformed API data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ rate: 0 }));
  await assert.rejects(convertToUsd("10", "EUR", "2026-01-06"));
});
