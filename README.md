# TRN: proof of payment for Nigerian sellers

A seller shares one payment link. The customer pays by bank transfer or stablecoin.
TRN returns one verdict (safe to ship, wait, safe to retry) from **verified evidence only**.
TRN never holds or moves money. It is a decision and evidence layer.

## Run the demo (about 2 minutes)

```bash
npm install
npm test            # 83 tests, no database needed
npm run demo        # http://127.0.0.1:3000
```

Open http://127.0.0.1:3000, click **Load demo orders**, then follow the story below.
The header says it plainly: bank and chain events are **simulated**. They enter through
the same `ingestEvent()` path that real integrations use.

### Demo story (about 2 minutes on video)

1. **Order A, bank transfer.** Select it. Verdict is *Wait* (a bank payment has started).
   Click *Says: pending*, then *Sends the same webhook again*: a message says the duplicate was ignored, and nothing changes.
   Click *+31 min* in the header: the payment becomes UNKNOWN (never FAILED) and a reconciliation case opens.
   Click *Provider answers: success*, then *+5 min*: TRN asks the provider, resolves the case, verdict becomes *Safe to ship*.
2. **Order B, screenshot.** Click *Sends a payment screenshot*: verdict *Proof not verified*. It never becomes safe to ship.
3. **Order C, stablecoin.** Click *Starts a stablecoin payment*, then *Full transfer appears*, then *New block* three times:
   *Confirming* then *Safe to ship*. Try *Chain reorganises* mid-way to show it drop back to *Wait*.
   Try *Wrong token arrives* first: *Wrong token or network*, and the real payment afterwards still works.
4. Watch **the seller's webhook inbox** at the bottom: every verdict change arrives signed, and the signature is verified.
5. Optional: *Later contradicts itself* on a paid order shows a conflict escalated instead of silently overwritten.
   Waiting *+1 hour* before a stablecoin payment shows *Paid late* (the quote expired).

## The real API (same server)

```bash
KEY="Authorization: Bearer trn_test_demo_key"
curl -X POST 127.0.0.1:3000/v1/orders -H "$KEY" -H "Idempotency-Key: demo-1" -H "content-type: application/json" \
  -d '{"merchantReference":"INV-1","amountKobo":"5000000","acceptStablecoin":true}'
curl 127.0.0.1:3000/v1/orders -H "$KEY"
```
Amounts are strings of whole kobo. `POST` requires an `Idempotency-Key`: a replay returns the stored response; the same key with a different body returns 409.
The server listens on loopback only.

## Layout

| Path | What it is |
|---|---|
| `src/domain/` | Pure logic: state machine, verdict, chain classification, signing, backoff, idempotency. No I/O. |
| `src/app/service.ts` | Use cases. Each inbound event runs in ONE transaction: dedupe, reduce, log, save, verdict, outbox. |
| `src/app/memory-store.ts` | In-memory store with rollback and nested-transaction detection. Same method surface the Prisma adapter will implement. |
| `src/app/dto.ts` | The public API shape. Storage rows never leave the server. |
| `src/chain/` | Real chain watcher: JSON-RPC client and `EvmWatcher` (logs, confirmations, reorgs, wrong token). Read-only. |
| `src/server.ts` | Zero-dependency HTTP server: `/v1` API, `/sim` simulators, `/demo` dashboard and seller receiver. |
| `demo/index.html` | The dashboard. |
| `prisma/` | Production schema and SQL constraints (written, **not yet validated** against a database). |
| `test/` | 83 tests: seeded fuzz tests of the money-safety invariants, a regression test for every audited bug, HTTP tests, and a fake EVM node for the watcher. |
| `AUDIT.md` | Every defect found, how it was proven and fixed, and what is still open. |

## Decisions that must not be reversed casually

1. **Only authoritative sources change payment status:** provider webhook, provider requery, chain observer. Seller claims and screenshots are evidence only.
2. **A timeout is UNKNOWN, never FAILED.** "Provider has no record" is inconclusive, not proof of failure.
3. **SUCCESS must carry an amount**, and the verdict checks it against the order.
4. **Authority beats time for final outcomes.** A late SUCCESS resolves UNKNOWN; a late PENDING never overwrites a final state.
5. **Two authoritative sources disagreeing on a final state is an anomaly:** event rejected, state untouched, case ESCALATED.
6. **Every inbound event is logged**, whatever its outcome. State is a projection of the log.
7. **The verdict fails closed.** Unrecognised in-flight state means "money may be moving".
8. **Money is bigint in minor units.** Quotes round up. The rate lock uses the block timestamp. Unsafe JSON numbers are rejected.
9. **Non-custodial and read-only.** The watcher only reads the chain. Deposit addresses are meant to come from the seller's public key. (Today they come from a pool or are placeholders.)
10. **Webhook payloads carry no internal tenancy data**, are signed with a timestamp, and are retried with jittered backoff, then marked DEAD.
11. **The public API is a mapper, not the storage rows.**

## Live chain mode (untested against a real node)

The watcher reads real ERC-20 `Transfer` logs. Start a local chain, deploy any 6-decimal ERC-20, then:

```bash
anvil --block-time 2        # needs Foundry
CHAIN_RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337 CHAIN_MIN_CONFIRMATIONS=3 \
CHAIN_TOKEN_CONTRACT=0xYourToken CHAIN_DEPOSIT_POOL=0xAddr1,0xAddr2 npm run demo
```

Create an order with `acceptStablecoin`, start a stablecoin payment (its deposit address comes from the pool, each used once),
then send the token to that address. The verdict moves Confirming then Safe to ship. The server refuses to start if the node
is on a different chain than `CHAIN_ID`. Do not mix the dashboard's simulated chain buttons with live mode.

## Honest limits (say these in the pitch before a judge asks)

- In the default demo, the bank provider and blockchain are **simulated**. The chain watcher is real code but has only been tested against a fake EVM node, never a real one.
- The screenshot check matches against verified payments only. There is no OCR or image forensics, and we do not claim to detect edited images.
- State is in memory. Restarting loses it. The Prisma schema in `prisma/` is the production path and has not been run.
- Partial payments are not summed across attempts or rails. USDT on BNB Chain (18 decimals) does not fit the current `BigInt` columns.
- Demo auth is one hard-coded API key. Do not deploy this server publicly.
- Nigerian regulatory treatment of stablecoin acceptance has not been reviewed by anyone qualified.
- See `AUDIT.md` for the full list of known-open issues.

## Next steps

1. Run live mode against anvil and Sepolia and fix whatever a real node does differently.
2. Prisma adapter for the store and watcher state; validate the schema and SQL (`npx prisma validate`).
3. HD address derivation from the seller's public key (needs a secp256k1/keccak library).
4. One real bank-provider sandbox behind `ProviderAdapter`, plus signed-webhook intake.
5. Human resolution for ESCALATED cases, then the NestJS wrapper.
