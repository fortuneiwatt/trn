import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/app/memory-store';
import { DomainError, TrnService } from '../src/app/service';
import { webhookRetryDelayMs } from '../src/domain/backoff';
import { evaluateVerdict } from '../src/domain/verdict';

const MIN = 60_000;
function setup() {
  let t = new Date('2026-11-08T09:00:00Z').getTime();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const store = new MemoryStore();
  const svc = new TrnService(store, clock, { orderTtlMs: 60 * MIN, rateLockGraceMs: MIN, bankMaxWaitMs: 30 * MIN });
  return { clock, store, svc };
}
const T = 't1';
const TOKEN = { symbol: 'USDT', rateKoboPerToken: 150_000n, decimals: 6 };

test('R1: a no-op event still persists its source sequence, so older sequences are then stale', async () => {
  const { svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'R1', amountKobo: 100n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', sourceSequence: 5 });
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', sourceSequence: 7 }); // no-op
  const r = await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', sourceSequence: 6, amountMinor: 100n });
  assert.equal(r.outcome, 'STALE');
});

test('R2: a wrong-token deposit must not poison the real payment attempt', async () => {
  const { clock, svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'R2', amountKobo: 5_000_000n, token: TOKEN });
  const aid = await svc.createAttempt(T, oid, 'CHAIN', { depositAddress: '0xabc' });
  assert.equal((await svc.markAssetMismatch(T, aid, 'UNSUPPORTED_TOKEN')).verdict, 'WRONG_ASSET');
  await svc.ingestEvent(T, aid, { source: 'CHAIN_OBSERVER', toStatus: 'SUCCESS', amountMinor: 33_333_334n, paidAt: clock.now() });
  assert.equal((await svc.getOrderView(T, oid)).verdict.verdict, 'SAFE_TO_SHIP');
});

test('R3: a future-dated provider event cannot freeze later legitimate events', async () => {
  const { clock, svc } = setup();
  const oid = await svc.createOrder(T, { merchantReference: 'R3', amountKobo: 100n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', occurredAt: new Date(clock.now().getTime() + 365 * 24 * 60 * MIN) });
  clock.advance(31 * MIN);
  await svc.sweep(); // -> UNKNOWN
  const r = await svc.ingestEvent(T, aid, { source: 'PROVIDER_REQUERY', toStatus: 'PENDING' });
  assert.equal(r.outcome, 'APPLIED');
});

test('R4: an absurd order amount is a validation error, not a crash', async () => {
  const { svc } = setup();
  await assert.rejects(
    svc.createOrder(T, { merchantReference: 'R4', amountKobo: 10n ** 30n, token: TOKEN }),
    (e) => e instanceof DomainError && e.httpStatus === 400,
  );
});

test('R6: two overlapping delivery runs must send each webhook exactly once', async () => {
  const { svc } = setup();
  await svc.seed((s) => s.putEndpoint({ id: 'ep', tenantId: T, url: 'http://x', secrets: ['s'] }));
  const oid = await svc.createOrder(T, { merchantReference: 'R6', amountKobo: 100n });
  const aid = await svc.createAttempt(T, oid, 'BANK');
  await svc.ingestEvent(T, aid, { source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 100n });
  await svc.relayOutbox();
  const sent: string[] = [];
  const send = async (_u: string, h: Record<string, string>) => { sent.push(h['trn-event-id'] as string); await new Promise((r) => setTimeout(r, 20)); return { status: 200 }; };
  await Promise.all([svc.deliverDue(send), svc.deliverDue(send)]);
  assert.equal(new Set(sent).size, sent.length, `duplicate sends: ${sent.join(',')}`);
});

test('R7: webhook retries never fire with zero delay', () => {
  assert.ok((webhookRetryDelayMs(1, () => 0) as number) >= 1000);
});

test('R9: a nested transaction fails loudly instead of deadlocking', async () => {
  const store = new MemoryStore();
  const out = await Promise.race([
    store.tx(async () => store.tx(async () => 1)).then(() => 'ok', (e: Error) => `rejected:${e.message}`),
    new Promise((r) => setTimeout(() => r('DEADLOCK'), 400)),
  ]);
  assert.match(String(out), /^rejected:/);
});

test('R10: a duplicate payment that is being reversed is still flagged', () => {
  const order = { requiredBankKobo: 100n, requiredTokenMinor: null, expiresAt: new Date('2026-11-08T12:00:00Z'), rateLockGraceMs: 0 };
  const r = evaluateVerdict(order, [
    { attemptId: 'a', rail: 'BANK', status: 'SUCCESS', receivedAmountMinor: 100n, paidAt: null, assetMismatch: false },
    { attemptId: 'b', rail: 'BANK', status: 'REVERSAL_PENDING', receivedAmountMinor: 100n, paidAt: null, assetMismatch: false },
  ], [], new Date('2026-11-08T09:00:00Z'));
  assert.ok(r.flags.includes('POSSIBLE_DUPLICATE_PAYMENT'));
});
