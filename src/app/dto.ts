import type { TrnService } from './service';

type OrderView = Awaited<ReturnType<TrnService['getOrderView']>>;

/**
 * The PUBLIC shape of an order. The API contract is this mapper, not the storage rows:
 * internal fields (tenantId, version, sequence bookkeeping, case internals) never leave the server,
 * and renaming a column cannot silently break integrators.
 */
export function toPublicOrder(v: OrderView) {
  const o = v.order;
  return {
    id: o.id,
    merchantReference: o.merchantReference,
    amountKobo: o.amountKobo,
    currency: 'NGN',
    stablecoin: o.tokenSymbol
      ? { symbol: o.tokenSymbol, amountMinor: o.tokenAmountMinor, rateKoboPerToken: o.rateKoboPerToken }
      : null,
    expiresAt: o.expiresAt,
    createdAt: o.createdAt,
    verdict: { code: v.verdict.verdict, canFulfil: v.verdict.canFulfil, blockRetry: v.verdict.blockRetry, reasons: v.verdict.reasons, flags: v.verdict.flags },
    attempts: v.attempts.filter((a) => !a.assetMismatch).map((a) => ({
      id: a.attemptId, rail: a.rail, status: a.status, receivedAmountMinor: a.receivedAmountMinor,
      paidAt: a.paidAt, depositAddress: a.depositAddress, reference: a.providerRef,
    })),
    unsupportedTransfers: v.attempts.filter((a) => a.assetMismatch).length,
    timeline: v.timeline.map((e) => ({
      at: e.receivedAt, attemptId: e.attemptId, source: e.source, from: e.fromStatus, to: e.toStatus,
      outcome: e.outcome, reason: e.reason, anomaly: e.anomaly,
    })),
    proofs: v.proofs.map((p) => ({ id: p.id, matchResult: p.matchResult, note: p.note, createdAt: p.createdAt })),
  };
}
