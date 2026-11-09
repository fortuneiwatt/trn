-- Apply AFTER `prisma migrate` creates the tables. Column names are Prisma camelCase, hence the quotes.
-- Recommended: put this in a Prisma "draft" migration (prisma migrate dev --create-only) so it is versioned.

-- 1. Business rules Prisma cannot express ---------------------------------------------------------
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK ("amountKobo" > 0);
ALTER TABLE orders ADD CONSTRAINT orders_token_quote_consistent CHECK (
  ("tokenSymbol" IS NULL AND "tokenAmountMinor" IS NULL AND "rateKoboPerToken" IS NULL)
  OR ("tokenSymbol" IS NOT NULL AND "tokenAmountMinor" > 0 AND "rateKoboPerToken" > 0)
);
ALTER TABLE payment_attempts ADD CONSTRAINT attempts_received_non_negative
  CHECK ("receivedAmountMinor" IS NULL OR "receivedAmountMinor" >= 0);
-- A SUCCESS attempt must always carry its verified amount.
ALTER TABLE payment_attempts ADD CONSTRAINT attempts_success_has_amount
  CHECK (status <> 'SUCCESS' OR "receivedAmountMinor" IS NOT NULL);
ALTER TABLE payment_attempts ADD CONSTRAINT attempts_rail_fields CHECK (
  (rail = 'CHAIN' AND "providerRef" IS NULL) OR (rail = 'BANK' AND "depositAddress" IS NULL)
);

-- 2. At most ONE open reconciliation case per attempt ----------------------------------------------
CREATE UNIQUE INDEX recon_one_open_case_per_attempt
  ON reconciliation_cases ("attemptId") WHERE status IN ('OPEN', 'VERIFYING', 'ESCALATED');

-- 3. Hot-path partial indexes -----------------------------------------------------------------------
CREATE INDEX outbox_unpublished ON outbox (id) WHERE "publishedAt" IS NULL;
CREATE INDEX webhook_deliveries_due ON webhook_deliveries ("nextAttemptAt")
  WHERE status IN ('PENDING', 'FAILED');

-- 4. Append-only enforcement (payment_events, audit_logs) -----------------------------------------
CREATE OR REPLACE FUNCTION trn_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION trn_forbid_mutation();
CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION trn_forbid_mutation();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION trn_forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION trn_forbid_mutation();

-- 5. Least privilege: the app connects as trn_app, not the table owner ----------------------------
-- CREATE ROLE trn_app LOGIN PASSWORD '...';
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO trn_app;
-- REVOKE UPDATE, DELETE ON payment_events, audit_logs FROM trn_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trn_app;
