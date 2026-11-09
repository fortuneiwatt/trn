import type { AttemptStatus, Rail } from './types';

export type Verdict =
  | 'SAFE_TO_SHIP'
  | 'PAID_LATE_RATE_CHANGED'
  | 'REFUND_IN_PROGRESS'
  | 'WAIT'
  | 'CONFIRMING'
  | 'PARTIAL_PAYMENT'
  | 'WRONG_ASSET'
  | 'UNVERIFIED_PROOF'
  | 'SAFE_TO_RETRY'
  | 'EXPIRED'
  | 'AWAITING_PAYMENT';

export interface OrderFacts {
  requiredBankKobo: bigint;
  requiredTokenMinor: bigint | null; // null when stablecoin is not offered
  expiresAt: Date;
  rateLockGraceMs: number;
}

export interface AttemptFacts {
  attemptId: string;
  rail: Rail;
  status: AttemptStatus;
  receivedAmountMinor: bigint | null;
  paidAt: Date | null; // chain: BLOCK timestamp, not when TRN saw finality
  assetMismatch: boolean; // wrong token / wrong network observed
}

export interface ProofFacts {
  proofId: string;
  matchedVerifiedPayment: boolean;
}

export interface VerdictResult {
  verdict: Verdict;
  canFulfil: boolean; // true ONLY for SAFE_TO_SHIP
  blockRetry: boolean; // true = do not let the customer pay again
  reasons: string[];
  flags: string[]; // e.g. POSSIBLE_DUPLICATE_PAYMENT
  attemptIds: string[];
}

const RETRY_OK: ReadonlySet<Verdict> = new Set([
  'SAFE_TO_RETRY',
  'AWAITING_PAYMENT',
  'EXPIRED',
  'UNVERIFIED_PROOF',
  'WRONG_ASSET',
]);

function out(verdict: Verdict, attemptIds: string[], reasons: string[], flags: string[] = []): VerdictResult {
  return {
    verdict,
    canFulfil: verdict === 'SAFE_TO_SHIP',
    blockRetry: !RETRY_OK.has(verdict),
    reasons,
    flags,
    attemptIds,
  };
}

/**
 * Pure function: facts in, advice out. It never moves money and never trusts
 * anything that is not an authoritative, amount-checked SUCCESS.
 *
 * Precedence (first match wins):
 *  1 SAFE_TO_SHIP  2 PAID_LATE  3 REFUND_IN_PROGRESS  4 WAIT  5 CONFIRMING
 *  6 PARTIAL  7 WRONG_ASSET  8 UNVERIFIED_PROOF  9 SAFE_TO_RETRY
 *  10 EXPIRED  11 AWAITING_PAYMENT
 */
export function evaluateVerdict(
  order: OrderFacts,
  allAttempts: AttemptFacts[],
  proofs: ProofFacts[],
  now: Date,
): VerdictResult {
  const mismatched = allAttempts.filter((a) => a.assetMismatch);
  const attempts = allAttempts.filter((a) => !a.assetMismatch);

  const required = (a: AttemptFacts): bigint | null =>
    a.rail === 'BANK' ? order.requiredBankKobo : order.requiredTokenMinor;
  const isFull = (a: AttemptFacts): boolean => {
    const r = required(a);
    return r !== null && a.receivedAmountMinor !== null && a.receivedAmountMinor >= r;
  };
  // Bank amounts are fixed in naira. Chain amounts were quoted at a locked
  // rate, so a payment whose block time is past expiry (+grace) is "late".
  const withinRateLock = (a: AttemptFacts): boolean =>
    a.rail === 'BANK' ||
    (a.paidAt !== null && a.paidAt.getTime() <= order.expiresAt.getTime() + order.rateLockGraceMs);

  const settled = attempts.filter((a) => a.status === 'SUCCESS');
  const full = settled.filter(isFull);
  const good = full.filter(withinRateLock);

  // Fail closed: any non-final status we do not positively recognise counts as
  // "money may be moving" (e.g. BANK+CONFIRMING or CHAIN+UNKNOWN can never be
  // produced by the state machine, but must never be ignored if they appear).
  const inFlight = (a: AttemptFacts): boolean =>
    a.rail === 'BANK'
      ? a.status === 'INITIATED' || a.status === 'PENDING' || a.status === 'UNKNOWN' || a.status === 'CONFIRMING'
      : a.status === 'PENDING' || a.status === 'UNKNOWN';
  const waiting = attempts.filter(inFlight);
  const confirming = attempts.filter((a) => a.rail === 'CHAIN' && a.status === 'CONFIRMING');
  const refunding = attempts.filter((a) => a.status === 'REVERSAL_PENDING');

  if (good.length > 0) {
    const first = good[0] as AttemptFacts;
    const others = attempts.filter(
      (a) => a.attemptId !== first.attemptId && (a.status === 'SUCCESS' || a.status === 'REVERSAL_PENDING' || inFlight(a) || a.status === 'CONFIRMING'),
    );
    const flags = others.length > 0 ? ['POSSIBLE_DUPLICATE_PAYMENT'] : [];
    return out('SAFE_TO_SHIP', [first.attemptId], ['A verified payment covers the order amount.'], flags);
  }
  if (full.length > 0) {
    return out('PAID_LATE_RATE_CHANGED', ids(full), [
      'Payment arrived after the quote expired. The seller decides whether to accept or refund.',
    ]);
  }
  if (refunding.length > 0) {
    return out('REFUND_IN_PROGRESS', ids(refunding), ['A refund or reversal is in progress.']);
  }
  if (waiting.length > 0) {
    return out('WAIT', ids(waiting), [
      'A payment may be in progress. Hold fulfilment and do not let the customer pay again.',
    ]);
  }
  if (confirming.length > 0) {
    return out('CONFIRMING', ids(confirming), ['Seen on-chain, waiting for enough confirmations.']);
  }
  if (settled.length > 0) {
    return out('PARTIAL_PAYMENT', ids(settled), ['Verified amount is below the amount due.']);
  }
  if (mismatched.length > 0) {
    return out('WRONG_ASSET', ids(mismatched), ['A transfer used an unsupported token or network.']);
  }
  if (proofs.some((p) => !p.matchedVerifiedPayment)) {
    return out('UNVERIFIED_PROOF', [], ['Proof was submitted but matches no verified payment.']);
  }
  const failed = attempts.filter((a) => a.status === 'FAILED' || a.status === 'REVERSED');
  const expired = now.getTime() >= order.expiresAt.getTime();
  if (failed.length > 0 && !expired) {
    return out('SAFE_TO_RETRY', ids(failed), ['Earlier attempts are confirmed failed or reversed.']);
  }
  if (expired) return out('EXPIRED', [], ['The order expired with no verified payment.']);
  return out('AWAITING_PAYMENT', [], ['No payment attempt yet.']);
}

function ids(list: AttemptFacts[]): string[] {
  return list.map((a) => a.attemptId);
}
