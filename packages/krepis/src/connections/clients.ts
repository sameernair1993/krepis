import { AsyncLocalStorage } from 'node:async_hooks';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionFinding } from './types.ts';

/** The driver's `MongoClient` class: `import { MongoClient } from 'mongodb'`, or `mongoose.mongo.MongoClient`. */
export interface MongoClientClass {
  prototype: { connect(...args: unknown[]): unknown; close(...args: unknown[]): unknown };
}

export interface ClientWatchOptions {
  /** Clients open at once for the same target and credentials that raise KR-C001. Default 2. */
  threshold?: number;
  /** KR-C001 is raised at most once per target in this window. Default 60 s. */
  windowMs?: number;
  onFinding?: (finding: ConnectionFinding) => void;
  now?: () => number;
}

interface ClientLike {
  options?: {
    hosts?: Array<{ toString(): string }>;
    srvHost?: string;
    replicaSet?: string;
    credentials?: { username?: string; source?: string; mechanism?: string };
    maxPoolSize?: number;
  };
}

interface OpenClient { key: string; target: string; site: string; maxPoolSize: number | undefined }

interface Patch {
  connect: (...args: unknown[]) => unknown;
  close: (...args: unknown[]) => unknown;
  open: Map<object, OpenClient>;
  watchers: Set<ClientWatcher>;
}

const patches = new WeakMap<object, Patch>();

const managed = new AsyncLocalStorage<true>();

/**
 * @internal Run `open` so that the clients it connects are not counted by KR-C001. TenantPools opens one client per
 * tenant by design, caps how many are open and closes idle ones, which is what KR-C001 exists to ask for.
 */
export function openManaged<T>(open: () => T): T {
  return managed.run(true, open);
}

/** Where `connect` was called from: the nearest frame above `wrapper` outside node internals and dependencies. */
function connectSite(wrapper: (...args: never[]) => unknown): string {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  Error.captureStackTrace(holder, wrapper);
  Error.stackTraceLimit = limit;
  for (const line of (holder.stack ?? '').split('\n').slice(1)) {
    const m = /\((.*):(\d+):\d+\)\s*$/.exec(line) ?? /at (?:async )?(.*):(\d+):\d+\s*$/.exec(line);
    if (!m) continue;
    let file = m[1]!;
    if (file.startsWith('file://')) file = fileURLToPath(file);
    if (file.startsWith('node:') || file.includes(`${sep}node_modules${sep}`) || !file.includes(sep)) continue;
    const cwd = process.cwd();
    return `${file.startsWith(cwd + sep) ? relative(cwd, file) : file}:${m[2]}`;
  }
  return 'unknown';
}

/** Target and credentials, without the user name or password: two clients that share them can share one pool. */
function identify(client: ClientLike): { key: string; target: string } | undefined {
  const o = client.options;
  if (!o) return undefined;
  const target = o.srvHost ? `mongodb+srv://${o.srvHost}` : (o.hosts ?? []).map(String).sort().join(',');
  if (!target) return undefined;
  const c = o.credentials;
  const key = [target, o.replicaSet ?? '', c?.username ?? '', c?.source ?? '', c?.mechanism ?? ''].join('\u0000');
  return { key, target: o.replicaSet ? `${target} (replica set ${o.replicaSet})` : target };
}

function install(proto: MongoClientClass['prototype']): Patch {
  let patch = patches.get(proto);
  if (patch) return patch;
  const p: Patch = { connect: proto.connect, close: proto.close, open: new Map(), watchers: new Set() };
  patch = p;
  proto.connect = function watchedConnect(this: object, ...args: unknown[]) {
    if (!p.open.has(this) && !managed.getStore()) {
      try {
        const id = identify(this as ClientLike);
        if (id) {
          p.open.set(this, { ...id, site: connectSite(watchedConnect), maxPoolSize: (this as ClientLike).options?.maxPoolSize });
          for (const w of p.watchers) w.opened(id.key, p.open);
        }
      } catch {
        // Never fail the application's connect.
      }
    }
    const result = p.connect.apply(this, args);
    // A connect that fails leaves no open client behind.
    if (result instanceof Promise) result.then(undefined, () => p.open.delete(this));
    return result;
  };
  proto.close = function watchedClose(this: object, ...args: unknown[]) {
    p.open.delete(this);
    return p.close.apply(this, args);
  };
  patches.set(proto, p);
  return p;
}

/**
 * KR-C001: several clients open at once for the same target and credentials. Each client has its own pool, up to
 * `maxPoolSize` connections per node, and its own monitoring connections, so N clients hold up to N times the
 * connections one would. The usual causes are a client created per request or per module reload, and libraries that
 * each create their own.
 */
export class ClientWatcher {
  readonly findings: ConnectionFinding[] = [];
  private readonly proto: MongoClientClass['prototype'];
  private readonly patch: Patch;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly onFinding: ClientWatchOptions['onFinding'];
  private readonly now: () => number;
  private readonly fired = new Map<string, number>();
  private readonly created = new Map<string, number>();

  constructor(MongoClient: MongoClientClass, options: ClientWatchOptions = {}) {
    this.proto = MongoClient.prototype;
    this.threshold = Math.max(2, options.threshold ?? 2);
    this.windowMs = options.windowMs ?? 60_000;
    this.onFinding = options.onFinding;
    this.now = options.now ?? Date.now;
    this.patch = install(this.proto);
    this.patch.watchers.add(this);
  }

  /** Clients connected through this driver copy and not yet closed, per target (without credentials). */
  openClients(): Array<{ target: string; sites: string[] }> {
    const byKey = new Map<string, { target: string; sites: string[] }>();
    for (const c of this.patch.open.values()) {
      const entry = byKey.get(c.key) ?? { target: c.target, sites: [] };
      entry.sites.push(c.site);
      byKey.set(c.key, entry);
    }
    return [...byKey.values()];
  }

  /** Stops watching; the driver's methods are restored when no watcher is left. */
  stop(): void {
    this.patch.watchers.delete(this);
    if (this.patch.watchers.size > 0) return;
    this.proto.connect = this.patch.connect;
    this.proto.close = this.patch.close;
    patches.delete(this.proto);
  }

  /** @internal */
  opened(key: string, open: Map<object, OpenClient>): void {
    this.created.set(key, (this.created.get(key) ?? 0) + 1);
    const same = [...open.values()].filter((c) => c.key === key);
    if (same.length < this.threshold) return;
    const now = this.now();
    const last = this.fired.get(key);
    if (last !== undefined && now - last < this.windowMs) return;
    this.fired.set(key, now);

    const sites = new Map<string, number>();
    for (const c of same) sites.set(c.site, (sites.get(c.site) ?? 0) + 1);
    const siteList = [...sites].sort((a, b) => b[1] - a[1]).map(([s, n]) => (n > 1 ? `${s} (×${n})` : s));
    const pools = same.map((c) => c.maxPoolSize).filter((n): n is number => typeof n === 'number');
    const poolTotal = pools.length === same.length ? pools.reduce((a, b) => a + b, 0) : null;
    const target = same[0]!.target;
    const finding: ConnectionFinding = {
      rule: 'KR-C001', severity: 'warn', title: 'Duplicate clients',
      message: `${same.length} clients are open to ${target} with the same credentials, connected from ${siteList.slice(0, 5).join(', ')}${siteList.length > 5 ? `, and ${siteList.length - 5} more` : ''}. `
        + `Each has its own pool and monitoring connections${poolTotal !== null ? `: up to ${poolTotal} connections per node between them` : ''}.`,
      fix: 'Create one client per process at startup and share it; close clients you create for short-lived work.',
      clients: siteList,
      evidence: { openClients: same.length, createdSinceWatching: this.created.get(key) ?? 0, target, maxPoolSizeTotal: poolTotal },
    };
    this.findings.push(finding);
    this.onFinding?.(finding);
  }
}

/**
 * Watch every client of one driver copy for KR-C001 (duplicate clients). Call it at startup, before clients connect;
 * clients connected earlier are not seen. It wraps `MongoClient.prototype.connect` and `close` of the copy passed in;
 * Mongoose bundles its own copy, which is `mongoose.mongo.MongoClient`.
 */
export function watchClients(MongoClient: MongoClientClass, options?: ClientWatchOptions): ClientWatcher {
  return new ClientWatcher(MongoClient, options);
}
