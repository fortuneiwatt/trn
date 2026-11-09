import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVerdict } from '../src/domain/verdict';
import type { AttemptFacts, OrderFacts, ProofFacts } from '../src/domain/verdict';
import type { AttemptStatus, Rail } from '../src/domain/types';

const NOW = new Date('2026-11-07T10:00:00Z');
const order: OrderFacts = { requiredBankKobo: 5_000_000n, requiredTokenMinor: 33_333_334n, expiresAt: new Date('2026-11-07T10:15:00Z'), rateLockGraceMs: 60_000 };
const att = (p: Partial<AttemptFacts> & { attemptId: string }): AttemptFacts => ({
  rail: 'BANK', status: 'INITIATED', receivedAmountMinor: null, paidAt: null, assetMismatch: false, ...p,
});
const v = (a: AttemptFacts[], proofs: ProofFacts[] = [], now = NOW) => evaluateVerdict(order, a, proofs, now);

test('no attempts: awaiting, then expired', () => {
  assert.equal(v([]).verdict, 'AWAITING_PAYMENT');
  assert.equal(v([], [], new Date('2026-11-07T11:00:00Z')).verdict, 'EXPIRED');
});

test('verified full bank payment is SAFE_TO_SHIP', () => {
  const r = v([att({ attemptId: 'b1', status: 'SUCCESS', receivedAmountMinor: 5_000_000n })]);
  assert.equal(r.verdict, 'SAFE_TO_SHIP');
  assert.equal(r.canFulfil, true);
  assert.equal(r.blockRetry, true);
});

test('bank PENDING / UNKNOWN / INITIATED -> WAIT and blocks a second charge', () => {
  for (const status of ['INITIATED', 'PENDING', 'UNKNOWN'] as AttemptStatus[]) {
    const r = v([att({ attemptId: 'b1', status })]);
    assert.equal(r.verdict, 'WAIT');
    assert.equal(r.blockRetry, true);
    assert.equal(r.canFulfil, false);
  }
});

test('chain CONFIRMING then SUCCESS inside the rate lock', () => {
  const c = att({ attemptId: 'c1', rail: 'CHAIN', status: 'CONFIRMING' });
  assert.equal(v([c]).verdict, 'CONFIRMING');
  const done = att({ attemptId: 'c1', rail: 'CHAIN', status: 'SUCCESS', receivedAmountMinor: 33_333_334n, paidAt: new Date('2026-11-07T10:10:00Z') });
  assert.equal(v([done]).verdict, 'SAFE_TO_SHIP');
});

test('chain payment mined after expiry (+grace) is PAID_LATE_RATE_CHANGED and not fulfillable', () => {
  const late = att({ attemptId: 'c1', rail: 'CHAIN', status: 'SUCCESS', receivedAmountMinor: 33_333_334n, paidAt: new Date('2026-11-07T10:20:00Z') });
  const r = v([late]);
  assert.equal(r.verdict, 'PAID_LATE_RATE_CHANGED');
  assert.equal(r.canFulfil, false);
});

test('underpayment is PARTIAL_PAYMENT', () => {
  const r = v([att({ attemptId: 'c1', rail: 'CHAIN', status: 'SUCCESS', receivedAmountMinor: 10_000_000n, paidAt: NOW })]);
  assert.equal(r.verdict, 'PARTIAL_PAYMENT');
  assert.equal(r.canFulfil, false);
});

test('wrong token/network -> WRONG_ASSET, customer may try again', () => {
  const r = v([att({ attemptId: 'c1', rail: 'CHAIN', status: 'SUCCESS', receivedAmountMinor: 99n, assetMismatch: true })]);
  assert.equal(r.verdict, 'WRONG_ASSET');
  assert.equal(r.blockRetry, false);
});

test('a screenshot alone is UNVERIFIED_PROOF, never SAFE_TO_SHIP', () => {
  const r = v([], [{ proofId: 'p1', matchedVerifiedPayment: false }]);
  assert.equal(r.verdict, 'UNVERIFIED_PROOF');
  assert.equal(r.canFulfil, false);
});

test('pending payment beats an unmatched screenshot', () => {
  const r = v([att({ attemptId: 'b1', status: 'PENDING' })], [{ proofId: 'p1', matchedVerifiedPayment: false }]);
  assert.equal(r.verdict, 'WAIT');
});

test('confirmed failure allows retry only while the order is live', () => {
  const failed = att({ attemptId: 'b1', status: 'FAILED' });
  assert.equal(v([failed]).verdict, 'SAFE_TO_RETRY');
  assert.equal(v([failed], [], new Date('2026-11-07T11:00:00Z')).verdict, 'EXPIRED');
});

test('retry is blocked while any other attempt is in flight', () => {
  const r = v([att({ attemptId: 'b1', status: 'FAILED' }), att({ attemptId: 'b2', status: 'PENDING' })]);
  assert.equal(r.verdict, 'WAIT');
});

test('reversal in progress -> REFUND_IN_PROGRESS, and a reversed payment is no longer "paid"', () => {
  assert.equal(v([att({ attemptId: 'b1', status: 'REVERSAL_PENDING', receivedAmountMinor: 5_000_000n })]).verdict, 'REFUND_IN_PROGRESS');
  assert.equal(v([att({ attemptId: 'b1', status: 'REVERSED', receivedAmountMinor: 5_000_000n })]).verdict, 'SAFE_TO_RETRY');
});

test('double payment is flagged', () => {
  const r = v([
    att({ attemptId: 'b1', status: 'SUCCESS', receivedAmountMinor: 5_000_000n }),
    att({ attemptId: 'b2', status: 'PENDING' }),
  ]);
  assert.equal(r.verdict, 'SAFE_TO_SHIP');
  assert.deepEqual(r.flags, ['POSSIBLE_DUPLICATE_PAYMENT']);
});

// ---------- seeded fuzz: SAFE_TO_SHIP is impossible without a verified, sufficient payment ----------
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
test('fuzz: canFulfil <=> SAFE_TO_SHIP <=> an authoritative, sufficient, in-lock SUCCESS exists', () => {
  const r = rng(7);
  const statuses: AttemptStatus[] = ['INITIATED', 'PENDING', 'CONFIRMING', 'UNKNOWN', 'SUCCESS', 'FAILED', 'REVERSAL_PENDING', 'REVERSED'];
  for (let i = 0; i < 20000; i++) {
    const attempts: AttemptFacts[] = Array.from({ length: Math.floor(r() * 4) }, (_, k) => {
      const rail: Rail = r() < 0.5 ? 'BANK' : 'CHAIN';
      return att({
        attemptId: `a${k}`, rail, status: statuses[Math.floor(r() * statuses.length)] as AttemptStatus,
        receivedAmountMinor: r() < 0.8 ? BigInt(Math.floor(r() * 60_000_000)) : null,
        paidAt: r() < 0.8 ? new Date(NOW.getTime() + Math.floor(r() * 40) * 60_000) : null,
        assetMismatch: r() < 0.1,
      });
    });
    const proofs: ProofFacts[] = r() < 0.3 ? [{ proofId: 'p', matchedVerifiedPayment: r() < 0.5 }] : [];
    const res = v(attempts, proofs);
    const legit = attempts.some((a) => {
      if (a.assetMismatch || a.status !== 'SUCCESS' || a.receivedAmountMinor === null) return false;
      const need = a.rail === 'BANK' ? order.requiredBankKobo : order.requiredTokenMinor;
      const inLock = a.rail === 'BANK' || (a.paidAt !== null && a.paidAt.getTime() <= order.expiresAt.getTime() + order.rateLockGraceMs);
      return need !== null && a.receivedAmountMinor >= need && inLock;
    });
    assert.equal(res.canFulfil, legit);
    assert.equal(res.verdict === 'SAFE_TO_SHIP', legit);
    const inFlightOrDone = attempts.some((a) => !a.assetMismatch && ['PENDING', 'UNKNOWN', 'INITIATED', 'SUCCESS', 'CONFIRMING'].includes(a.status) && !(a.rail === 'CHAIN' && a.status === 'INITIATED'));
    if (res.verdict === 'SAFE_TO_RETRY') assert.equal(inFlightOrDone, false, 'never advise retry while money may be moving');
  }
});
