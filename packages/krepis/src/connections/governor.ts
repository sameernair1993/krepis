/**
 * Pure pieces of the breaker's per-cluster governor.
 */

/**
 * The cluster a connection string points at: scheme and sorted host list, without credentials, database or options.
 * Tenants with the same key share a server, so an authentication storm on one key says nothing about another.
 */
export function clusterKey(uri: string): string {
  const sep = uri.indexOf('://');
  if (sep < 0) return uri.split('?')[0]!.replace(/^.*@/, '');
  const scheme = uri.slice(0, sep).toLowerCase();
  let rest = uri.slice(sep + 3);
  const q = rest.indexOf('?');
  if (q >= 0) rest = rest.slice(0, q);
  const at = rest.lastIndexOf('@');
  if (at >= 0) rest = rest.slice(at + 1);
  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(0, slash);
  const hosts = rest.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).sort();
  return `${scheme}://${hosts.join(',')}`;
}

/** A token bucket. `take` returns 0 when a token was taken, otherwise the milliseconds until one is available. */
export class TokenBucket {
  private readonly rate: number;
  private readonly burst: number;
  private tokens: number;
  private at: number;
  constructor(perSecond: number, now: number, burst = perSecond) {
    this.rate = perSecond;
    this.burst = Math.max(1, burst);
    this.tokens = this.burst;
    this.at = now;
  }
  take(now: number): number {
    if (this.rate === Infinity) return 0;
    if (now > this.at) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
      this.at = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
  }
}

/** Equal jitter: half of the ceiling fixed, half random, so a fleet does not act in lockstep. */
export function equalJitter(ceilingMs: number, random: () => number): number {
  return Math.round(ceilingMs / 2 + random() * (ceilingMs / 2));
}
