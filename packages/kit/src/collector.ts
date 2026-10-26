import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent, MongoClient } from 'mongodb';
import { performance } from 'node:perf_hooks';
import { contextStorage, createContext, currentContext, type WorkContext } from './context.ts';
import { captureCallSite, type CallSite } from './callsite.ts';
import { CaptureWriter, emptyCaptureStats, resolveCapture, type CaptureSetting, type CaptureStats } from './capture.ts';
import { describeCommand, lookupKeys } from './fingerprint.ts';
import { detectNPlusOne, type NPlusOneOptions } from './rules/nPlusOne.ts';
import { gateMonitoring, type GateMode } from './gate.ts';
import { readReply, type ReplyFacts } from './reply.ts';
import { emptyStats, Optimizer, PREFETCH_COMMENT, resolveOptimize, type AutoBatchOptions, type OptimizeSetting, type OptimizeStats, type ResolvedOptimize } from './optimize.ts';
import type { CommandRecord, Finding } from './types.ts';
import { apolloPlugin, type ApolloPlugin, type ApolloPluginOptions } from './apollo.ts';

export interface ObserveOptions {
  /**
   * Request-scoped optimisations applied in the driver, opt-in: `'safe'` (batchLookups + dedupeReads) or an
   * `OptimizeOptions` object. Contract: a per-request DataLoader cache (see optimize.ts). Default off.
   */
  optimize?: OptimizeSetting;
  /** Alias for `optimize: { batchLookups: true }`. */
  autoBatch?: boolean | AutoBatchOptions;
  /**
   * Fraction of units of work (`run()` calls, middleware requests) that are observed. The rest run with no
   * context, and with context-gated monitoring they pay essentially nothing. Default 1.
   */
  sampleRate?: number;
  /**
   * Turn command monitoring on per command, only inside a context, instead of client-wide. Default true; set
   * false to force client-wide monitoring. Falls back automatically if the driver internals are not found.
   */
  gateMonitoring?: boolean;
  /**
   * Fraction of (context, fingerprint) pairs whose call site is captured. Only the first occurrence in a
   * context is ever captured, so a loop costs one stack capture, not one per iteration. Default 1.
   */
  callSiteSampleRate?: number;
  /** Parent documents held per command for correlation, until the context ends. Default 1000. */
  maxRetainedDocsPerCommand?: number;
  /** Parent documents held per context. Default 10000. */
  maxRetainedDocsPerContext?: number;
  nPlusOne?: Partial<NPlusOneOptions>;
  onFinding?: (finding: Finding) => void;
  /**
   * Write value-free NDJSON captures for `krepis analyze`: `true` (to `.krepis/`), a directory, or `CaptureOptions`.
   * Default off; the `KREPIS_CAPTURE` environment variable (`1` or a directory) turns it on without code changes.
   */
  capture?: CaptureSetting;
}

/**
 * One unit of work started by an integration (see `Observer.begin`). Code passed to `run` executes inside it, so
 * its commands are analysed together when `end` is called.
 */
export interface Unit {
  /** Shown in findings and captures. Settable until `end`. */
  label: string;
  run<A extends unknown[], T>(fn: (...args: A) => T, ...args: A): T;
  /**
   * Make this unit current for the rest of the calling async chain (`AsyncLocalStorage.enterWith`), for hooks that
   * cannot wrap the work in a callback. Code that continues in it after `end()` falls back to the unit that was current
   * when this one began.
   */
  enter(): void;
  end(): void;
}

interface RequestLike { method?: string; originalUrl?: string; url?: string; baseUrl?: string; route?: { path?: unknown } }
interface ResponseLike { once(event: 'finish' | 'close', listener: () => void): unknown }

const ID_SEGMENT = /^(?:[0-9a-f]{24}|[0-9a-f-]{36}|\d+)$/i;
/** Stacks captured per query shape per unit of work. */
const SITES_PER_FINGERPRINT = 3;

/** A catch-all route (`*`, Express 5 `/*splat`, `(.*)`): its pattern says nothing about the page, e.g. a CMS. */
const WILDCARD_ROUTE = /^\/?(?:\*\w*|\(\.\*\))$/;

/** Route pattern if the framework exposes a useful one; otherwise the path with id-like segments masked. */
function routeLabel(req: RequestLike): string {
  const method = req.method ?? 'REQUEST';
  const pattern = req.route?.path;
  if (typeof pattern === 'string' && !WILDCARD_ROUTE.test(pattern)) {
    // Express sets baseUrl to the mount path; some frameworks (Apostrophe) overwrite it with the absolute site URL.
    const base = typeof req.baseUrl === 'string' && req.baseUrl.startsWith('/') ? req.baseUrl : '';
    return `${method} ${base}${pattern}`;
  }
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  return `${method} ${path.split('/').map((s) => (ID_SEGMENT.test(s) ? ':id' : s)).join('/')}`;
}

export class Observer {
  readonly findings: Finding[] = [];
  readonly client: MongoClient;
  /** Errors raised inside Krepis's own handlers. They are counted, never thrown into the application. */
  internalErrors = 0;
  /** Stack traces captured so far (the costliest per-command step; see bench/overhead.ts). */
  callSitesCaptured = 0;
  private readonly options: Required<Omit<ObserveOptions, 'onFinding' | 'nPlusOne' | 'autoBatch' | 'optimize' | 'capture'>> & Pick<ObserveOptions, 'onFinding' | 'nPlusOne'>;
  private readonly optimize: ResolvedOptimize | undefined;
  /** Totals across all contexts for the optimisations in `optimize`. */
  readonly optimizeStats: OptimizeStats = emptyStats();
  private readonly pending = new Map<number, { ctx: WorkContext; record: CommandRecord }>();
  private readonly cursors = new Map<string, CommandRecord>();
  private readonly listeners: Array<[string, (...args: never[]) => void]> = [];
  private readonly enabled: boolean;
  private readonly capture: CaptureWriter | undefined;
  /**
   * @internal Set on promise-style drivers: the gate hands this observer's in-context commands to it, and it records
   * them from the command and the reply instead of from monitoring events.
   */
  readonly record: ((args: unknown[], run: () => Promise<unknown>) => Promise<unknown>) | undefined;

  constructor(client: MongoClient, options: ObserveOptions = {}, enabled = true, gated: GateMode | false = false) {
    this.client = client;
    this.enabled = enabled;
    this.options = {
      sampleRate: options.sampleRate ?? 1,
      gateMonitoring: options.gateMonitoring ?? true,
      callSiteSampleRate: options.callSiteSampleRate ?? 1,
      maxRetainedDocsPerCommand: options.maxRetainedDocsPerCommand ?? 1000,
      maxRetainedDocsPerContext: options.maxRetainedDocsPerContext ?? 10_000,
      onFinding: options.onFinding,
      nPlusOne: options.nPlusOne,
    };
    // Optimisations live in the gated driver hook; without it there is nowhere to answer a command from.
    const requested = resolveOptimize(options.optimize, options.autoBatch);
    this.optimize = gated ? requested : undefined;
    if (enabled && requested && !gated) {
      process.emitWarning('krepis: optimize/autoBatch needs context-gated monitoring, which is unavailable here; optimisations are off.', { code: 'KREPIS_NO_OPTIMIZE' });
    }
    if (!enabled) return;
    const capture = resolveCapture(options.capture);
    this.capture = capture ? new CaptureWriter(capture) : undefined;
    if (gated === 'promise') {
      this.record = (args, run) => this.recordCommand(args, run);
      return;
    }
    this.on('commandStarted', (e: CommandStartedEvent) => this.started(e));
    this.on('commandSucceeded', (e: CommandSucceededEvent) => this.succeeded(e));
    this.on('commandFailed', (e: CommandFailedEvent) => this.failed(e));
  }

  private on(event: string, listener: (e: never) => void): void {
    // Listeners run inside the driver's emit, i.e. inside the application's query: never let one throw.
    const safe = (e: never) => {
      try {
        listener(e);
      } catch {
        this.internalErrors++;
      }
    };
    this.client.on(event as 'commandStarted', safe as never);
    this.listeners.push([event, safe]);
  }

  /** Run `fn` as one unit of work; its commands are analysed together when it settles. */
  async run<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.sampled()) return fn();
    const ctx = this.newContext(label);
    try {
      return await contextStorage.run(ctx, fn);
    } finally {
      this.end(ctx);
    }
  }

  /**
   * Start a unit of work for an integration that cannot wrap the work in one callback (a GraphQL server, a job
   * runner). Returns undefined when the unit is not sampled. `end()` must be called; findings are produced then.
   */
  begin(label: string): Unit | undefined {
    if (!this.sampled()) return undefined;
    const ctx = this.newContext(label);
    return {
      get label() {
        return ctx.label;
      },
      set label(value: string) {
        ctx.label = value;
      },
      run: (fn, ...args) => (contextStorage.getStore() === ctx ? fn(...args) : contextStorage.run(ctx, fn, ...args)),
      enter: () => contextStorage.enterWith(ctx),
      end: () => this.end(ctx),
    };
  }

  /** Apollo Server plugin: one unit of work per GraphQL operation, labelled `query Name`. See apollo.ts. */
  apolloPlugin(options?: ApolloPluginOptions): ApolloPlugin {
    return apolloPlugin(this, options);
  }

  /** Connect/Express-style middleware: one context per request, analysed when the response ends. */
  middleware(): (req: RequestLike, res: ResponseLike, next: () => void) => void {
    return (req, res, next) => {
      if (!this.sampled()) return next();
      const ctx = this.newContext(routeLabel(req));
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        ctx.label = routeLabel(req);
        this.end(ctx);
      };
      res.once('finish', finish);
      res.once('close', finish);
      contextStorage.run(ctx, next);
    };
  }

  /** Capture counters (all zero when capture is off). */
  get captureStats(): CaptureStats {
    return this.capture?.stats ?? emptyCaptureStats();
  }

  /** Directory captures are written to, if capture is on. */
  get captureDir(): string | undefined {
    return this.capture?.dir;
  }

  /** Write buffered capture lines now (they are otherwise written within a second, and on detach and exit). */
  flush(): void {
    this.capture?.flush();
  }

  detach(): void {
    this.capture?.close();
    for (const [event, listener] of this.listeners) this.client.off(event as 'commandStarted', listener as never);
    this.listeners.length = 0;
  }

  private newContext(label: string): WorkContext {
    const ctx = createContext(label, this);
    if (this.optimize) {
      ctx.optimizer = new Optimizer(
        { commands: () => ctx.commands, recordServed: (name, db, cmd, returned) => this.recordServed(ctx, name, db, cmd, returned) },
        this.optimize,
        this.optimizeStats,
      );
    }
    return ctx;
  }

  /** A command an optimisation answered without a round trip: recorded so the rules still count it. */
  private recordServed(ctx: WorkContext, commandName: string, database: string, command: Record<string, unknown>, returned: number): void {
    if (ctx.ended) return;
    const described = describeCommand(commandName, database, command);
    if (!described) return;
    const now = performance.now();
    const lookup = lookupKeys(described.filter);
    ctx.commands.push({
      requestId: -1,
      commandName,
      database,
      collection: described.collection,
      shape: described.shape,
      fingerprint: described.fingerprint,
      point: lookup?.keys,
      pointResidual: lookup?.residual,
      callSite: this.maybeCaptureCallSite(ctx, described.fingerprint),
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      returned,
      failed: false,
      docs: undefined,
      cursorId: undefined,
      served: true,
    });
  }

  /**
   * Records one in-context command from `Connection.command(ns, cmd, options, responseType)` and what it resolves
   * with. Every Krepis step is guarded: the command's result or rejection always reaches the driver untouched.
   */
  private recordCommand(args: unknown[], run: () => Promise<unknown>): Promise<unknown> {
    let entry: { ctx: WorkContext; record: CommandRecord } | undefined;
    try {
      const ctx = currentContext();
      const [ns, cmd] = args as [{ db?: unknown } | undefined, Record<string, unknown> | undefined];
      const name = cmd ? Object.keys(cmd)[0] : undefined;
      if (ctx && ctx.owner === this && name) entry = this.open(ctx, -1, name, String(ns?.db), cmd!);
    } catch {
      this.internalErrors++;
    }
    if (!entry) return run();
    const { ctx, record } = entry;
    const close = (res: unknown, failed: boolean) => {
      try {
        this.settle(ctx, record, performance.now() - record.startedAt, failed ? undefined : readReply(res));
      } catch {
        this.internalErrors++;
      }
    };
    return run().then(
      (res) => {
        close(res, false);
        return res;
      },
      (err: unknown) => {
        close(undefined, true);
        throw err;
      },
    );
  }

  private started(e: CommandStartedEvent): void {
    const ctx = currentContext();
    if (!ctx || ctx.owner !== this) return;
    const entry = this.open(ctx, e.requestId, e.commandName, e.databaseName, e.command as Record<string, unknown>);
    if (entry) this.pending.set(e.requestId, entry);
  }

  private open(ctx: WorkContext, requestId: number, commandName: string, database: string, command: Record<string, unknown>): { ctx: WorkContext; record: CommandRecord } | undefined {
    const described = describeCommand(commandName, database, command);
    if (!described) return undefined;
    const lookup = commandName === 'getMore' ? undefined : lookupKeys(described.filter);
    const record: CommandRecord = {
      requestId,
      commandName,
      database,
      collection: described.collection,
      shape: described.shape,
      fingerprint: described.fingerprint,
      point: lookup?.keys,
      pointResidual: lookup?.residual,
      callSite: this.maybeCaptureCallSite(ctx, described.fingerprint),
      startedAt: performance.now(),
      endedAt: undefined,
      durationMs: undefined,
      returned: undefined,
      failed: false,
      docs: undefined,
      cursorId: described.cursorId,
      prefetch: command.comment === PREFETCH_COMMENT,
    };
    return { ctx, record };
  }

  private succeeded(e: CommandSucceededEvent): void {
    const entry = this.pending.get(e.requestId);
    if (!entry) return;
    this.pending.delete(e.requestId);
    this.settle(entry.ctx, entry.record, e.duration, readReply(e.reply ?? {}));
  }

  private failed(e: CommandFailedEvent): void {
    const entry = this.pending.get(e.requestId);
    if (!entry) return;
    this.pending.delete(e.requestId);
    this.settle(entry.ctx, entry.record, e.duration, undefined);
  }

  /** Completes a record from its reply; `reply` is undefined when the command failed. */
  private settle(ctx: WorkContext, record: CommandRecord, durationMs: number, reply: ReplyFacts | undefined): void {
    record.endedAt = performance.now();
    record.durationMs = durationMs;
    if (!reply) {
      record.failed = true;
      if (!ctx.ended && record.commandName !== 'getMore') ctx.commands.push(record);
      return;
    }
    const { batch, openCursor } = reply;

    if (record.commandName === 'getMore' && record.cursorId) {
      // Fold the batch into the command that opened the cursor; a getMore is not a separate query.
      const origin = this.cursors.get(record.cursorId);
      if (origin && batch !== undefined) {
        origin.returned = (origin.returned ?? 0) + batch;
        this.retain(ctx, origin, batch, reply.docs);
        origin.endedAt = record.endedAt;
      }
      if (!openCursor) this.cursors.delete(record.cursorId);
      return;
    }

    if (batch !== undefined) {
      record.returned = batch;
      this.retain(ctx, record, batch, reply.docs);
      if (openCursor) this.cursors.set(openCursor, record);
    } else if (reply.n !== undefined) {
      record.returned = reply.n;
    }
    if (!ctx.ended) ctx.commands.push(record);
  }

  private sampled(): boolean {
    return this.enabled && (this.options.sampleRate >= 1 || Math.random() < this.options.sampleRate);
  }

  /**
   * Up to SITES_PER_FINGERPRINT stacks per shape per unit of work, so repeats from several code paths
   * show as several sites instead of only the first. The sampling decision is made once per shape.
   */
  private maybeCaptureCallSite(ctx: WorkContext, fingerprint: string): CallSite | undefined {
    const taken = ctx.sitesCaptured.get(fingerprint);
    if (taken === undefined) {
      if (Math.random() >= this.options.callSiteSampleRate) {
        ctx.sitesCaptured.set(fingerprint, SITES_PER_FINGERPRINT);
        return undefined;
      }
    } else if (taken >= SITES_PER_FINGERPRINT) {
      return undefined;
    }
    ctx.sitesCaptured.set(fingerprint, (taken ?? 0) + 1);
    this.callSitesCaptured++;
    return captureCallSite();
  }

  /** Holds up to `count` documents of a batch, decoded only if a rule or `optimize` reads them (see `docsOf`). */
  private retain(ctx: WorkContext, record: CommandRecord, count: number, read: (n: number) => unknown[]): void {
    const held = (record.docs?.length ?? 0) + (record.lazyDocs?.reduce((s, l) => s + l.count, 0) ?? 0);
    const take = Math.min(
      count,
      this.options.maxRetainedDocsPerCommand - held,
      this.options.maxRetainedDocsPerContext - ctx.retainedDocs,
    );
    if (take <= 0) return;
    (record.lazyDocs ??= []).push({ count: take, read: () => read(take) });
    ctx.retainedDocs += take;
  }

  private end(ctx: WorkContext): void {
    if (ctx.ended) return;
    ctx.ended = true;
    let findings: Finding[] = [];
    try {
      findings = detectNPlusOne(ctx, this.options.nPlusOne);
      for (const f of findings) {
        this.findings.push(f);
        this.options.onFinding?.(f);
      }
    } catch {
      this.internalErrors++;
    }
    try {
      this.capture?.record(ctx, findings);
    } catch {
      this.internalErrors++;
    }
    for (const c of ctx.commands) {
      c.docs = undefined;
      c.lazyDocs = undefined;
      c.point = undefined;
    }
    ctx.commands.length = 0;
    ctx.sitesCaptured.clear();
    ctx.optimizer = undefined;
  }
}

export function observe(client: MongoClient, options?: ObserveOptions): Observer {
  if (process.env.KREPIS_DISABLED === '1') return new Observer(client, options, false);
  const gated = options?.gateMonitoring !== false && gateMonitoring(client);
  if (gated) return new Observer(client, options, true, gated);
  // Fallback: client-wide monitoring. Every command pays the driver's event cost, and connections that are
  // already open keep the flag they were created with.
  // The getter/setter exists at runtime (mongo_client.js) but is not in the public typings.
  const flag = client as unknown as { monitorCommands: boolean };
  const connected = Boolean((client as unknown as { topology?: unknown }).topology);
  if (connected && !flag.monitorCommands) {
    process.emitWarning(
      'krepis: observe() was called after connect() without monitorCommands. Connections already open '
        + 'emit no command events. Call observe() before connect(), or pass { monitorCommands: true } to MongoClient.',
      { code: 'KREPIS_LATE_OBSERVE' },
    );
  }
  flag.monitorCommands = true;
  return new Observer(client, options);
}
