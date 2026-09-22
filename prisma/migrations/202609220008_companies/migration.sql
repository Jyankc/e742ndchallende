CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO companies (id, name) VALUES ('northwind', 'Northwind'), ('lumen', 'Lumen');
-- Preserve any companies already present when upgrading an existing database.
INSERT INTO companies (id, name)
SELECT company_id, company_id FROM (
  SELECT company_id FROM ingestion_runs UNION SELECT company_id FROM orders
  UNION SELECT company_id FROM refunds UNION SELECT company_id FROM email_events
  UNION SELECT company_id FROM ad_spend
) AS existing_companies ON CONFLICT (id) DO NOTHING;
ALTER TABLE ingestion_runs ADD CONSTRAINT ingestion_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE orders ADD CONSTRAINT orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE refunds ADD CONSTRAINT refunds_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE email_events ADD CONSTRAINT email_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE ad_spend ADD CONSTRAINT ad_spend_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE;
