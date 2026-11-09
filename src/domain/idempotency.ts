import { createHash } from 'node:crypto';

/** Stable JSON: object keys sorted, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

export interface StoredIdempotency {
  requestHash: string;
  responseStatus: number | null; // null = first request still in progress
  responseBody: unknown;
}

export type IdempotencyDecision =
  | { action: 'PROCESS' }
  | { action: 'REPLAY'; status: number; body: unknown }
  | { action: 'CONFLICT'; reason: 'KEY_REUSED_WITH_DIFFERENT_REQUEST' | 'REQUEST_IN_PROGRESS' };

/** Same key + same request = replay the stored response. Same key + different request = 409. */
export function decideIdempotency(stored: StoredIdempotency | null, fingerprint: string): IdempotencyDecision {
  if (stored === null) return { action: 'PROCESS' };
  if (stored.requestHash !== fingerprint) return { action: 'CONFLICT', reason: 'KEY_REUSED_WITH_DIFFERENT_REQUEST' };
  if (stored.responseStatus === null) return { action: 'CONFLICT', reason: 'REQUEST_IN_PROGRESS' };
  return { action: 'REPLAY', status: stored.responseStatus, body: stored.responseBody };
}
