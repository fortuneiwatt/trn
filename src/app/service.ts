import { randomUUID } from 'node:crypto';
import { applyPaymentEvent, isTimedOut } from '../domain/payment-state-machine';
import { evaluateVerdict } from '../domain/verdict';
import type { AttemptFacts, OrderFacts, VerdictResult } from '../domain/verdict';
import { tokenAmountForNaira } from '../domain/chain';
import { nextReconciliationDelayMs, webhookRetryDelayMs, RECONCILIATION_SCHEDULE_MS } from '../domain/backoff';
import { signWebhook } from '../domain/webhook-signing';
import type { AttemptStatus, EventSource, PaymentEvent, Rail } from '../domain/types';
import type { AttemptRow, MemoryStore, OrderRow, TxStore } from './memory-store';

export class DomainError extends Error {
  constructor(public code: string, public httpStatus: number, message: string) { super(message); }
}
export interface Clock { now(): Date }
export interface ServiceConfig { orderTtlMs: number; rateLockGraceMs: number; bankMaxWaitMs: number }
export interface IngestInput {
  source: EventSource; toStatus: AttemptStatus; externalEventId?: string; occurredAt?: Date;
  sourceSequence?: number; amountMinor?: bigint; paidAt?: Date;
}
export interface IngestResult { outcome: 'APPLIED' | 'NOOP' | 'REJECTED' | 'STALE'; reason?: string; anomaly?: boolean; verdict: VerdictResult }
export interface ProviderAnswer { found: boolean; status?: 'PENDING' | 'SUCCESS' | 'FAILED'; amountMinor?: bigint }
export interface ProviderAdapter { requery(a: { attemptId: string; providerRef: string | null }): Promise<ProviderAnswer> }
export type Sender = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number }>;

const FINAL: AttemptStatus[] = ['SUCCESS', 'FAILED', 'REVERSED'];
const LEASE_MS = 30_000; // a claimed delivery / case is invisible to other workers for this long
const MAX_ORDER_KOBO = 10n ** 13n; // N100 billion

export class TrnService {
  constructor(private store: MemoryStore, private clock: Clock, private cfg: ServiceConfig) {}

  // ------------------------------------------------------------------ orders
  async createOrder(tenantId: string, input: {
    merchantReference: string; amountKobo: bigint;
    token?: { symbol: string; rateKoboPerToken: bigint; decimals: number };
  }): Promise<string> {
    if (!input.merchantReference.trim()) throw new DomainError('VALIDATION', 400, 'merchantReference is required');
    if (input.merchantReference.length > 128) throw new DomainError('VALIDATION', 400, 'merchantReference must be at most 128 characters');
    if (input.amountKobo <= 0n) throw new DomainError('VALIDATION', 400, 'amountKobo must be positive');
    if (input.amountKobo > MAX_ORDER_KOBO) throw new DomainError('VALIDATION', 400, 'amountKobo exceeds the maximum order size');
    return this.store.tx(async (s) => {
      if (s.findOrderByRef(tenantId, input.merchantReference)) {
        throw new DomainError('DUPLICATE_REFERENCE', 409, 'An order with this merchantReference already exists');
      }
      const now = this.clock.now();
      let tokenMinor: bigint | null = null;
      if (input.token) {
        try { tokenMinor = tokenAmountForNaira(input.amountKobo, input.token.rateKoboPerToken, input.token.decimals); }
        catch (e) { throw new DomainError('VALIDATION', 400, e instanceof Error ? e.message : 'Invalid stablecoin quote'); }
      }
      const o: OrderRow = {
        id: randomUUID(), tenantId, merchantReference: input.merchantReference, amountKobo: input.amountKobo,
        tokenSymbol: input.token?.symbol ?? null,
        tokenAmountMinor: tokenMinor,
        rateKoboPerToken: input.token?.rateKoboPerToken ?? null,
        expiresAt: new Date(now.getTime() + this.cfg.orderTtlMs), verdict: 'AWAITING_PAYMENT', verdictUpdatedAt: now, createdAt: now,
      };
      s.putOrder(o);
      return o.id;
    });
  }

  async createAttempt(tenantId: string, orderId: string, rail: Rail, opts: { providerRef?: string; depositAddress?: string } = {}): Promise<string> {
    return this.store.tx(async (s) => {
      const order = s.getOrder(tenantId, orderId);
      if (!order) throw new DomainError('NOT_FOUND', 404, 'Order not found');
      if (rail === 'CHAIN' && order.tokenAmountMinor === null) throw new DomainError('VALIDATION', 400, 'This order does not offer stablecoin payment');
      const now = this.clock.now();
      const id = randomUUID();
      s.insertAttempt({
        attemptId: id, tenantId, orderId, rail, status: 'INITIATED', receivedAmountMinor: null, paidAt: null,
        lastAuthoritativeAt: null, lastSequenceBySource: {}, statusChangedAt: now, providerRef: rail === 'BANK' ? (opts.providerRef ?? `BNK-${id.slice(0, 8)}`) : null,
        depositAddress: rail === 'CHAIN' ? (opts.depositAddress ?? null) : null, assetMismatch: false, version: 0, createdAt: now,
      });
      this.refreshVerdictIn(s, order, now);
      return id;
    });
  }

  // ------------------------------------------------------------------ the core: one transaction per inbound event
  async ingestEvent(tenantId: string, attemptId: string, input: IngestInput): Promise<IngestResult> {
    return this.store.tx((s) => Promise.resolve(this.ingestIn(s, tenantId, attemptId, input)));
  }

  private ingestIn(s: TxStore, tenantId: string, attemptId: string, input: IngestInput): IngestResult {
    const att = s.getAttempt(tenantId, attemptId);
    if (!att) throw new DomainError('NOT_FOUND', 404, 'Attempt not found');
    const order = s.getOrder(tenantId, att.orderId) as OrderRow;
    const now = this.clock.now();

    if (input.externalEventId && s.eventExists(attemptId, input.source, input.externalEventId)) {
      return { outcome: 'NOOP', reason: 'DUPLICATE_EXTERNAL_EVENT', verdict: this.evaluateIn(s, order, now) };
    }
    // A source cannot claim something happened in the future. Clamp, or one bad clock freezes the attempt.
    const claimed = input.occurredAt ?? now;
    if (Number.isNaN(claimed.getTime())) throw new DomainError('VALIDATION', 400, 'occurredAt is not a valid date');
    const occurredAt = claimed.getTime() > now.getTime() ? now : claimed;
    const paidAt = input.paidAt && input.paidAt.getTime() > now.getTime() ? now : input.paidAt;
    const event: PaymentEvent = {
      eventId: randomUUID(), attemptId, source: input.source, toStatus: input.toStatus,
      occurredAt, receivedAt: now,
      ...(input.sourceSequence !== undefined ? { sourceSequence: input.sourceSequence } : {}),
      ...(input.amountMinor !== undefined ? { amountMinor: input.amountMinor } : {}),
      ...(paidAt !== undefined ? { paidAt } : {}),
    };
    const res = applyPaymentEvent(att, event);

    // Every inbound claim is logged, whatever its outcome.
    s.appendEvent({
      id: event.eventId, tenantId, orderId: order.id, attemptId, source: input.source, fromStatus: att.status,
      toStatus: input.toStatus, outcome: res.outcome, reason: res.reason ?? null, anomaly: res.anomaly === true,
      externalEventId: input.externalEventId ?? null, amountMinor: input.amountMinor ?? null,
      occurredAt: event.occurredAt, receivedAt: now,
    });

    if (res.outcome === 'NOOP' && res.state !== att) s.saveAttempt({ ...att, ...res.state, version: att.version + 1 }); // keep sequence bookkeeping
    if (res.outcome === 'APPLIED') {
      s.saveAttempt({ ...att, ...res.state, version: att.version + 1 });
      const c = s.openCase(attemptId);
      if (res.state.status === 'UNKNOWN') {
        if (!c) s.putCase({ id: randomUUID(), tenantId, attemptId, status: 'OPEN', reason: 'UNKNOWN_STATUS', attemptsMade: 0,
          nextCheckAt: new Date(now.getTime() + (RECONCILIATION_SCHEDULE_MS[0] as number)), openedAt: now, escalatedAt: null, resolvedAt: null, resolution: null });
      } else if (c && FINAL.includes(res.state.status)) {
        s.putCase({ ...c, status: 'RESOLVED', nextCheckAt: null, resolvedAt: now, resolution: res.state.status });
        s.addOutbox(tenantId, 'reconciliation.resolved', { orderId: order.id, merchantReference: order.merchantReference, resolution: res.state.status }, now);
      }
    }
    if (res.anomaly) {
      const c = s.openCase(attemptId);
      if (c) s.putCase({ ...c, status: 'ESCALATED', reason: 'PROVIDER_CONFLICT', escalatedAt: now, nextCheckAt: null });
      else s.putCase({ id: randomUUID(), tenantId, attemptId, status: 'ESCALATED', reason: 'PROVIDER_CONFLICT', attemptsMade: 0, nextCheckAt: null, openedAt: now, escalatedAt: now, resolvedAt: null, resolution: null });
      s.addOutbox(tenantId, 'reconciliation.escalated', { orderId: order.id, merchantReference: order.merchantReference, reason: 'PROVIDER_CONFLICT' }, now);
    }
    const verdict = this.refreshVerdictIn(s, order, now);
    return { outcome: res.outcome, ...(res.reason ? { reason: res.reason } : {}), ...(res.anomaly ? { anomaly: true } : {}), verdict };
  }

  /** Chain watcher saw a transfer in an unsupported token or on the wrong network.
   *  Recorded as its OWN stray attempt, so the order's real deposit attempt stays usable.
   *  `ref` (e.g. "txHash:logIndex") makes repeated sightings of the same transfer a no-op. */
  async markAssetMismatch(tenantId: string, attemptId: string, reason: string, ref?: string): Promise<VerdictResult> {
    return this.store.tx(async (s) => {
      const att = s.getAttempt(tenantId, attemptId);
      if (!att) throw new DomainError('NOT_FOUND', 404, 'Attempt not found');
      const order = s.getOrder(tenantId, att.orderId) as OrderRow;
      const now = this.clock.now();
      if (ref && s.eventsForOrder(order.id).some((e) => e.externalEventId === ref && e.reason === reason)) return this.evaluateIn(s, order, now);
      const strayId = randomUUID();
      s.insertAttempt({
        attemptId: strayId, tenantId, orderId: order.id, rail: 'CHAIN', status: 'FAILED', receivedAmountMinor: null, paidAt: null,
        lastAuthoritativeAt: now, lastSequenceBySource: {}, statusChangedAt: now, providerRef: null, depositAddress: null,
        assetMismatch: true, version: 0, createdAt: now,
      });
      s.appendEvent({ id: randomUUID(), tenantId, orderId: order.id, attemptId: strayId, source: 'CHAIN_OBSERVER', fromStatus: 'FAILED', toStatus: 'FAILED',
        outcome: 'APPLIED', reason, anomaly: false, externalEventId: ref ?? null, amountMinor: null, occurredAt: now, receivedAt: now });
      return this.refreshVerdictIn(s, order, now);
    });
  }


  async submitProof(tenantId: string, orderId: string, input: { amountKobo?: bigint; reference?: string }) {
    return this.store.tx(async (s) => {
      const order = s.getOrder(tenantId, orderId);
      if (!order) throw new DomainError('NOT_FOUND', 404, 'Order not found');
      const now = this.clock.now();
      const verified = s.attemptsForOrder(orderId).filter((a) => a.status === 'SUCCESS' && !a.assetMismatch);
      const hit = verified.find((a) => input.amountKobo !== undefined && a.rail === 'BANK' && a.receivedAmountMinor === input.amountKobo);
      const elsewhere = input.reference
        ? s.allAttempts().find((a) => a.tenantId === tenantId && a.orderId !== orderId && a.providerRef === input.reference)
        : undefined;
      const note = hit ? 'Matches a verified payment on this order.'
        : elsewhere ? 'Reference belongs to a different order. Possible reused screenshot.'
        : 'No verified payment on this order matches this proof.';
      s.addProof({ id: randomUUID(), tenantId, orderId, amountKobo: input.amountKobo ?? null, reference: input.reference ?? null,
        matchResult: hit ? 'MATCHED' : 'NO_MATCH', note, createdAt: now });
      const verdict = this.refreshVerdictIn(s, order, now);
      return { matchResult: hit ? 'MATCHED' : 'NO_MATCH', note, verdict };
    });
  }

  // ------------------------------------------------------------------ background work (call on a timer)
  /** Bank attempts that waited too long become UNKNOWN (never FAILED); stale verdicts are refreshed. */
  async sweep(): Promise<{ timedOut: number; refreshed: number }> {
    const now = this.clock.now();
    const stale = await this.store.tx(async (s) => s.allAttempts().filter((a) => isTimedOut(a, now, this.cfg.bankMaxWaitMs)));
    for (const a of stale) {
      await this.ingestEvent(a.tenantId, a.attemptId, { source: 'TRN_TIMEOUT', toStatus: 'UNKNOWN', occurredAt: now });
    }
    let refreshed = 0;
    await this.store.tx(async (s) => {
      for (const t of new Set([...s.d.orders.values()].map((o) => o.tenantId))) {
        for (const o of s.listOrders(t)) { const before = o.verdict; if (this.refreshVerdictIn(s, o, now).verdict !== before) refreshed++; }
      }
    });
    return { timedOut: stale.length, refreshed };
  }

  /** Ask the provider about due UNKNOWN cases. "Not found" is inconclusive, never proof of failure. */
  async runReconciliation(provider: ProviderAdapter): Promise<number> {
    const now = this.clock.now();
    const due = await this.store.tx(async (s) => s.dueCases(now).map((c) => {
      s.putCase({ ...c, nextCheckAt: new Date(now.getTime() + LEASE_MS) }); // lease: overlapping runs skip it
      return { c, a: s.d.attempts.get(c.attemptId) as AttemptRow };
    }));
    for (const { c, a } of due) {
      let answer: ProviderAnswer;
      try { answer = await provider.requery({ attemptId: a.attemptId, providerRef: a.providerRef }); }
      catch { answer = { found: false }; }
      await this.store.tx(async (s) => {
        const cur = s.getCase(c.id);
        if (!cur || cur.status === 'RESOLVED') return;
        const conclusive = answer.found && (answer.status === 'SUCCESS' || answer.status === 'FAILED');
        s.addVerification({ id: randomUUID(), caseId: c.id, at: now, conclusive,
          note: !answer.found ? 'Provider has no record (inconclusive, not a failure)' : `Provider says ${answer.status}` });
        if (answer.found && answer.status) {
          this.ingestIn(s, a.tenantId, a.attemptId, {
            source: 'PROVIDER_REQUERY', toStatus: answer.status, occurredAt: now,
            ...(answer.amountMinor !== undefined ? { amountMinor: answer.amountMinor } : {}),
          });
        }
        const after = s.getCase(c.id) as typeof cur; // ingestIn may have resolved it
        if (after.status === 'RESOLVED') return;
        const made = after.attemptsMade + 1;
        const delay = nextReconciliationDelayMs(made);
        if (delay === null) {
          s.putCase({ ...after, attemptsMade: made, status: 'ESCALATED', nextCheckAt: null, escalatedAt: now });
          const o = s.getOrder(a.tenantId, a.orderId) as OrderRow;
          s.addOutbox(a.tenantId, 'reconciliation.escalated', { orderId: o.id, merchantReference: o.merchantReference, reason: 'RETRY_BUDGET_EXHAUSTED' }, now);
        } else {
          s.putCase({ ...after, attemptsMade: made, status: 'VERIFYING', nextCheckAt: new Date(now.getTime() + delay) });
        }
      });
    }
    return due.length;
  }

  // ------------------------------------------------------------------ outbox -> signed webhooks
  async relayOutbox(): Promise<number> {
    return this.store.tx(async (s) => {
      const rows = s.unpublished(100);
      const now = this.clock.now();
      for (const r of rows) {
        for (const ep of s.endpointsFor(r.tenantId)) {
          const eventId = `evt_${r.id}`;
          const body = JSON.stringify({ eventId, eventType: r.eventType, createdAt: r.createdAt.toISOString(), data: r.payload }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
          s.putDelivery({ id: randomUUID(), tenantId: r.tenantId, endpointId: ep.id, eventId, eventType: r.eventType, body,
            status: 'PENDING', attemptCount: 0, nextAttemptAt: null, lastResponseCode: null, lastError: null, deliveredAt: null });
        }
        s.markPublished(r.id, now);
      }
      return rows.length;
    });
  }

  async deliverDue(send: Sender, rand: () => number = Math.random): Promise<number> {
    const now = this.clock.now();
    const due = await this.store.tx(async (s) => s.dueDeliveries(now).map((d) => {
      s.putDelivery({ ...d, nextAttemptAt: new Date(now.getTime() + LEASE_MS) }); // lease: overlapping runs skip it
      return { d, ep: s.getEndpoint(d.endpointId) };
    }));
    for (const { d, ep } of due) {
      let code: number | null = null; let err: string | null = null;
      if (ep) {
        const sig = signWebhook(ep.secrets, d.body, Math.floor(now.getTime() / 1000));
        try { code = (await send(ep.url, { 'content-type': 'application/json', 'trn-signature': sig, 'trn-event-id': d.eventId }, d.body)).status; }
        catch (e) { err = e instanceof Error ? e.message : 'send failed'; }
      } else err = 'endpoint missing';
      await this.store.tx(async (s) => {
        const ok = code !== null && code >= 200 && code < 300;
        const attemptCount = d.attemptCount + 1;
        const delay = ok ? null : webhookRetryDelayMs(attemptCount, rand);
        s.putDelivery({ ...d, attemptCount, lastResponseCode: code, lastError: ok ? null : (err ?? `HTTP ${code}`),
          status: ok ? 'DELIVERED' : delay === null ? 'DEAD' : 'FAILED',
          nextAttemptAt: ok || delay === null ? null : new Date(now.getTime() + delay), deliveredAt: ok ? now : null });
      });
    }
    return due.length;
  }

  /** Deposit addresses worth watching: chain attempts on orders that are not yet settled. */
  async listWatchedDeposits() {
    return this.store.tx(async (s) => s.allAttempts()
      .filter((a) => a.rail === 'CHAIN' && a.depositAddress !== null && !a.assetMismatch)
      .filter((a) => s.d.orders.get(a.orderId)?.verdict !== 'SAFE_TO_SHIP')
      .map((a) => ({ tenantId: a.tenantId, orderId: a.orderId, attemptId: a.attemptId, depositAddress: a.depositAddress as string })));
  }

  // ------------------------------------------------------------------ reads
  async getOrderView(tenantId: string, orderId: string) {
    return this.store.tx(async (s) => {
      const o = s.getOrder(tenantId, orderId);
      if (!o) throw new DomainError('NOT_FOUND', 404, 'Order not found');
      return this.viewIn(s, o);
    });
  }
  async listOrderViews(tenantId: string) {
    return this.store.tx(async (s) => s.listOrders(tenantId).map((o) => this.viewIn(s, o)));
  }
  async snapshot() {
    return this.store.tx(async (s) => ({
      cases: s.allCases().map((c) => ({ ...c, verifications: s.verificationsFor(c.id) })),
      deliveries: s.allDeliveries().map((d) => ({ eventId: d.eventId, eventType: d.eventType, status: d.status, attemptCount: d.attemptCount, lastResponseCode: d.lastResponseCode })),
    }));
  }
  /** Raw store access for the demo server's tenant/endpoint seeding only. */
  seed<T>(fn: (s: TxStore) => T): Promise<T> { return this.store.tx(async (s) => fn(s)); }

  // ------------------------------------------------------------------ helpers
  private viewIn(s: TxStore, o: OrderRow) {
    const now = this.clock.now();
    const attempts = s.attemptsForOrder(o.id);
    return {
      order: o, verdict: this.evaluateIn(s, o, now), attempts,
      timeline: s.eventsForOrder(o.id), proofs: s.proofsForOrder(o.id),
      cases: attempts.map((a) => s.openCase(a.attemptId)).filter((c) => c !== null),
    };
  }
  private factsIn(s: TxStore, o: OrderRow): { order: OrderFacts; attempts: AttemptFacts[] } {
    return {
      order: { requiredBankKobo: o.amountKobo, requiredTokenMinor: o.tokenAmountMinor, expiresAt: o.expiresAt, rateLockGraceMs: this.cfg.rateLockGraceMs },
      attempts: s.attemptsForOrder(o.id).map((a) => ({ attemptId: a.attemptId, rail: a.rail, status: a.status,
        receivedAmountMinor: a.receivedAmountMinor, paidAt: a.paidAt, assetMismatch: a.assetMismatch })),
    };
  }
  private evaluateIn(s: TxStore, o: OrderRow, now: Date): VerdictResult {
    const f = this.factsIn(s, o);
    const proofs = s.proofsForOrder(o.id).map((p) => ({ proofId: p.id, matchedVerifiedPayment: p.matchResult === 'MATCHED' }));
    return evaluateVerdict(f.order, f.attempts, proofs, now);
  }
  /** Recompute from facts; if the verdict changed, update the cache and write an outbox row in the SAME transaction. */
  private refreshVerdictIn(s: TxStore, o: OrderRow, now: Date): VerdictResult {
    const cur = s.getOrder(o.tenantId, o.id) as OrderRow;
    const v = this.evaluateIn(s, cur, now);
    if (v.verdict !== cur.verdict) {
      s.putOrder({ ...cur, verdict: v.verdict, verdictUpdatedAt: now });
      s.addOutbox(cur.tenantId, 'payment.verdict_changed', {
        orderId: cur.id, merchantReference: cur.merchantReference, previous: cur.verdict, verdict: v.verdict,
        canFulfil: v.canFulfil, blockRetry: v.blockRetry, reasons: v.reasons, flags: v.flags,
      }, now);
    }
    return v;
  }
}
