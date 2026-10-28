import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent, MongoClient } from 'mongodb';
import type { ConnectionHolders } from '@sameernair/krepis/connections';
import { performance } from 'node:perf_hooks';
import { contextStorage, createContext, currentContext, type WorkContext } from './context.ts';
import { captureCallSite, type CallSite } from './callsite.ts';
import { CaptureWriter, emptyCaptureStats, resolveCapture, type CaptureSetting, type CaptureStats } from './capture.ts';
import { describeCommand, lookupKeys } from './fingerprint.ts';
import { detectNPlusOne, type NPlusOneOptions } from './rules/nPlusOne.ts';
import { gateMonitoring, type GateMode } from './gate.ts';
import { readReply, type ReplyFacts } from './reply.ts';
import { emptyStats, Optimizer, PREFETCH_COMMENT, resolveOptimize, type AutoBatchOptions, type OptimizeSetting, type OptimizeStats, type ResolvedOptimize } from './optimize.ts';
import type { CommandRecord, Finding, HazardFinding, PlanFinding } from './types.ts';
import { apolloPlugin, type ApolloPlugin, type ApolloPluginOptions } from './apollo.ts';
import { Measurement, type QueryCount } from './budget.ts';
import { PlanInspector, type ExplainStats } from './plan.ts';
import { HazardInspector, type HazardOptions } from './rules/hazards.ts';
import { fastifyPlugin, honoMiddleware, koaMiddleware, maskedPath, WILDCARD_ROUTE, type FastifyPlugin } from './frameworks.ts';

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
  /** Called with each plan finding (`explain: true`) when its explain returns. */
  onPlanFinding?: (finding: PlanFinding) => void;
  /**
   * Write value-free NDJSON captures for `krepis analyze`: `true` (to `.krepis/`), a directory, or `CaptureOptions`.
   * Default off; the `KREPIS_CAPTURE` environment variable (`1` or a directory) turns it on without code changes.
   */
  capture?: CaptureSetting;
  /**
   * Explain each query shape the first time it is seen, and report collection scans (KR-P001), in-memory sorts
   * (KR-P010) and `$lookup` without an index (KR-P003), with the index that would fix each. For tests and CI: it sends
   * one extra command per shape to the server. Default off; `KREPIS_EXPLAIN=1` turns it on without code changes.
   */
  explain?: boolean;
  /**
   * Hazard rules: operator injection (KR-S001), server-side JavaScript (KR-S002), unanchored regular expressions
   * (KR-S003), sensitive fields returned (KR-S004) and unbounded reads (KR-P006). Each inspects a query shape once, or a
   * few times, and records field and operator names only. By default only KR-S001 and KR-S002 run; `true` (or options,
   * or `KREPIS_HAZARDS=1`) adds the other three; `false` (or `KREPIS_HAZARDS=0`) turns all of them off.
   */
  hazards?: boolean | HazardOptions;
  /** Called with each hazard finding. */
  onHazard?: (finding: HazardFinding) => void;
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
  /**
   * Request input of this unit (a parsed body, query string, GraphQL variables), for KR-S001: an operator object in a
   * filter that the client sent is reported from that one request. `read` is called only when a filter holds an
   * operator object, so it can return a body parsed after the unit began. Compared in memory, never kept or captured.
   * The framework hooks call it themselves.
   */
  input(source: string, read: () => unknown): void;
  end(): void;
}

interface RequestLike { method?: string; originalUrl?: string; url?: string; baseUrl?: string; route?: { path?: unknown }; body?: unknown; query?: unknown; params?: unknown }
interface ResponseLike { once(event: 'finish' | 'close', listener: () => void): unknown }

/** Stacks captured per query shape per unit of work. */
const SITES_PER_FINGERPRINT = 3;

/** Route pattern if the framework exposes a useful one; otherwise the path with id-like segments masked. */
function routeLabel(req: RequestLike): string {
  const method = req.method ?? 'REQUEST';
  const pattern = req.route?.path;
  if (typeof pattern === 'string' && !WILDCARD_ROUTE.test(pattern)) {
    // Express sets baseUrl to the mount path; some frameworks (Apostrophe) overwrite it with the absolute site URL.
    const base = typeof req.baseUrl === 'string' && req.baseUrl.startsWith('/') ? req.baseUrl : '';
    return `${method} ${base}${pattern}`;
  }
  return `${method} ${maskedPath(req.originalUrl ?? req.url ?? '')}`;
}

export class Observer {
  readonly findings: Finding[] = [];
  /** Plan findings (`explain: true`): collection scans, in-memory sorts, `$lookup` without an index. */
  readonly planFindings: PlanFinding[] = [];
  /** Hazard findings: KR-S001 to KR-S004 and KR-P006 (see `ObserveOptions.hazards`). */
  readonly hazardFindings: HazardFinding[] = [];
  readonly client: MongoClient;
  /** Errors raised inside Krepis's own handlers. They are counted, never thrown into the application. */
  internalErrors = 0;
  /** Stack traces captured so far (the costliest per-command step; see bench/overhead.ts). */
  callSitesCaptured = 0;
  private readonly options: Required<Omit<ObserveOptions, 'onFinding' | 'onPlanFinding' | 'onHazard' | 'nPlusOne' | 'autoBatch' | 'optimize' | 'capture' | 'explain' | 'hazards'>> & Pick<ObserveOptions, 'onFinding' | 'onPlanFinding' | 'onHazard' | 'nPlusOne'>;
  private readonly optimize: ResolvedOptimize | undefined;
  /** Totals across all contexts for the optimisations in `optimize`. */
  readonly optimizeStats: OptimizeStats = emptyStats();
  private readonly pending = new Map<number, { ctx: WorkContext; record: CommandRecord }>();
  private readonly cursors = new Map<string, CommandRecord>();
  private readonly listeners: Array<[string, (...args: never[]) => void]> = [];
  private readonly enabled: boolean;
  private readonly capture: CaptureWriter | undefined;
  private readonly measurements = new Set<Measurement>();
  private readonly plans: PlanInspector | undefined;
  private readonly hazards: HazardInspector | undefined;
  /**
   * @internal Set on promise-style drivers: the gate hands this observer's in-context commands to it, and it records
   * them from the command and the reply instead of from monitoring events.
   */
  readonly record: ((args: unknown[], run: () => Promise<unknown>, conn: unknown) => Promise<unknown>) | undefined;
  // KR-C006 names (see holders()): the last in-context command per pool address and connection id.
  private holding: Map<string, string> | undefined;

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
      onPlanFinding: options.onPlanFinding,
      onHazard: options.onHazard,
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
    const explain = options.explain ?? ['1', 'true'].includes(process.env.KREPIS_EXPLAIN ?? '');
    if (explain) this.plans = new PlanInspector(client as never, (f) => this.report(f));
    const env = process.env.KREPIS_HAZARDS ?? '';
    const hazards = options.hazards ?? (['1', 'true'].includes(env) ? true : ['0', 'false'].includes(env) ? false : undefined);
    if (hazards !== false) this.hazards = new HazardInspector(typeof hazards === 'object' ? hazards : {}, (f) => this.report(f), hazards !== undefined);
    if (gated === 'promise') {
      this.record = (args, run, conn) => this.recordCommand(args, run, conn);
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
   * Run `fn` as one unit of work and count the commands it issues, with every unit of work that begins while it runs
   * (a request served in this process). Ignores `sampleRate`. For tests: see `expectQueries`.
   */
  async measure<T>(label: string, fn: () => Promise<T> | T): Promise<{ result: T; queries: QueryCount }> {
    if (!this.enabled) throw new Error('krepis: this observer is disabled (KREPIS_DISABLED=1), so it cannot count queries');
    const measurement = new Measurement();
    this.measurements.add(measurement);
    const ctx = this.newContext(label);
    try {
      const result = await contextStorage.run(ctx, fn);
      this.end(ctx);
      return { result, queries: measurement.result() };
    } finally {
      this.end(ctx);
      this.measurements.delete(measurement);
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
      input: (source, read) => this.addInput(ctx, source, read),
      end: () => this.end(ctx),
    };
  }

  /** True when request input is used (the hazard rules are on); hooks that must wrap something to read it check this. */
  get readsInput(): boolean {
    return this.hazards !== undefined;
  }

  /**
   * Request input for the current unit of work, for integrations built on `run` (see `Unit.input`). Ignored outside a
   * unit of this observer.
   */
  input(source: string, value: unknown): void {
    const ctx = currentContext();
    if (ctx?.owner === this) this.addInput(ctx, source, () => value);
  }

  private addInput(ctx: WorkContext, source: string, read: () => unknown): void {
    if (this.hazards && !ctx.ended) (ctx.inputs ??= []).push({ source, read });
  }

  /** Apollo Server plugin: one unit of work per GraphQL operation, labelled `query Name`. See apollo.ts. */
  apolloPlugin(options?: ApolloPluginOptions): ApolloPlugin {
    return apolloPlugin(this, options);
  }

  /** Connect/Express-style middleware (NestJS on Express too): one context per request, analysed when the response ends. */
  middleware(): (req: RequestLike, res: ResponseLike, next: () => void) => void {
    return (req, res, next) => {
      if (!this.sampled()) return next();
      const ctx = this.newContext(routeLabel(req));
      // Read when needed: body parsers and the router run after this middleware.
      this.addInput(ctx, 'body', () => req.body);
      this.addInput(ctx, 'query', () => req.query);
      this.addInput(ctx, 'params', () => req.params);
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

  /** Fastify plugin, one unit of work per request: `await app.register(observer.fastifyPlugin())`. See frameworks.ts. */
  fastifyPlugin(): FastifyPlugin {
    return fastifyPlugin(this);
  }

  /** Koa middleware, one unit of work per request: `app.use(observer.koaMiddleware())`, before the router. */
  koaMiddleware(): ReturnType<typeof koaMiddleware> {
    return koaMiddleware(this);
  }

  /** Hono middleware, one unit of work per request: `app.use(observer.honoMiddleware())`. */
  honoMiddleware(): ReturnType<typeof honoMiddleware> {
    return honoMiddleware(this);
  }

  /** Capture counters (all zero when capture is off). */
  get captureStats(): CaptureStats {
    return this.capture?.stats ?? emptyCaptureStats();
  }

  /** Directory captures are written to, if capture is on. */
  get captureDir(): string | undefined {
    return this.capture?.dir;
  }

  /** Explain counters (all zero when `explain` is off). */
  get explainStats(): ExplainStats {
    return this.plans?.stats ?? { explained: 0, failed: 0 };
  }

  /**
   * Wait for the explains started so far (`explain: true`), then write buffered capture lines. Call it before a test
   * run exits, or the last shapes' plan findings are lost.
   */
  async settled(): Promise<void> {
    await this.plans?.settled();
    this.capture?.flush();
  }

  /** A plan or hazard finding. */
  private report(finding: PlanFinding | HazardFinding): void {
    try {
      if (isPlanFinding(finding)) {
        this.planFindings.push(finding);
        this.options.onPlanFinding?.(finding);
      } else {
        this.hazardFindings.push(finding);
        this.options.onHazard?.(finding);
      }
    } catch {
      this.internalErrors++;
    }
    try {
      this.capture?.recordFinding(finding);
    } catch {
      this.internalErrors++;
    }
  }

  /** Write buffered capture lines now (they are otherwise written within a second, and on detach and exit). */
  flush(): void {
    this.capture?.flush();
  }

  /**
   * Names the queries holding connections, for KR-C006:
   * `watchConnections(client, { holders: observer.holders() })`. Only commands inside a unit of
   * work are named. Give it to one watcher: each name is handed out once.
   */
  holders(): ConnectionHolders {
    const map = (this.holding ??= new Map());
    return {
      heldBy: (address, id) => {
        const key = `${address}#${id}`;
        const name = map.get(key);
        if (name !== undefined) map.delete(key);
        return name;
      },
    };
  }

  detach(): void {
    this.capture?.close();
    for (const [event, listener] of this.listeners) this.client.off(event as 'commandStarted', listener as never);
    this.listeners.length = 0;
  }

  private newContext(label: string): WorkContext {
    const ctx = createContext(label, this);
    if (this.measurements.size > 0) ctx.measurements = [...this.measurements];
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
  private recordCommand(args: unknown[], run: () => Promise<unknown>, conn: unknown): Promise<unknown> {
    let entry: { ctx: WorkContext; record: CommandRecord } | undefined;
    try {
      const ctx = currentContext();
      const [ns, cmd] = args as [{ db?: unknown } | undefined, Record<string, unknown> | undefined];
      const name = cmd ? Object.keys(cmd)[0] : undefined;
      if (ctx && ctx.owner === this && name) entry = this.open(ctx, -1, name, String(ns?.db), cmd!, conn);
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
    const entry = this.open(ctx, e.requestId, e.commandName, e.databaseName, e.command as Record<string, unknown>, { address: e.address, id: e.connectionId });
    if (entry) this.pending.set(e.requestId, entry);
  }

  private open(ctx: WorkContext, requestId: number, commandName: string, database: string, command: Record<string, unknown>, conn?: unknown): { ctx: WorkContext; record: CommandRecord } | undefined {
    const described = describeCommand(commandName, database, command);
    if (!described) return undefined;
    if (this.holding && conn) {
      // The pool's address (what pool events carry), not the socket's resolved one.
      const c = conn as { id?: unknown; address?: unknown; authContext?: { options?: { hostAddress?: unknown } } };
      const o = described.cursorId ? this.cursors.get(described.cursorId) : undefined;
      if (this.holding.size >= 4096) this.holding.clear();
      this.holding.set(
        `${String(c.authContext?.options?.hostAddress ?? c.address)}#${String(c.id)}`,
        `${ctx.label}: ${o ? `${o.commandName} ${o.database}.${o.collection ?? ''} ${o.fingerprint}` : `${commandName} ${database}.${described.collection ?? ''} ${described.fingerprint}`}`,
      );
    }
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
    if (this.plans && !record.prefetch) {
      this.plans.consider({ context: ctx.label, database, collection: described.collection, commandName, command, fingerprint: described.fingerprint, shape: described.shape, callSite: record.callSite });
    }
    if (this.hazards) {
      try {
        this.hazards.command(ctx, record, command, described.filter);
      } catch {
        this.internalErrors++;
      }
    }
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
      if (this.hazards) {
        try {
          this.hazards.reply(ctx, record, reply);
        } catch {
          this.internalErrors++;
        }
      }
    } else if (reply.n !== undefined) {
      record.returned = reply.n;
    }
    if (!ctx.ended) ctx.commands.push(record);
  }

  private sampled(): boolean {
    if (this.measurements.size > 0) return this.enabled;
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
    for (const m of ctx.measurements ?? []) m.collect(ctx.commands);
    ctx.measurements = undefined;
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
      this.hazards?.end(ctx);
    } catch {
      this.internalErrors++;
    }
    ctx.inputs = undefined;
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

const PLAN_RULES = new Set(['KR-P001', 'KR-P010', 'KR-P003']);
const isPlanFinding = (f: PlanFinding | HazardFinding): f is PlanFinding => PLAN_RULES.has(f.rule);

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
