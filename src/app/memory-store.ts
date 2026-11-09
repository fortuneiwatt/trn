import { AsyncLocalStorage } from 'node:async_hooks';
import type { AttemptState, AttemptStatus, EventSource, Rail } from '../domain/types';
import type { Verdict } from '../domain/verdict';

/**
 * In-memory store with the SAME method surface the Prisma adapter will implement.
 * `tx()` serialises callers and ROLLS BACK every write if the callback throws,
 * which is what a real DB transaction gives us. The service never touches data
 * outside `tx()`.
 */
export interface OrderRow {
  id: string; tenantId: string; merchantReference: string; amountKobo: bigint;
  tokenSymbol: string | null; tokenAmountMinor: bigint | null; rateKoboPerToken: bigint | null;
  expiresAt: Date; verdict: Verdict; verdictUpdatedAt: Date; createdAt: Date;
}
export interface AttemptRow extends AttemptState {
  tenantId: string; orderId: string; providerRef: string | null; depositAddress: string | null;
  assetMismatch: boolean; version: number; createdAt: Date;
}
export interface EventRow {
  id: string; tenantId: string; orderId: string; attemptId: string; source: EventSource;
  fromStatus: AttemptStatus; toStatus: AttemptStatus; outcome: 'APPLIED' | 'NOOP' | 'REJECTED' | 'STALE';
  reason: string | null; anomaly: boolean; externalEventId: string | null;
  amountMinor: bigint | null; occurredAt: Date; receivedAt: Date;
}
export type CaseStatus = 'OPEN' | 'VERIFYING' | 'ESCALATED' | 'RESOLVED';
export interface CaseRow {
  id: string; tenantId: string; attemptId: string; status: CaseStatus; reason: string;
  attemptsMade: number; nextCheckAt: Date | null; openedAt: Date; escalatedAt: Date | null;
  resolvedAt: Date | null; resolution: string | null;
}
export interface VerificationRow { id: string; caseId: string; at: Date; conclusive: boolean; note: string }
export interface ProofRow {
  id: string; tenantId: string; orderId: string; amountKobo: bigint | null; reference: string | null;
  matchResult: 'MATCHED' | 'NO_MATCH'; note: string; createdAt: Date;
}
export interface OutboxRow { id: number; tenantId: string; eventType: string; payload: unknown; createdAt: Date; publishedAt: Date | null }
export interface EndpointRow { id: string; tenantId: string; url: string; secrets: string[] }
export interface DeliveryRow {
  id: string; tenantId: string; endpointId: string; eventId: string; eventType: string; body: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD'; attemptCount: number; nextAttemptAt: Date | null;
  lastResponseCode: number | null; lastError: string | null; deliveredAt: Date | null;
}
export interface IdemRow { requestHash: string; responseStatus: number | null; responseBody: unknown }

interface Data {
  orders: Map<string, OrderRow>; attempts: Map<string, AttemptRow>; events: EventRow[];
  cases: Map<string, CaseRow>; verifications: VerificationRow[]; proofs: ProofRow[];
  outbox: OutboxRow[]; endpoints: Map<string, EndpointRow>; deliveries: Map<string, DeliveryRow>;
  idem: Map<string, IdemRow>; outboxSeq: number;
}
const OPEN: CaseStatus[] = ['OPEN', 'VERIFYING', 'ESCALATED'];

export class TxStore {
  constructor(public d: Data) {}
  // orders
  findOrderByRef(t: string, ref: string) { return [...this.d.orders.values()].find((o) => o.tenantId === t && o.merchantReference === ref) ?? null; }
  getOrder(t: string, id: string) { const o = this.d.orders.get(id); return o && o.tenantId === t ? o : null; }
  listOrders(t: string) { return [...this.d.orders.values()].filter((o) => o.tenantId === t).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); }
  putOrder(o: OrderRow) { this.d.orders.set(o.id, o); }
  // attempts (optimistic lock)
  getAttempt(t: string, id: string) { const a = this.d.attempts.get(id); return a && a.tenantId === t ? a : null; }
  attemptsForOrder(orderId: string) { return [...this.d.attempts.values()].filter((a) => a.orderId === orderId); }
  allAttempts() { return [...this.d.attempts.values()]; }
  insertAttempt(a: AttemptRow) { this.d.attempts.set(a.attemptId, a); }
  saveAttempt(a: AttemptRow) {
    const cur = this.d.attempts.get(a.attemptId);
    if (!cur || cur.version !== a.version - 1) throw new Error('OPTIMISTIC_LOCK_CONFLICT');
    this.d.attempts.set(a.attemptId, a);
  }
  // events: append-only, deduped on (attemptId, source, externalEventId)
  eventExists(attemptId: string, source: EventSource, ext: string) {
    return this.d.events.some((e) => e.attemptId === attemptId && e.source === source && e.externalEventId === ext);
  }
  appendEvent(e: EventRow) { this.d.events.push(Object.freeze({ ...e }) as EventRow); }
  eventsForOrder(orderId: string) { return this.d.events.filter((e) => e.orderId === orderId); }
  // reconciliation
  openCase(attemptId: string) { return [...this.d.cases.values()].find((c) => c.attemptId === attemptId && OPEN.includes(c.status)) ?? null; }
  putCase(c: CaseRow) { this.d.cases.set(c.id, c); }
  getCase(id: string) { return this.d.cases.get(id) ?? null; }
  dueCases(now: Date) { return [...this.d.cases.values()].filter((c) => (c.status === 'OPEN' || c.status === 'VERIFYING') && c.nextCheckAt !== null && c.nextCheckAt <= now); }
  allCases() { return [...this.d.cases.values()]; }
  addVerification(v: VerificationRow) { this.d.verifications.push(v); }
  verificationsFor(caseId: string) { return this.d.verifications.filter((v) => v.caseId === caseId); }
  // proofs
  addProof(p: ProofRow) { this.d.proofs.push(p); }
  proofsForOrder(orderId: string) { return this.d.proofs.filter((p) => p.orderId === orderId); }
  // outbox + webhooks
  addOutbox(tenantId: string, eventType: string, payload: unknown, at: Date) { this.d.outbox.push({ id: ++this.d.outboxSeq, tenantId, eventType, payload, createdAt: at, publishedAt: null }); }
  unpublished(limit: number) { return this.d.outbox.filter((o) => o.publishedAt === null).slice(0, limit); }
  markPublished(id: number, at: Date) { const o = this.d.outbox.find((x) => x.id === id); if (o) o.publishedAt = at; }
  endpointsFor(t: string) { return [...this.d.endpoints.values()].filter((e) => e.tenantId === t); }
  getEndpoint(id: string) { return this.d.endpoints.get(id) ?? null; }
  putEndpoint(e: EndpointRow) { this.d.endpoints.set(e.id, e); }
  putDelivery(x: DeliveryRow) { this.d.deliveries.set(x.id, x); }
  dueDeliveries(now: Date) { return [...this.d.deliveries.values()].filter((x) => (x.status === 'PENDING' || x.status === 'FAILED') && (x.nextAttemptAt === null || x.nextAttemptAt <= now)); }
  allDeliveries() { return [...this.d.deliveries.values()]; }
  // idempotency
  getIdem(t: string, key: string) { return this.d.idem.get(`${t}:${key}`) ?? null; }
  putIdem(t: string, key: string, r: IdemRow) { this.d.idem.set(`${t}:${key}`, r); }
  deleteIdem(t: string, key: string) { this.d.idem.delete(`${t}:${key}`); }
}

export class MemoryStore {
  private d: Data = {
    orders: new Map(), attempts: new Map(), events: [], cases: new Map(), verifications: [], proofs: [],
    outbox: [], endpoints: new Map(), deliveries: new Map(), idem: new Map(), outboxSeq: 0,
  };
  private chain: Promise<unknown> = Promise.resolve();
  private als = new AsyncLocalStorage<true>();

  tx<T>(fn: (s: TxStore) => Promise<T>): Promise<T> {
    // A nested tx() would wait for itself forever. Fail loudly instead of hanging.
    if (this.als.getStore()) return Promise.reject(new Error('NESTED_TRANSACTION: call the *In(s, ...) helpers inside a transaction, not tx() again'));
    const run = async (): Promise<T> => {
      const snapshot = structuredClone(this.d);
      try {
        return await this.als.run(true, () => fn(new TxStore(this.d)));
      } catch (e) {
        this.d = snapshot; // rollback: nothing from this transaction survives
        throw e;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
export type { Rail };
