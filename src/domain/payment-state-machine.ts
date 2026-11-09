import type {
  ApplyResult,
  AttemptState,
  AttemptStatus,
  EventSource,
  PaymentEvent,
  Rail,
} from './types';

const BANK_AUTH: readonly EventSource[] = ['PROVIDER_WEBHOOK', 'PROVIDER_REQUERY'];
const CHAIN_AUTH: readonly EventSource[] = ['CHAIN_OBSERVER'];

export const AUTHORITATIVE_SOURCES: ReadonlySet<EventSource> = new Set([
  ...BANK_AUTH,
  ...CHAIN_AUTH,
]);

/** Terminal: immutable once reached. */
export const TERMINAL: ReadonlySet<AttemptStatus> = new Set(['FAILED', 'REVERSED']);

/** Final-ish outcomes: a conflicting authoritative claim here is an anomaly. */
const FINAL_OUTCOMES: ReadonlySet<AttemptStatus> = new Set(['SUCCESS', 'FAILED', 'REVERSED']);

interface Rule {
  from: readonly AttemptStatus[];
  to: AttemptStatus;
  rail: Rail;
  sources: readonly EventSource[];
}

/**
 * THE transition table. If a transition is not listed, it is illegal.
 * Anything not authoritative (merchant claims, screenshots) appears nowhere
 * here on purpose: they can never move a payment's status.
 */
export const TRANSITION_RULES: readonly Rule[] = [
  // ---- BANK ----
  { from: ['INITIATED'], to: 'PENDING', rail: 'BANK', sources: BANK_AUTH },
  // A timeout means UNKNOWN. Never FAILED.
  { from: ['INITIATED', 'PENDING'], to: 'UNKNOWN', rail: 'BANK', sources: ['TRN_TIMEOUT'] },
  { from: ['UNKNOWN'], to: 'PENDING', rail: 'BANK', sources: BANK_AUTH },
  { from: ['INITIATED', 'PENDING', 'UNKNOWN'], to: 'SUCCESS', rail: 'BANK', sources: BANK_AUTH },
  { from: ['INITIATED', 'PENDING', 'UNKNOWN'], to: 'FAILED', rail: 'BANK', sources: BANK_AUTH },
  { from: ['SUCCESS'], to: 'REVERSAL_PENDING', rail: 'BANK', sources: BANK_AUTH },
  { from: ['REVERSAL_PENDING'], to: 'REVERSED', rail: 'BANK', sources: BANK_AUTH },
  // ---- CHAIN ----
  { from: ['INITIATED', 'PENDING'], to: 'CONFIRMING', rail: 'CHAIN', sources: CHAIN_AUTH },
  // Reorg before finality: the transfer vanished from the canonical chain.
  { from: ['CONFIRMING'], to: 'PENDING', rail: 'CHAIN', sources: CHAIN_AUTH },
  { from: ['INITIATED', 'PENDING', 'CONFIRMING'], to: 'SUCCESS', rail: 'CHAIN', sources: CHAIN_AUTH },
  { from: ['INITIATED', 'PENDING', 'CONFIRMING'], to: 'FAILED', rail: 'CHAIN', sources: CHAIN_AUTH },
  // No chain reversal: a SUCCESS on-chain (past the threshold) is final.
];

export function newAttempt(attemptId: string, rail: Rail, now: Date): AttemptState {
  return {
    attemptId,
    rail,
    status: 'INITIATED',
    receivedAmountMinor: null,
    paidAt: null,
    lastAuthoritativeAt: null,
    lastSequenceBySource: {},
    statusChangedAt: now,
  };
}

function reject(
  state: AttemptState,
  outcome: 'REJECTED' | 'STALE',
  reason: string,
  anomaly = false,
): ApplyResult {
  return { state, outcome, reason, ...(anomaly ? { anomaly } : {}) };
}

/**
 * Pure reducer. Same input, same output, no I/O. The caller persists the event
 * (ALWAYS, whatever the outcome) to the append-only log, and persists the new
 * state only when outcome is APPLIED.
 */
export function applyPaymentEvent(state: AttemptState, event: PaymentEvent): ApplyResult {
  const authoritative = AUTHORITATIVE_SOURCES.has(event.source);

  // 1. Per-source sequence: duplicates are no-ops, regressions are stale.
  if (event.sourceSequence !== undefined) {
    const last = state.lastSequenceBySource[event.source];
    if (last !== undefined) {
      if (event.sourceSequence === last) return { state, outcome: 'NOOP', reason: 'DUPLICATE_SEQUENCE' };
      if (event.sourceSequence < last) return reject(state, 'STALE', 'SEQUENCE_REGRESSION');
    }
  }

  // 2. Same status again: idempotent no-op.
  if (event.toStatus === state.status) {
    return { state: withSequence(state, event), outcome: 'NOOP', reason: 'ALREADY_IN_STATUS' };
  }

  // 3. Is this source ever allowed to speak for this rail?
  const sourceKnownForRail = TRANSITION_RULES.some(
    (r) => r.rail === state.rail && r.sources.includes(event.source),
  );
  if (!sourceKnownForRail) return reject(state, 'REJECTED', 'SOURCE_NOT_AUTHORITATIVE');

  // 4. Transition table lookup.
  const rule = TRANSITION_RULES.find(
    (r) =>
      r.rail === state.rail &&
      r.to === event.toStatus &&
      r.from.includes(state.status) &&
      r.sources.includes(event.source),
  );
  if (!rule) {
    const conflictingFinal =
      authoritative &&
      FINAL_OUTCOMES.has(state.status) &&
      (event.toStatus === 'SUCCESS' || event.toStatus === 'FAILED');
    return reject(
      state,
      'REJECTED',
      TERMINAL.has(state.status) ? 'TERMINAL_STATE' : 'ILLEGAL_TRANSITION',
      conflictingFinal,
    );
  }

  // 5. Out-of-order protection for non-final moves from authoritative sources.
  //    Final outcomes (SUCCESS/FAILED) are never "stale": authority beats time.
  if (
    authoritative &&
    (event.toStatus === 'PENDING' || event.toStatus === 'CONFIRMING') &&
    state.lastAuthoritativeAt !== null &&
    event.occurredAt.getTime() < state.lastAuthoritativeAt.getTime()
  ) {
    return reject(state, 'STALE', 'OLDER_THAN_LAST_AUTHORITATIVE_EVENT');
  }

  // 6. SUCCESS must carry an amount, so "paid" is always checked against the order.
  if (event.toStatus === 'SUCCESS' && (event.amountMinor === undefined || event.amountMinor < 0n)) {
    return reject(state, 'REJECTED', 'AMOUNT_REQUIRED_FOR_SUCCESS');
  }

  const next: AttemptState = {
    ...withSequence(state, event),
    status: event.toStatus,
    statusChangedAt: event.occurredAt,
    receivedAmountMinor: event.toStatus === 'SUCCESS' ? (event.amountMinor as bigint) : state.receivedAmountMinor,
    paidAt: event.toStatus === 'SUCCESS' ? (event.paidAt ?? event.occurredAt) : state.paidAt,
    lastAuthoritativeAt: authoritative
      ? maxDate(state.lastAuthoritativeAt, event.occurredAt)
      : state.lastAuthoritativeAt,
  };
  return { state: next, outcome: 'APPLIED' };
}

function withSequence(state: AttemptState, event: PaymentEvent): AttemptState {
  if (event.sourceSequence === undefined) return state;
  return {
    ...state,
    lastSequenceBySource: { ...state.lastSequenceBySource, [event.source]: event.sourceSequence },
  };
}

function maxDate(a: Date | null, b: Date): Date {
  return a !== null && a.getTime() > b.getTime() ? a : b;
}

/** Bank attempts waiting too long become UNKNOWN (never FAILED). */
export function isTimedOut(state: AttemptState, now: Date, maxWaitMs: number): boolean {
  return (
    state.rail === 'BANK' &&
    (state.status === 'INITIATED' || state.status === 'PENDING') &&
    now.getTime() - state.statusChangedAt.getTime() >= maxWaitMs
  );
}
