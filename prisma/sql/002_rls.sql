-- Row-Level Security: tenant isolation enforced by Postgres, not just by controllers.
-- Phase B hardening. The API must connect as a NON-owner role (owners bypass RLS) and run, per request:
--   BEGIN; SELECT set_config('app.tenant_id', '<tenant uuid>', true); ...queries...; COMMIT;
-- chain_transfers is intentionally excluded: rows exist before they are matched to a tenant,
-- and only the chain watcher (a trusted internal service) touches it.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'payment_attempts', 'payment_events', 'proof_submissions',
    'reconciliation_cases', 'webhook_endpoints', 'webhook_deliveries', 'idempotency_keys'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) '
      'WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;
