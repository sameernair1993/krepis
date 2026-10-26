import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WorkContext } from './context.ts';
import type { Finding } from './types.ts';

/**
 * NDJSON capture of what the collector saw, for `krepis analyze`.
 *
 * Only value-free data is written (see PRIVACY.md): normalised shapes with type tokens, fingerprints, counts,
 * timings, context labels and call sites. Findings are computed in process, so they are written already finished.
 *
 * Line types, after one header line per segment:
 *   {"t":"shape","fp","ns","op","shape"}      once per fingerprint per segment (the dictionary)
 *   {"t":"ctx","at","label","ms","cmds":[[fp, count, served, failed, sumMs, maxMs, returned]]}   one per unit of work
 *   {"t":"finding","at",...Finding}           one per finding
 *
 * Writes happen off the request path: a unit of work's lines are buffered when it ends and appended once per
 * `flushIntervalMs` by an unref'd timer, plus synchronously on detach and process exit. Synchronous appends keep the
 * lines of a segment in order (an async append still in flight at exit could otherwise land after later lines).
 * The buffer is bounded; overflow drops whole units of work and counts them. Nothing here throws into the app.
 */

export const CAPTURE_VERSION = 1;
export const CAPTURE_FILE = /^krepis-.*\.ndjson$/;

export interface CaptureOptions {
  /** Directory for capture segments. Default `.krepis` (relative to the working directory). */
  dir?: string;
  /** Start a new segment file after this many bytes. Default 16 MB. */
  segmentBytes?: number;
  /** Delete capture files in `dir` older than this when a segment is opened. Default 7. 0 keeps everything. */
  retentionDays?: number;
  /** Lines waiting to be written are capped at this; beyond it units of work are dropped. Default 8 MB. */
  maxBufferBytes?: number;
  /** Default 1,000. */
  flushIntervalMs?: number;
}

export type CaptureSetting = boolean | string | CaptureOptions;

export interface CaptureStats {
  /** Units of work written. */
  contexts: number;
  lines: number;
  bytes: number;
  segments: number;
  /** Units of work dropped because the buffer was full. */
  dropped: number;
  /** Failed writes (their lines are discarded, never retried). */
  errors: number;
}

export function emptyCaptureStats(): CaptureStats {
  return { contexts: 0, lines: 0, bytes: 0, segments: 0, dropped: 0, errors: 0 };
}

/** Explicit option wins; otherwise `KREPIS_CAPTURE` (`1`/`true` for the default directory, or a directory). */
export function resolveCapture(setting: CaptureSetting | undefined, env = process.env.KREPIS_CAPTURE): Required<CaptureOptions> | undefined {
  let opts: CaptureOptions | undefined;
  if (setting === undefined) {
    if (env === undefined || env === '' || env === '0' || env === 'false') return undefined;
    opts = env === '1' || env === 'true' ? {} : { dir: env };
  } else if (setting === false) {
    return undefined;
  } else {
    opts = setting === true ? {} : typeof setting === 'string' ? { dir: setting } : setting;
  }
  return {
    dir: opts.dir ?? '.krepis',
    segmentBytes: opts.segmentBytes ?? 16 * 1024 * 1024,
    retentionDays: opts.retentionDays ?? 7,
    maxBufferBytes: opts.maxBufferBytes ?? 8 * 1024 * 1024,
    flushIntervalMs: opts.flushIntervalMs ?? 1000,
  };
}

function packageVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = packageVersion();
const writers = new Set<CaptureWriter>();
let exitHooked = false;

function onExit(): void {
  for (const w of writers) w.flush();
}

type CmdRow = [fp: string, count: number, served: number, failed: number, sumMs: number, maxMs: number, returned: number];

const round = (n: number) => Math.round(n * 1000) / 1000;

export class CaptureWriter {
  readonly stats: CaptureStats = emptyCaptureStats();
  private readonly opts: Required<CaptureOptions>;
  private readonly stamp = new Date().toISOString().replace(/[:.]/g, '-');
  private pending: Array<{ seg: number; text: string }> = [];
  private pendingBytes = 0;
  private seg = -1;
  private segBytes = 0;
  private known = new Set<string>();
  private dirReady = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: Required<CaptureOptions>) {
    this.opts = opts;
    writers.add(this);
    if (!exitHooked) {
      exitHooked = true;
      process.on('exit', onExit);
    }
  }

  get dir(): string {
    return this.opts.dir;
  }

  /** Path of segment `seg`. */
  segmentPath(seg: number): string {
    return join(this.opts.dir, `krepis-${this.stamp}-${process.pid}-${seg}.ndjson`);
  }

  /** Buffer one finished unit of work. Called from the collector when a context ends, before it is cleared. */
  record(ctx: WorkContext, findings: readonly Finding[]): void {
    const at = Date.now();
    const shapes = new Map<string, { ns: string; op: string; shape: string }>();
    const rows = new Map<string, CmdRow>();
    for (const c of ctx.commands) {
      let row = rows.get(c.fingerprint);
      if (!row) {
        row = [c.fingerprint, 0, 0, 0, 0, 0, 0];
        rows.set(c.fingerprint, row);
        shapes.set(c.fingerprint, { ns: `${c.database}.${c.collection ?? ''}`, op: c.commandName, shape: c.shape });
      }
      const ms = c.durationMs ?? 0;
      row[1]++;
      if (c.served) row[2]++;
      if (c.failed) row[3]++;
      row[4] += ms;
      if (ms > row[5]) row[5] = ms;
      row[6] += c.returned ?? 0;
    }
    for (const row of rows.values()) {
      row[4] = round(row[4]);
      row[5] = round(row[5]);
    }

    const body: string[] = [JSON.stringify({ t: 'ctx', at, label: ctx.label, ms: round(performance.now() - ctx.startedAt), cmds: [...rows.values()] })];
    for (const f of findings) body.push(JSON.stringify({ t: 'finding', at, ...f }));
    const bodyBytes = body.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

    // Shape lines depend on what the target segment already holds, so the segment is chosen first.
    let seg = this.seg;
    const fresh = seg < 0 || (this.segBytes > 0 && this.segBytes + bodyBytes > this.opts.segmentBytes);
    if (fresh) seg++;
    const known = fresh ? new Set<string>() : this.known;
    const head: string[] = [];
    if (fresh) {
      head.push(JSON.stringify({ krepis_capture: CAPTURE_VERSION, krepis: VERSION, node: process.version, pid: process.pid, startedAt: new Date(at).toISOString() }));
    }
    for (const [fp, s] of shapes) if (!known.has(fp)) head.push(JSON.stringify({ t: 'shape', fp, ...s }));
    const lines = head.concat(body);
    const text = lines.join('\n') + '\n';
    const bytes = Buffer.byteLength(text);

    if (this.pendingBytes + bytes > this.opts.maxBufferBytes) {
      this.stats.dropped++;
      return;
    }
    if (fresh) {
      this.seg = seg;
      this.segBytes = 0;
      this.known = known;
    }
    for (const fp of shapes.keys()) this.known.add(fp);
    this.segBytes += bytes;
    this.pending.push({ seg, text });
    this.pendingBytes += bytes;
    this.stats.contexts++;
    this.stats.lines += lines.length;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.opts.flushIntervalMs);
    this.timer.unref();
  }

  /** Write everything buffered, synchronously. Safe to call at any time; never throws. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    // Consecutive chunks for one segment become one append.
    let i = 0;
    while (i < batch.length) {
      const seg = batch[i]!.seg;
      let text = '';
      while (i < batch.length && batch[i]!.seg === seg) text += batch[i++]!.text;
      try {
        this.prepare(seg);
        appendFileSync(this.segmentPath(seg), text);
        this.stats.bytes += Buffer.byteLength(text);
      } catch {
        this.stats.errors++;
      }
    }
  }

  /** Ensure the directory exists; on each new segment, count it and prune expired captures. */
  private opened = -1;
  private prepare(seg: number): void {
    if (!this.dirReady) {
      mkdirSync(this.opts.dir, { recursive: true });
      this.dirReady = true;
    }
    if (seg <= this.opened) return;
    this.opened = seg;
    this.stats.segments++;
    this.prune();
  }

  private prune(): void {
    if (this.opts.retentionDays <= 0) return;
    const cutoff = Date.now() - this.opts.retentionDays * 86_400_000;
    try {
      for (const name of readdirSync(this.opts.dir)) {
        if (!CAPTURE_FILE.test(name)) continue;
        const path = join(this.opts.dir, name);
        try {
          if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
        } catch {
          // Another process may have pruned it first.
        }
      }
    } catch {
      this.stats.errors++;
    }
  }

  close(): void {
    this.flush();
    writers.delete(this);
  }
}
