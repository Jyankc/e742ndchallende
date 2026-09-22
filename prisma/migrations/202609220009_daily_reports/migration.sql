CREATE TABLE source_configs (
 company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 source "Source" NOT NULL, currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 PRIMARY KEY(company_id, source)
);
CREATE TABLE expected_batches (
 company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 source "Source" NOT NULL, idempotency_key TEXT NOT NULL,
 covers_from DATE NOT NULL, covers_to DATE NOT NULL CHECK (covers_to >= covers_from),
 PRIMARY KEY(company_id, source, idempotency_key)
);
CREATE INDEX expected_batches_company_id_covers_from_covers_to_idx ON expected_batches(company_id, covers_from, covers_to);
CREATE TABLE finance_daily (
 company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 date DATE NOT NULL, gross_reported DECIMAL(18,2) NOT NULL, net_reported DECIMAL(18,2) NOT NULL,
 currency TEXT NOT NULL, PRIMARY KEY(company_id, date)
);
CREATE TABLE fx_rates (
 currency TEXT NOT NULL, date DATE NOT NULL, rate DECIMAL(24,12) NOT NULL CHECK (rate > 0),
 rate_date DATE NOT NULL CHECK (rate_date <= date), provider TEXT NOT NULL,
 saved_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(), PRIMARY KEY(currency,date)
);
CREATE INDEX orders_company_id_created_at_idx ON orders(company_id, created_at);
CREATE INDEX refunds_company_id_refunded_at_idx ON refunds(company_id, refunded_at);
