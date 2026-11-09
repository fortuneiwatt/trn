import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header format: `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac for a rotated secret>]` */
export function signWebhook(secrets: string[], body: string, timestampSec: number): string {
  if (secrets.length === 0) throw new Error('at least one secret is required');
  const sigs = secrets.map((s) => `v1=${hmac(s, timestampSec, body)}`);
  return `t=${timestampSec},${sigs.join(',')}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'MALFORMED' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'BAD_SIGNATURE' };

/**
 * Verify BEFORE parsing the body. `secrets` may hold old + new during rotation.
 * The timestamp is inside the signed string, so replays outside the tolerance fail.
 * Receivers must also dedupe on eventId.
 */
export function verifyWebhook(
  secrets: string[],
  header: string,
  body: string,
  nowSec: number,
  toleranceSec = 300,
): VerifyResult {
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const ts = t !== undefined && /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isFinite(ts) || sigs.length === 0) return { ok: false, reason: 'MALFORMED' };
  if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };

  for (const secret of secrets) {
    const expected = Buffer.from(hmac(secret, ts, body), 'hex');
    for (const sig of sigs) {
      const got = Buffer.from(sig, 'hex');
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: 'BAD_SIGNATURE' };
}

function hmac(secret: string, timestampSec: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
}
