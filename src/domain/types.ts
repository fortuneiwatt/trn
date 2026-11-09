/**
 * Shared domain types. No runtime code here, so other domain files can
 * `import type` from it with zero runtime coupling.
 *
 * Money rule: every amount is a bigint in MINOR units.
 *   BANK  -> kobo
 *   CHAIN -> token minor units (USDT/USDC on EVM = 6 decimals)
 * Never use number or float for money.
 */
export type Rail = 'BANK' | 'CHAIN';

export type AttemptStatus =
  | 'INITIATED'
  | 'PENDING'
  | 'CONFIRMING' // chain only: seen on-chain, below confirmation threshold
  | 'UNKNOWN' // bank only: TRN timed out waiting; outcome NOT known
  | 'SUCCESS'
  | 'FAILED'
  | 'REVERSAL_PENDING'
  | 'REVERSED';

/** Who is telling us something. Only some sources are authoritative. */
export type EventSource =
  | 'PROVIDER_WEBHOOK' // signed webhook from the payment provider
  | 'PROVIDER_REQUERY' // TRN asked the provider's status API
  | 'CHAIN_OBSERVER' // TRN's own chain watcher
  | 'TRN_TIMEOUT' // TRN's timeout rule (can only produce UNKNOWN)
  | 'MERCHANT_CLAIM' // seller says "they paid" (evidence only)
  | 'CUSTOMER_PROOF'; // screenshot etc. (evidence only)

export interface PaymentEvent {
  eventId: string;
  attemptId: string;
  source: EventSource;
  toStatus: AttemptStatus;
  occurredAt: Date; // when it happened at the source
  receivedAt: Date; // when TRN received it
  sourceSequence?: number; // monotonic per source, if the source provides one
  amountMinor?: bigint; // REQUIRED when toStatus === 'SUCCESS'
  paidAt?: Date; // chain: block timestamp of inclusion
}

export interface AttemptState {
  attemptId: string;
  rail: Rail;
  status: AttemptStatus;
  receivedAmountMinor: bigint | null;
  paidAt: Date | null;
  lastAuthoritativeAt: Date | null;
  lastSequenceBySource: Partial<Record<EventSource, number>>;
  statusChangedAt: Date;
}

export type ApplyOutcome = 'APPLIED' | 'NOOP' | 'REJECTED' | 'STALE';

export interface ApplyResult {
  state: AttemptState;
  outcome: ApplyOutcome;
  reason?: string;
  /** Two authoritative sources disagree about a final state. Open an ESCALATED case. */
  anomaly?: boolean;
}
