import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPaymentEvent, newAttempt, isTimedOut, AUTHORITATIVE_SOURCES, TERMINAL } from '../src/domain/payment-state-machine';
import type { AttemptState, AttemptStatus, EventSource, PaymentEvent, Rail } from '../src/domain/types';

const T0 = new Date('2026-11-07T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
let n = 0;
const ev = (p: Partial<PaymentEvent> & Pick<PaymentEvent, 'source' | 'toStatus'>): PaymentEvent => ({
  eventId: `e${++n}`, attemptId: 'a1', occurredAt: T0, receivedAt: T0, ...p,
});
const bank = () => newAttempt('a1', 'BANK', T0);
const chain = () => newAttempt('a1', 'CHAIN', T0);

test('happy path: bank INITIATED -> PENDING -> SUCCESS', () => {
  let s = bank();
  s = applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', occurredAt: at(1) })).state;
  const r = applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', occurredAt: at(2), amountMinor: 5_000_000n }));
  assert.equal(r.outcome, 'APPLIED');
  assert.equal(r.state.status, 'SUCCESS');
  assert.equal(r.state.receivedAmountMinor, 5_000_000n);
});

test('timeout produces UNKNOWN, never FAILED', () => {
  const s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', occurredAt: at(1) })).state;
  assert.equal(isTimedOut(s, at(40), 30 * 60_000), true);
  const toUnknown = applyPaymentEvent(s, ev({ source: 'TRN_TIMEOUT', toStatus: 'UNKNOWN', occurredAt: at(40) }));
  assert.equal(toUnknown.state.status, 'UNKNOWN');
  const toFailed = applyPaymentEvent(s, ev({ source: 'TRN_TIMEOUT', toStatus: 'FAILED', occurredAt: at(40) }));
  assert.equal(toFailed.outcome, 'REJECTED');
  assert.equal(toFailed.state.status, 'PENDING');
});

test('late SUCCESS webhook resolves UNKNOWN even if it occurred before the timeout', () => {
  let s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', occurredAt: at(1) })).state;
  s = applyPaymentEvent(s, ev({ source: 'TRN_TIMEOUT', toStatus: 'UNKNOWN', occurredAt: at(40) })).state;
  const r = applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', occurredAt: at(2), amountMinor: 100n }));
  assert.equal(r.state.status, 'SUCCESS');
});

test('late PENDING after SUCCESS never overwrites it', () => {
  let s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', occurredAt: at(5), amountMinor: 100n })).state;
  const r = applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', occurredAt: at(3) }));
  assert.equal(r.outcome, 'REJECTED');
  assert.equal(r.state.status, 'SUCCESS');
  assert.equal(r.anomaly, undefined);
});

test('stale non-final move is rejected when older than last authoritative event', () => {
  let s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', occurredAt: at(10) })).state;
  s = applyPaymentEvent(s, ev({ source: 'TRN_TIMEOUT', toStatus: 'UNKNOWN', occurredAt: at(50) })).state;
  const r = applyPaymentEvent(s, ev({ source: 'PROVIDER_REQUERY', toStatus: 'PENDING', occurredAt: at(5) }));
  assert.equal(r.outcome, 'STALE');
  assert.equal(r.state.status, 'UNKNOWN');
});

test('merchant claims and screenshots can never move a payment', () => {
  for (const source of ['MERCHANT_CLAIM', 'CUSTOMER_PROOF'] as EventSource[]) {
    const r = applyPaymentEvent(bank(), ev({ source, toStatus: 'SUCCESS', amountMinor: 999_999n }));
    assert.equal(r.outcome, 'REJECTED');
    assert.equal(r.reason, 'SOURCE_NOT_AUTHORITATIVE');
    assert.equal(r.state.status, 'INITIATED');
  }
});

test('SUCCESS without an amount is rejected', () => {
  const r = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS' }));
  assert.equal(r.outcome, 'REJECTED');
  assert.equal(r.reason, 'AMOUNT_REQUIRED_FOR_SUCCESS');
});

test('FAILED is terminal; a conflicting SUCCESS is flagged as an anomaly', () => {
  const s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'FAILED' })).state;
  const r = applyPaymentEvent(s, ev({ source: 'PROVIDER_REQUERY', toStatus: 'SUCCESS', amountMinor: 1n }));
  assert.equal(r.outcome, 'REJECTED');
  assert.equal(r.reason, 'TERMINAL_STATE');
  assert.equal(r.anomaly, true);
  assert.equal(r.state.status, 'FAILED');
});

test('SUCCESS then FAILED from the provider is an anomaly, not a silent overwrite', () => {
  const s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 1n })).state;
  const r = applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'FAILED' }));
  assert.equal(r.anomaly, true);
  assert.equal(r.state.status, 'SUCCESS');
});

test('reversal flow: SUCCESS -> REVERSAL_PENDING -> REVERSED (terminal)', () => {
  let s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 1n })).state;
  s = applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'REVERSAL_PENDING', occurredAt: at(1) })).state;
  s = applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'REVERSED', occurredAt: at(2) })).state;
  assert.equal(s.status, 'REVERSED');
  assert.equal(applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 1n })).outcome, 'REJECTED');
});

test('duplicates are no-ops; sequence regressions are stale', () => {
  let s = applyPaymentEvent(bank(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', sourceSequence: 5, occurredAt: at(1) })).state;
  assert.equal(applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', sourceSequence: 5 })).outcome, 'NOOP');
  assert.equal(applyPaymentEvent(s, ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', sourceSequence: 4, amountMinor: 1n })).outcome, 'STALE');
});

test('a bank source cannot drive a chain attempt, and vice versa', () => {
  assert.equal(applyPaymentEvent(chain(), ev({ source: 'PROVIDER_WEBHOOK', toStatus: 'SUCCESS', amountMinor: 1n })).outcome, 'REJECTED');
  assert.equal(applyPaymentEvent(bank(), ev({ source: 'CHAIN_OBSERVER', toStatus: 'CONFIRMING' })).outcome, 'REJECTED');
});

test('chain: CONFIRMING -> reorg back to PENDING -> CONFIRMING -> SUCCESS', () => {
  let s = applyPaymentEvent(chain(), ev({ source: 'CHAIN_OBSERVER', toStatus: 'CONFIRMING', occurredAt: at(1) })).state;
  s = applyPaymentEvent(s, ev({ source: 'CHAIN_OBSERVER', toStatus: 'PENDING', occurredAt: at(2) })).state;
  assert.equal(s.status, 'PENDING');
  s = applyPaymentEvent(s, ev({ source: 'CHAIN_OBSERVER', toStatus: 'CONFIRMING', occurredAt: at(3) })).state;
  const r = applyPaymentEvent(s, ev({ source: 'CHAIN_OBSERVER', toStatus: 'SUCCESS', occurredAt: at(4), amountMinor: 33_333_334n, paidAt: at(3) }));
  assert.equal(r.state.status, 'SUCCESS');
  assert.deepEqual(r.state.paidAt, at(3));
});

// ---------- seeded fuzz: invariants hold for ANY event sequence ----------
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const STATUSES: AttemptStatus[] = ['INITIATED', 'PENDING', 'CONFIRMING', 'UNKNOWN', 'SUCCESS', 'FAILED', 'REVERSAL_PENDING', 'REVERSED'];
const SOURCES: EventSource[] = ['PROVIDER_WEBHOOK', 'PROVIDER_REQUERY', 'CHAIN_OBSERVER', 'TRN_TIMEOUT', 'MERCHANT_CLAIM', 'CUSTOMER_PROOF'];

test('fuzz: money-safety invariants hold across 5,000 random sequences', () => {
  const r = rng(42);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)] as T;
  for (let run = 0; run < 5000; run++) {
    const rail: Rail = r() < 0.5 ? 'BANK' : 'CHAIN';
    let s: AttemptState = newAttempt('a', rail, T0);
    for (let i = 0; i < 12; i++) {
      const prev = s;
      const e: PaymentEvent = {
        eventId: `f${run}-${i}`, attemptId: 'a', source: pick(SOURCES), toStatus: pick(STATUSES),
        occurredAt: at(Math.floor(r() * 60)), receivedAt: at(61),
        ...(r() < 0.7 ? { amountMinor: BigInt(Math.floor(r() * 1000)) } : {}),
      };
      const res = applyPaymentEvent(prev, e);
      s = res.state;
      if (TERMINAL.has(prev.status)) assert.equal(s.status, prev.status, 'terminal states are immutable');
      if (s.status !== prev.status) {
        assert.ok(AUTHORITATIVE_SOURCES.has(e.source) || (e.source === 'TRN_TIMEOUT' && s.status === 'UNKNOWN'), 'only authoritative sources (or the timeout rule -> UNKNOWN) change status');
        if (s.status === 'SUCCESS') assert.ok(e.amountMinor !== undefined, 'SUCCESS always carries an amount');
      }
      if (e.source === 'TRN_TIMEOUT' && res.outcome === 'APPLIED') assert.equal(s.status, 'UNKNOWN');
      if (res.outcome !== 'APPLIED') assert.equal(s.status, prev.status, 'non-applied events never change status');
    }
  }
});
