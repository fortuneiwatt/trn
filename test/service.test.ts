import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/app/memory-store';
import { DomainError, TrnService } from '../src/app/service';
import type { ProviderAdapter, ProviderAnswer } from '../src/app/service';
import { verifyWebhook } from '../src/domain/webhook-signing';

const MIN = 60_000;
function setup() {
  let t = new Date('2026-11-08T09:00:00Z').getTime();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const store = new MemoryStore();
  const svc = new TrnService(store, clock, { orderTtlMs: 15 * MIN, rateLockGraceMs: MIN, bankMaxWaitMs: 30 * MIN });
  return { clock, store, svc };
}
const T = 'tenant-1';
const TOKEN = { symbol: 'USDT', rateKoboPerToken: 150_000n, decimals: 6 };
const provider = (a: ProviderAnswer): ProviderAdapter => ({ requery: async () => a });

test('story: pending -> timeout -> UNKNOWN -> requery success -> SAFE_TO_SHIP, case resolved', async () => {
  const { clock, svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'ORD-1', amountKobo: 5_000_000n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  assert.equal((await svc.getOrderView(T, oid)).verdict.verdict, 'WAIT'); // customer started a bank payment
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', externalEventId: 'p1' });
  clock.advance(31 * MIN);
  assert.deepEqual(await svc.sweep(), { timedOut: 1, refreshed: 0 });
  let v = await svc.getOrderView(T, oid);
  assert.equal(v.attempts[0]?.status, 'UNKNOWN');
  assert.equal(v.verdict.verdict, 'WAIT');
  assert.equal(v.verdict.blockRetry, true);
  assert.equal(v.cases.length, 1);
  clock.advance(MIN);
  assert.equal(await svc.runReconciliation(provider({ found: true, status: 'SUCCESS', amountMinor: 5_000_000n })), 1);
  v = await svc.getOrderView(T, oid);
  assert.equal(v.verdict.verdict, 'SAFE_TO_SHIP');
  assert.equal(v.cases.length, 0); // resolved
  const snap = await svc.snapshot();
  assert.equal(snap.cases[0]?.status, 'RESOLVED');
});

test('duplicate provider webhook is a no-op and is not logged twice', async () => {
  const { svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'ORD-2', amountKobo: 1_000n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  const a = await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', externalEventId: 'dup' });
  const b = await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', externalEventId: 'dup' });
  assert.equal(a.outcome, 'APPLIED');
  assert.equal(b.reason, 'DUPLICATE_EXTERNAL_EVENT');
  assert.equal((await svc.getOrderView(T, oid)).timeline.length, 1);
});

test('a failed transaction rolls back every write', async () => {
  const { svc } = setup();
  await assert.rejects(svc.seed((s) => { s.addOutbox(T, 'x', {}, new Date()); throw new Error('boom'); }));
  assert.equal(await svc.seed((s) => s.unpublished(10).length), 0);
});

test('screenshot alone -> UNVERIFIED_PROOF; it never produces SAFE_TO_SHIP', async () => {
  const { svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'ORD-3', amountKobo: 5_000_000n });
  const r = await svc.submitProof(T, oid, { amountKobo: 5_000_000n, reference: 'FAKE-1' });
  assert.equal(r.matchResult, 'NO_MATCH');
  assert.equal(r.verdict.verdict, 'UNVERIFIED_PROOF');
  assert.equal(r.verdict.canFulfil, false);
});

test('reused screenshot reference from another order is called out', async () => {
  const { svc } = setup();
  const o1 = await svc.createOrder(T, { merchantReference: 'A', amountKobo: 100n });
  const a1 = await svc.createAttempt(T, o1, 'BANK', { providerRef: 'REF-REAL' });
  await svc.ingestEvent(T, a1, { source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 100n });
  const o2 = await svc.createOrder(T, { merchantReference: 'B', amountKobo: 100n });
  const r = await svc.submitProof(T, o2, { amountKobo: 100n, reference: 'REF-REAL' });
  assert.equal(r.matchResult, 'NO_MATCH');
  assert.match(r.note, /different order/);
});

test('provider "not found" is inconclusive; after the retry budget the case ESCALATES', async () => {
  const { clock, svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'ORD-4', amountKobo: 1_000n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  clock.advance(31 * MIN);
  await svc.sweep();
  for (let i = 0; i < 5; i++) { clock.advance(7 * 3_600_000); await svc.runReconciliation(provider({ found: false })); }
  const snap = await svc.snapshot();
  assert.equal(snap.cases[0]?.status, 'ESCALATED');
  assert.equal(snap.cases[0]?.verifications.every((v) => v.conclusive === false), true);
  assert.equal((await svc.getOrderView(T, oid)).attempts[0]?.status, 'UNKNOWN'); // never auto-failed
  assert.ok(aid);
});

test('chain: CONFIRMING -> SUCCESS in lock is safe; mined after expiry is PAID_LATE', async () => {
  const { clock, svc } = setup();
  const o1 = await svc.createOrder(T, { merchantReference: 'C1', amountKobo: 5_000_000n, token: TOKEN });
  const c1 = await svc.createAttempt(T, o1, 'CHAIN', { depositAddress: '0xaaa' });
  await svc.ingestEvent(T, c1, { source: 'CHAIN_OBSERVER', toStatus: 'CONFIRMING' });
  assert.equal((await svc.getOrderView(T, o1)).verdict.verdict, 'CONFIRMING');
  await svc.ingestEvent(T, c1, { source: 'CHAIN_OBSERVER', toStatus: 'SUCCESS', amountMinor: 33_333_334n, paidAt: clock.now() });
  assert.equal((await svc.getOrderView(T, o1)).verdict.verdict, 'SAFE_TO_SHIP');

  const o2 = await svc.createOrder(T, { merchantReference: 'C2', amountKobo: 5_000_000n, token: TOKEN });
  const c2 = await svc.createAttempt(T, o2, 'CHAIN', { depositAddress: '0xbbb' });
  clock.advance(20 * MIN);
  await svc.ingestEvent(T, c2, { source: 'CHAIN_OBSERVER', toStatus: 'SUCCESS', amountMinor: 33_333_334n, paidAt: clock.now() });
  const v = await svc.getOrderView(T, o2);
  assert.equal(v.verdict.verdict, 'PAID_LATE_RATE_CHANGED');
  assert.equal(v.verdict.canFulfil, false);
});

test('bank webhook cannot drive a chain attempt (rail isolation)', async () => {
  const { svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'C3', amountKobo: 5_000_000n, token: TOKEN });
  const aid = await svc.createAttempt(T, oid, 'CHAIN', { depositAddress: '0xccc' });
  const r = await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 33_333_334n });
  assert.equal(r.outcome, 'REJECTED');
  assert.notEqual(r.verdict.verdict, 'SAFE_TO_SHIP');
});

test('conflicting final outcomes escalate with an anomaly instead of overwriting', async () => {
  const { svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'ORD-5', amountKobo: 100n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 100n });
  const r = await svc.ingestEvent(T, aid, { source: 'PROVIDER_REQUERY', toStatus: 'FAILED' });
  assert.equal(r.anomaly, true);
  assert.equal((await svc.snapshot()).cases[0]?.status, 'ESCALATED');
  assert.equal(r.verdict.verdict, 'SAFE_TO_SHIP'); // state untouched
});

test('tenant isolation and duplicate references', async () => {
  const { svc } = setup();
  const oid = await svc.createOrder('t1', { merchantReference: 'X', amountKobo: 100n });
  await assert.rejects(svc.getOrderView('t2', oid), (e) => e instanceof DomainError && e.httpStatus === 404);
  await assert.rejects(svc.createOrder('t1', { merchantReference: 'X', amountKobo: 100n }), (e) => e instanceof DomainError && e.code === 'DUPLICATE_REFERENCE');
  await svc.createOrder('t2', { merchantReference: 'X', amountKobo: 100n }); // same ref, other tenant: fine
});

test('verdict changes flow outbox -> signed webhook; failures retry and go DEAD; replay is detectable', async () => {
  const { clock, svc } = setup();
  await svc.seed((s) => s.putEndpoint({ id: 'ep1', tenantId: T, url: 'http://seller.test/hook', secrets: ['whsec_a'] }));
  const oid = await svc.createOrder(T, { merchantReference: 'W1', amountKobo: 100n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 100n });
  assert.ok((await svc.relayOutbox()) >= 2);

  const seen: { sig: string; body: string }[] = [];
  let fail = true;
  const send = async (_u: string, h: Record<string, string>, body: string) => {
    seen.push({ sig: h['trn-signature'] as string, body });
    return { status: fail ? 500 : 200 };
  };
  await svc.deliverDue(send, () => 0.0001);
  assert.ok((await svc.snapshot()).deliveries.every((d) => d.status === 'FAILED'));
  fail = false; clock.advance(2 * MIN);
  await svc.deliverDue(send, () => 0.0001);
  assert.ok((await svc.snapshot()).deliveries.every((d) => d.status === 'DELIVERED'));
  const last = seen[seen.length - 1] as { sig: string; body: string };
  const nowSec = Math.floor(clock.now().getTime() / 1000);
  assert.equal(verifyWebhook(['whsec_a'], last.sig, last.body, nowSec).ok, true);
  assert.equal(verifyWebhook(['whsec_a'], last.sig, last.body, nowSec + 3600).ok, false); // replay outside tolerance
  assert.equal(verifyWebhook(['whsec_a'], last.sig, last.body.replace('W1', 'W2'), nowSec).ok, false); // tampering
  assert.ok(!last.body.includes('tenantId')); // payload carries no internal tenancy data
});

test('webhook deliveries that keep failing end up DEAD', async () => {
  const { clock, svc } = setup();
  await svc.seed((s) => s.putEndpoint({ id: 'ep1', tenantId: T, url: 'http://down.test', secrets: ['s'] }));
  await svc.createOrder(T, { merchantReference: 'D1', amountKobo: 100n });
  const oid = await svc.createOrder(T, { merchantReference: 'D2', amountKobo: 100n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'FAILED' });
  await svc.relayOutbox();
  for (let i = 0; i < 14; i++) { await svc.deliverDue(async () => { throw new Error('ECONNREFUSED'); }, () => 0.9999); clock.advance(2 * 3_600_000); }
  assert.ok((await svc.snapshot()).deliveries.every((d) => d.status === 'DEAD'));
});
