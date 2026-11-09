import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signWebhook, verifyWebhook } from '../src/domain/webhook-signing';
import { nextReconciliationDelayMs, webhookRetryDelayMs } from '../src/domain/backoff';
import { classifyTransfer, tokenAmountForNaira } from '../src/domain/chain';
import type { ChainConfig, ObservedTransfer } from '../src/domain/chain';
import { decideIdempotency, requestFingerprint } from '../src/domain/idempotency';

const body = JSON.stringify({ eventId: 'evt_1', eventType: 'payment.verdict_changed' });
const NOW = 1_794_000_000;

test('webhook: valid signature verifies', () => {
  assert.deepEqual(verifyWebhook(['s3cret'], signWebhook(['s3cret'], body, NOW), body, NOW + 10), { ok: true });
});
test('webhook: tampered body, wrong secret and replay are all rejected', () => {
  const h = signWebhook(['s3cret'], body, NOW);
  assert.deepEqual(verifyWebhook(['s3cret'], h, body + ' ', NOW), { ok: false, reason: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyWebhook(['other'], h, body, NOW), { ok: false, reason: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyWebhook(['s3cret'], h, body, NOW + 301), { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
  assert.deepEqual(verifyWebhook(['s3cret'], 'garbage', body, NOW), { ok: false, reason: 'MALFORMED' });
});
test('webhook: secret rotation works in both directions', () => {
  const h = signWebhook(['new', 'old'], body, NOW);
  assert.equal(verifyWebhook(['old'], h, body, NOW).ok, true);
  assert.equal(verifyWebhook(['new'], h, body, NOW).ok, true);
});
test('webhook: changing the timestamp invalidates the signature', () => {
  const h = signWebhook(['s'], body, NOW).replace(`t=${NOW}`, `t=${NOW + 5}`);
  assert.equal(verifyWebhook(['s'], h, body, NOW + 5).ok, false);
});

test('reconciliation schedule then escalation', () => {
  assert.equal(nextReconciliationDelayMs(0), 30_000);
  assert.equal(nextReconciliationDelayMs(4), 21_600_000);
  assert.equal(nextReconciliationDelayMs(5), null);
});
test('webhook retry: capped, jittered, dead after max attempts', () => {
  assert.equal(webhookRetryDelayMs(1, () => 0.5), 2_500);
  assert.ok((webhookRetryDelayMs(11, () => 0.999) as number) <= 3_600_000);
  assert.equal(webhookRetryDelayMs(12), null);
});

const cfg: ChainConfig = { chainId: 31337, minConfirmations: 3, tokens: [{ symbol: 'USDT', contract: '0xAbC0000000000000000000000000000000000001', decimals: 6 }] };
const tr = (p: Partial<ObservedTransfer> = {}): ObservedTransfer => ({ chainId: 31337, tokenContract: '0xabc0000000000000000000000000000000000001', amountMinor: 1n, confirmations: 0, reverted: false, removed: false, ...p });
test('chain: classification', () => {
  assert.deepEqual(classifyTransfer(tr({ confirmations: 1 }), cfg), { kind: 'STATUS', status: 'CONFIRMING' });
  assert.deepEqual(classifyTransfer(tr({ confirmations: 3 }), cfg), { kind: 'STATUS', status: 'SUCCESS' });
  assert.deepEqual(classifyTransfer(tr({ confirmations: 9, removed: true }), cfg), { kind: 'STATUS', status: 'PENDING' });
  assert.deepEqual(classifyTransfer(tr({ reverted: true }), cfg), { kind: 'STATUS', status: 'FAILED' });
  assert.deepEqual(classifyTransfer(tr({ chainId: 1 }), cfg), { kind: 'WRONG_ASSET', reason: 'WRONG_NETWORK' });
  assert.deepEqual(classifyTransfer(tr({ tokenContract: '0xdead' }), cfg), { kind: 'WRONG_ASSET', reason: 'UNSUPPORTED_TOKEN' });
});
test('quote: N50,000 at N1,500/USDT rounds UP to 33.333334 USDT', () => {
  assert.equal(tokenAmountForNaira(5_000_000n, 150_000n, 6), 33_333_334n);
  assert.equal(tokenAmountForNaira(150_000n, 150_000n, 6), 1_000_000n);
  assert.throws(() => tokenAmountForNaira(0n, 150_000n, 6));
  assert.throws(() => tokenAmountForNaira(10n ** 18n, 1n, 18)); // int8 overflow guard
});

test('idempotency: process, replay, conflict, in-progress', () => {
  const fp = requestFingerprint('POST', '/v1/orders', { b: 2, a: 1 });
  assert.equal(fp, requestFingerprint('post', '/v1/orders', { a: 1, b: 2 })); // key order is irrelevant
  assert.deepEqual(decideIdempotency(null, fp), { action: 'PROCESS' });
  assert.deepEqual(decideIdempotency({ requestHash: fp, responseStatus: 201, responseBody: { id: 'o1' } }, fp), { action: 'REPLAY', status: 201, body: { id: 'o1' } });
  assert.deepEqual(decideIdempotency({ requestHash: 'x', responseStatus: 201, responseBody: {} }, fp), { action: 'CONFLICT', reason: 'KEY_REUSED_WITH_DIFFERENT_REQUEST' });
  assert.deepEqual(decideIdempotency({ requestHash: fp, responseStatus: null, responseBody: null }, fp), { action: 'CONFLICT', reason: 'REQUEST_IN_PROGRESS' });
});
