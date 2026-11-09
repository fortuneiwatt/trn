/**
 * TRN demo server. Zero runtime dependencies (node:http only).
 *   /v1/*    the real, authenticated API (Bearer key, Idempotency-Key on POST)
 *   /sim/*   SIMULATED bank provider + chain watcher + clock, for the demo only
 *   /demo/*  dashboard + seller webhook receiver
 * Everything simulated feeds the SAME ingestEvent() path real integrations will use.
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { MemoryStore } from './app/memory-store';
import { DomainError, TrnService } from './app/service';
import { toPublicOrder } from './app/dto';
import { EvmWatcher } from './chain/evm-watcher';
import { HttpRpc } from './chain/rpc';
import type { ProviderAdapter, ProviderAnswer } from './app/service';
import { classifyTransfer } from './domain/chain';
import type { ChainConfig } from './domain/chain';
import { decideIdempotency, requestFingerprint } from './domain/idempotency';
import { verifyWebhook } from './domain/webhook-signing';

export function createApp(opts: { port?: number; host?: string } = {}) {
let PORT = opts.port ?? Number(process.env.PORT ?? 3000);
const HOST = opts.host ?? process.env.HOST ?? '127.0.0.1'; // loopback only: the demo has no real auth on /sim
const TENANT = 'demo-tenant';
const API_KEY = 'trn_test_demo_key';
const WEBHOOK_SECRET = 'whsec_demo';
const MIN = 60_000;

// ---- demo clock: lets the demo jump 31 minutes in one click -------------------------------
let offsetMs = 0;
const clock = { now: () => new Date(Date.now() + offsetMs) };

const store = new MemoryStore();
const svc = new TrnService(store, clock, { orderTtlMs: 60 * MIN, rateLockGraceMs: MIN, bankMaxWaitMs: 30 * MIN });
const keyToTenant = new Map([[createHash('sha256').update(API_KEY).digest('hex'), TENANT]]);

const CHAIN: ChainConfig = {
  chainId: Number(process.env.CHAIN_ID ?? 31337), minConfirmations: Number(process.env.CHAIN_MIN_CONFIRMATIONS ?? 3),
  tokens: [{ symbol: 'USDT', contract: process.env.CHAIN_TOKEN_CONTRACT ?? '0x5fbdb2315678afecb367f032d93f642f64180aa3', decimals: Number(process.env.CHAIN_TOKEN_DECIMALS ?? 6) }],
};
const TOKEN = { symbol: 'USDT', rateKoboPerToken: 150_000n, decimals: CHAIN.tokens[0]!.decimals }; // demo rate: N1,500 per USDT
// Live mode: real, pre-funded addresses (e.g. anvil accounts), each handed out ONCE. Real HD derivation from the
// seller's public key needs a secp256k1/keccak library and is the next step.
const POOL = (process.env.CHAIN_DEPOSIT_POOL ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
let poolNext = 0;

// ---- simulated bank provider ---------------------------------------------------------------
const providerAnswers = new Map<string, ProviderAnswer>();
const provider: ProviderAdapter = { requery: async ({ attemptId }) => providerAnswers.get(attemptId) ?? { found: false } };
const lastBankEvent = new Map<string, string>();
let seedBatch = 1000;

// ---- simulated chain watcher ---------------------------------------------------------------
interface SimTransfer { amountMinor: bigint; blockTime: Date; confirmations: number; removed: boolean }
const transfers = new Map<string, SimTransfer>();

// ---- the seller's own webhook receiver (verifies our signature, dedupes on eventId) -------------
const inbox: { eventId: string; eventType: string; verified: boolean; duplicate: boolean; at: string; data: unknown }[] = [];
const seenEvents = new Set<string>();

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (res: http.ServerResponse, status: number, body: unknown, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? json(body) : (body as string));
};
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 1_000_000) throw new DomainError('TOO_LARGE', 413, 'Body too large'); chunks.push(c as Buffer); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { throw new DomainError('BAD_JSON', 400, 'Body must be valid JSON'); }
}
const kobo = (v: unknown, field: string): bigint => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new DomainError('VALIDATION', 400, `${field} is required`);
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new DomainError('VALIDATION', 400, `${field} is not a safe whole number; send large amounts as a string`);
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new DomainError('VALIDATION', 400, `${field} must be a whole number of kobo`);
  return BigInt(s);
};
const demoAddress = () => {
  if (POOL.length === 0) return `0x${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 40)}`; // placeholder, simulator only
  const a = POOL[poolNext++];
  if (!a) throw new DomainError('POOL_EXHAUSTED', 503, 'No unused deposit addresses left. Restart, or add more to CHAIN_DEPOSIT_POOL.');
  return a;
};

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const m = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean);

  // ---------------- dashboard ----------------
  if (m === 'GET' && (path === '/' || path === '/demo')) return send(res, 200, readFileSync(join(__dirname, '..', 'demo', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  if (m === 'GET' && path === '/demo/state') {
    const [orders, snap] = await Promise.all([svc.listOrderViews(TENANT), svc.snapshot()]);
    return send(res, 200, { now: clock.now(), orders, cases: snap.cases, deliveries: snap.deliveries, inbox: inbox.slice(-10).reverse(), providerAnswers: Object.fromEntries(providerAnswers) });
  }
  if (m === 'POST' && path === '/demo/seller-webhook') {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const sig = String(req.headers['trn-signature'] ?? '');
    const ok = verifyWebhook([WEBHOOK_SECRET], sig, body, Math.floor(clock.now().getTime() / 1000)).ok;
    if (!ok) return send(res, 401, { error: { code: 'BAD_SIGNATURE', message: 'Signature check failed' } });
    const evt = JSON.parse(body) as { eventId: string; eventType: string; data: unknown };
    const duplicate = seenEvents.has(evt.eventId); seenEvents.add(evt.eventId);
    inbox.push({ eventId: evt.eventId, eventType: evt.eventType, verified: true, duplicate, at: clock.now().toISOString(), data: evt.data });
    if (inbox.length > 200) inbox.shift();
    return send(res, 200, { received: true });
  }

  // ---------------- simulator (clearly NOT real integrations) ----------------
  if (seg[0] === 'sim' && m === 'POST') {
    const b = await readJson(req);
    if (seg[1] === 'seed') {
      const n = ++seedBatch; // unique per click, so double-clicking never collides
      const o1 = await svc.createOrder(TENANT, { merchantReference: `ORD-${n}-A`, amountKobo: 5_000_000n, token: TOKEN });
      const o2 = await svc.createOrder(TENANT, { merchantReference: `ORD-${n}-B`, amountKobo: 2_000_000n, token: TOKEN });
      const o3 = await svc.createOrder(TENANT, { merchantReference: `ORD-${n}-C`, amountKobo: 3_500_000n, token: TOKEN });
      await svc.createAttempt(TENANT, o1, 'BANK');
      await svc.createAttempt(TENANT, o3, 'CHAIN', { depositAddress: demoAddress() });
      return send(res, 200, { ok: true, orders: [o1, o2, o3] });
    }
    if (seg[1] === 'tick') {
      const mins = b.minutes;
      if (typeof mins !== 'number' || !Number.isFinite(mins) || mins < 0 || mins > 24 * 60) throw new DomainError('VALIDATION', 400, 'minutes must be a number between 0 and 1440');
      offsetMs += mins * MIN; await background(); return send(res, 200, { now: clock.now() }); }
    if (seg[1] === 'reset-clock') { offsetMs = 0; return send(res, 200, { now: clock.now() }); }
    if (seg[1] === 'orders' && seg[2] && seg[3] === 'attempt') {
      const rail = b.rail === 'CHAIN' ? 'CHAIN' : 'BANK';
      const id = await svc.createAttempt(TENANT, seg[2], rail, rail === 'CHAIN' ? { depositAddress: demoAddress() } : {});
      return send(res, 200, { attemptId: id });
    }
    if (seg[1] === 'orders' && seg[2] && seg[3] === 'proof') {
      return send(res, 200, await svc.submitProof(TENANT, seg[2], { amountKobo: kobo(b.amountKobo, 'amountKobo'), reference: String(b.reference ?? 'SCREENSHOT-1') }));
    }
    if (seg[1] === 'bank' && seg[2] && seg[3]) {
      const id = seg[2]; const view = await findOrderOfAttempt(id, 'BANK'); const act = seg[3];
      if (act === 'replay') {
        const ext = lastBankEvent.get(id); if (!ext) throw new DomainError('VALIDATION', 400, 'No webhook to replay yet');
        return send(res, 200, await svc.ingestEvent(TENANT, id, { source: 'PROVIDER_WEBHOOK', toStatus: 'PENDING', externalEventId: ext }));
      }
      if (act === 'conflict') return send(res, 200, await svc.ingestEvent(TENANT, id, { source: 'PROVIDER_REQUERY', toStatus: 'FAILED' }));
      const to = act === 'pending' ? 'PENDING' : act === 'success' ? 'SUCCESS' : act === 'failed' ? 'FAILED' : null;
      if (!to) throw new DomainError('VALIDATION', 400, 'Unknown bank action');
      const ext = `prov_${randomUUID().slice(0, 8)}`; lastBankEvent.set(id, ext);
      return send(res, 200, await svc.ingestEvent(TENANT, id, { source: 'PROVIDER_WEBHOOK', toStatus: to, externalEventId: ext, ...(to === 'SUCCESS' ? { amountMinor: view.amountKobo } : {}) }));
    }
    if (seg[1] === 'provider' && seg[2] && seg[3]) {
      const view = await findOrderOfAttempt(seg[2], 'BANK'); const a = seg[3];
      if (a === 'notfound') providerAnswers.set(seg[2], { found: false });
      else providerAnswers.set(seg[2], { found: true, status: a === 'success' ? 'SUCCESS' : a === 'failed' ? 'FAILED' : 'PENDING', ...(a === 'success' ? { amountMinor: view.amountKobo } : {}) });
      return send(res, 200, { ok: true });
    }
    if (seg[1] === 'chain' && seg[2] && seg[3]) return send(res, 200, await chainAction(seg[2], seg[3]));
    throw new DomainError('NOT_FOUND', 404, 'Unknown simulator route');
  }

  // ---------------- real API (/v1) ----------------
  if (seg[0] === 'v1') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const tenant = keyToTenant.get(createHash('sha256').update(token).digest('hex'));
    if (!tenant) throw new DomainError('UNAUTHENTICATED', 401, 'Missing or invalid API key');
    if (seg[1] === 'orders' && !seg[2] && m === 'GET') return send(res, 200, { data: (await svc.listOrderViews(tenant)).map(toPublicOrder) });
    if (seg[1] === 'orders' && seg[2] && !seg[3] && m === 'GET') return send(res, 200, toPublicOrder(await svc.getOrderView(tenant, seg[2])));
    if (m === 'POST' && seg[1] === 'orders') {
      const body = await readJson(req);
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!key) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Send an Idempotency-Key header on POST requests');
      const fp = requestFingerprint(m, path, body);
      // check + claim in ONE transaction, so two concurrent identical requests cannot both proceed
      const d = await svc.seed((s) => {
        const dec = decideIdempotency(s.getIdem(tenant, key), fp);
        if (dec.action === 'PROCESS') s.putIdem(tenant, key, { requestHash: fp, responseStatus: null, responseBody: null });
        return dec;
      });
      if (d.action === 'REPLAY') return send(res, d.status, d.body);
      if (d.action === 'CONFLICT') throw new DomainError(d.reason, 409, d.reason === 'REQUEST_IN_PROGRESS' ? 'A request with this key is still running' : 'This Idempotency-Key was used with a different request');
      let status = 201; let out: unknown;
      try {
        if (!seg[2]) {
          const id = await svc.createOrder(tenant, { merchantReference: String(body.merchantReference ?? ''), amountKobo: kobo(body.amountKobo, 'amountKobo'), ...(body.acceptStablecoin ? { token: TOKEN } : {}) });
          out = toPublicOrder(await svc.getOrderView(tenant, id));
        } else if (seg[3] === 'attempts') {
          const rail = body.rail === 'CHAIN' ? 'CHAIN' : 'BANK';
          const id = await svc.createAttempt(tenant, seg[2], rail, rail === 'CHAIN' ? { depositAddress: demoAddress() } : {});
          out = { attemptId: id };
        } else if (seg[3] === 'proofs') {
          out = await svc.submitProof(tenant, seg[2], { amountKobo: kobo(body.amountKobo, 'amountKobo'), ...(body.reference ? { reference: String(body.reference) } : {}) }); status = 200;
        } else throw new DomainError('NOT_FOUND', 404, 'Unknown route');
      } catch (e) {
        if (e instanceof DomainError) { status = e.httpStatus; out = { error: { code: e.code, message: e.message } }; } else { await svc.seed((s) => s.deleteIdem(tenant, key)); throw e; }
      }
      await svc.seed((s) => s.putIdem(tenant, key, { requestHash: fp, responseStatus: status, responseBody: JSON.parse(json(out)) }));
      return send(res, status, out);
    }
  }
  throw new DomainError('NOT_FOUND', 404, 'Route not found');
}

async function findOrderOfAttempt(attemptId: string, rail: 'BANK' | 'CHAIN'): Promise<{ amountKobo: bigint; tokenAmountMinor: bigint | null }> {
  for (const v of await svc.listOrderViews(TENANT)) {
    const a = v.attempts.find((x) => x.attemptId === attemptId);
    if (!a) continue;
    if (a.rail !== rail || a.assetMismatch) throw new DomainError('VALIDATION', 400, `That attempt is not a ${rail === 'BANK' ? 'bank' : 'stablecoin'} payment`);
    return { amountKobo: v.order.amountKobo, tokenAmountMinor: v.order.tokenAmountMinor };
  }
  throw new DomainError('NOT_FOUND', 404, 'Attempt not found');
}

async function chainAction(attemptId: string, action: string) {
  const o = await findOrderOfAttempt(attemptId, 'CHAIN');
  const now = clock.now();
  let t = transfers.get(attemptId);
  let contract = CHAIN.tokens[0]!.contract;
  if (action === 'seen' || action === 'under' || action === 'wrong') {
    if (action === 'wrong') {
      contract = '0xdac17f958d2ee523a2206206994597c13d831ec7'; // a token we do not accept
      const c = classifyTransfer({ chainId: CHAIN.chainId, tokenContract: contract, amountMinor: 1n, confirmations: 3, reverted: false, removed: false }, CHAIN);
      return svc.markAssetMismatch(TENANT, attemptId, c.kind === 'WRONG_ASSET' ? c.reason : 'UNSUPPORTED_TOKEN');
    }
    const full = o.tokenAmountMinor as bigint;
    t = { amountMinor: action === 'under' ? (full * 3n) / 10n : full, blockTime: now, confirmations: 0, removed: false };
    transfers.set(attemptId, t);
  } else if (action === 'confirm') {
    if (!t) throw new DomainError('VALIDATION', 400, 'No transfer seen yet');
    if (t.removed) { t.removed = false; t.confirmations = 1; t.blockTime = now; } else t.confirmations += 1;
  } else if (action === 'reorg') {
    if (!t) throw new DomainError('VALIDATION', 400, 'No transfer seen yet');
    t.removed = true;
  } else throw new DomainError('VALIDATION', 400, 'Unknown chain action');
  const c = classifyTransfer({ chainId: CHAIN.chainId, tokenContract: contract, amountMinor: t!.amountMinor, confirmations: t!.confirmations, reverted: false, removed: t!.removed }, CHAIN);
  if (c.kind === 'WRONG_ASSET') return svc.markAssetMismatch(TENANT, attemptId, c.reason);
  return svc.ingestEvent(TENANT, attemptId, {
    source: 'CHAIN_OBSERVER', toStatus: c.status, occurredAt: now,
    ...(c.status === 'SUCCESS' ? { amountMinor: t!.amountMinor, paidAt: t!.blockTime } : {}),
  });
}

let running = false;
async function background() {
  if (running) return; // never overlap with a previous (possibly slow) run
  running = true;
  try {
    await svc.sweep();
    await svc.runReconciliation(provider);
    await svc.relayOutbox();
    await svc.deliverDue(async (u, headers, body) => { const r = await fetch(u, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) }); return { status: r.status }; });
  } catch (e) { console.error('background error', e); } finally { running = false; }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof DomainError) return send(res, e.httpStatus, { error: { code: e.code, message: e.message } });
    console.error(e); send(res, 500, { error: { code: 'INTERNAL', message: 'Internal error' } });
  });
});
let timer: ReturnType<typeof setInterval> | undefined;
let watchTimer: ReturnType<typeof setInterval> | undefined;
async function start(): Promise<number> {
  await new Promise<void>((ok) => server.listen(PORT, HOST, ok));
  PORT = (server.address() as AddressInfo).port;
  await svc.seed((s) => s.putEndpoint({ id: 'ep-demo', tenantId: TENANT, url: `http://127.0.0.1:${PORT}/demo/seller-webhook`, secrets: [WEBHOOK_SECRET] }));
  timer = setInterval(background, 1000); timer.unref();
  if (process.env.CHAIN_RPC_URL) { // LIVE chain mode
    const watcher = new EvmWatcher({ rpc: new HttpRpc(process.env.CHAIN_RPC_URL), svc, chain: CHAIN, onError: (e) => console.error('chain watcher:', e) });
    await watcher.init(); // fails loudly if the node is on the wrong network
    let busy = false;
    watchTimer = setInterval(() => { if (busy) return; busy = true; watcher.tick().catch((e) => console.error('chain watcher tick:', e)).finally(() => { busy = false; }); }, 2000);
    watchTimer.unref();
    console.log(`Live chain watcher on chain ${CHAIN.chainId} via ${process.env.CHAIN_RPC_URL}`);
  }
  return PORT;
}
async function stop(): Promise<void> {
  if (timer) clearInterval(timer);
  if (watchTimer) clearInterval(watchTimer);
  await new Promise<void>((ok) => server.close(() => ok()));
}
return { start, stop, background, svc, apiKey: API_KEY, host: HOST };
}

if (require.main === module) {
  const app = createApp();
  void app.start().then((p) => console.log(`TRN demo on http://${app.host}:${p}   (API key: ${app.apiKey})`));
}
