-- Remove the reporting feature without changing source records or run history.
DROP TABLE source_configs;
DROP TABLE expected_batches;
DROP TABLE finance_daily;
DROP TABLE fx_rates;
DROP INDEX orders_company_id_created_at_idx;
DROP INDEX refunds_company_id_refunded_at_idx;
