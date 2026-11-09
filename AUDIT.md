# Audit log

Method: re-read all code, write a **failing test first** to prove each suspected defect is real,
then fix, then keep the test. Server and browser behaviour was probed over real HTTP and in a headless browser.
Watcher tests were mutation-checked (deliberately breaking the code to confirm the tests notice).

## Found and fixed

| # | Defect | Why it mattered | Fix | Guarded by |
|---|---|---|---|---|
| 1 | Verdict ignored attempts in impossible rail/status combos | Could say "safe to retry" while money was in flight | Fail closed: unknown non-final state counts as WAIT | fuzz test (found it) |
| 2 | No-op events dropped their source-sequence bookkeeping | Older events could slip past the staleness guard | Persist state when a no-op changes it | R1 |
| 3 | A wrong-token deposit flagged the real deposit attempt | A correct payment afterwards was ignored forever | Wrong-asset transfers become their own stray attempt | R2 |
| 4 | A far-future provider timestamp froze an attempt | One bad provider clock blocks all later updates | Clamp claimed times to "now" | R3 |
| 5 | Huge order amount returned a 500 | Crash path on user input | Validation error + max order size | R4 |
| 6 | Overlapping delivery runs sent a webhook twice | Duplicate sends, double reconciliation calls | 30s lease on claimed rows | R6 |
| 7 | Webhook retry could fire with 0 ms delay | Hot retry loops | 1s floor | R7 |
| 8 | A nested transaction silently deadlocked | Hangs instead of errors | Detected and rejected loudly | R9 |
| 9 | Duplicate payment mid-reversal not flagged | Seller could miss a refund owed | Included in duplicate detection | R10 |
| 10 | Unsafe JSON number (`9007199254740993`) silently rounded and accepted | Money precision | Reject non-safe integers | server test |
| 11 | Bad clock tick (`"abc"`, `null`, negative) corrupted the demo clock | Every date in the app became invalid | Strict validation | server test |
| 12 | Public API returned internal fields (`tenantId`, `version`, sequence data) | Leaks internals, freezes storage shape into the contract | Explicit public DTO | server test |
| 13 | Server listened on all interfaces with unauthenticated `/sim` | Anyone on the network could drive the demo | Loopback by default | server test |
| 14 | Simulator accepted bank actions on chain attempts and vice versa | Silent nonsense | 400 on wrong rail | server test |
| 15 | Idempotency check and claim were separate steps; a 500 poisoned the key | Race window; clients could never retry | Atomic claim; key released on unexpected errors | server test (race not reproduced, hardened by inspection) |
| 16 | Background loop could overlap itself; outbound fetch had no timeout | One slow endpoint stalls everything | Re-entrancy guard, 5s timeout | live-chain / loop test |
| 17 | Demo seed collided when clicked twice in one second | Confusing error toast | Monotonic batch counter | server test |
| 18 | Dashboard re-rendered every second | Could swallow clicks and drop focus | Re-render only on real change | headless browser |
| 19 | Ignored/rejected actions showed nothing on screen | Demo looked broken | Plain-language message | headless browser |
| 20 | My own dashboard patch introduced a syntax error | Blank page | Caught by a parse check, fixed | headless browser |

## Known and NOT fixed (be upfront about these)

- **Abandoned bank attempt.** A bank attempt with no provider event counts as WAIT and blocks retry, then escalates after the retry budget. A real fix needs a provider signal for "no payment", or an attempt-expiry policy agreed with the provider.
- **ESCALATED cases** have no human-resolution endpoint yet.
- **Partial payments** are not summed across attempts or rails.
- **Prisma schema and SQL** are unvalidated: there is no Postgres in the build environment.
- **Chain watcher** is verified against an in-process fake node and over real HTTP JSON-RPC to that fake, **not** against anvil, Sepolia or a mainnet node. Real-node concerns (rate limits, pruned logs, L2 finality, reorgs deeper than the confirmation threshold) are untested. Its tracking state is in memory.
- **Deposit addresses** come from a pre-funded pool in live mode, not HD derivation from the seller's public key. The non-custodial claim rests on that derivation step, which needs a secp256k1/keccak library.
- **No rate limiting**, static demo API key, idempotency rows never expire, and every transaction clones the in-memory store (fine for a demo, not for volume).
- The demo clock shows time of day only, so jumping an hour can cross midnight on screen.
