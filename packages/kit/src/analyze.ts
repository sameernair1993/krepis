import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURE_FILE, CAPTURE_VERSION } from './capture.ts';
import { formatFinding, projectedExtraMs, type ReportOptions } from './report.ts';
import type { Finding, HazardFinding, PlanFinding, RepeatedLookupFinding } from './types.ts';

/** Offline reading of NDJSON captures (see capture.ts) and grouping of findings across units of work. */

export interface Shape {
  ns: string;
  op: string;
  shape: string;
}

export interface LoadedCaptures {
  files: string[];
  /** Files skipped: unreadable, no header, or a newer capture version. */
  skipped: Array<{ file: string; reason: string }>;
  contexts: number;
  commands: number;
  /** Commands answered by an optimisation without a round trip. */
  served: number;
  /** Unparseable lines (a process killed mid-write leaves at most one per segment). */
  malformed: number;
  shapes: Map<string, Shape>;
  findings: Finding[];
  /** Plan findings (KR-P001, KR-P010, KR-P003), from captures written with `explain` on. */
  plans: PlanFinding[];
  /** Hazard findings (KR-S001 to KR-S004, KR-P006). */
  hazards: HazardFinding[];
}

/** Capture files under the given paths: directories are listed (non-recursively), files are taken as given. */
export function captureFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      out.push(p); // reported as unreadable by loadCaptures
      continue;
    }
    if (!isDir) {
      out.push(p);
      continue;
    }
    for (const name of readdirSync(p).sort()) if (CAPTURE_FILE.test(name)) out.push(join(p, name));
  }
  return out;
}

export function loadCaptures(files: string[]): LoadedCaptures {
  const result: LoadedCaptures = { files: [], skipped: [], contexts: 0, commands: 0, served: 0, malformed: 0, shapes: new Map(), findings: [], plans: [], hazards: [] };
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      result.skipped.push({ file, reason: (e as Error).message });
      continue;
    }
    const lines = text.split('\n');
    let header: { krepis_capture?: unknown } | undefined;
    try {
      header = JSON.parse(lines[0] ?? '') as { krepis_capture?: unknown };
    } catch {
      header = undefined;
    }
    if (typeof header?.krepis_capture !== 'number') {
      result.skipped.push({ file, reason: 'not a krepis capture (no header line)' });
      continue;
    }
    if (header.krepis_capture > CAPTURE_VERSION) {
      result.skipped.push({ file, reason: `capture version ${header.krepis_capture} is newer than this krepis (${CAPTURE_VERSION})` });
      continue;
    }
    result.files.push(file);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === '') continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        result.malformed++;
        continue;
      }
      if (rec.t === 'shape' && typeof rec.fp === 'string') {
        result.shapes.set(rec.fp, { ns: String(rec.ns), op: String(rec.op), shape: String(rec.shape) });
      } else if (rec.t === 'ctx' && Array.isArray(rec.cmds)) {
        result.contexts++;
        for (const row of rec.cmds as unknown[][]) {
          result.commands += Number(row[1]) || 0;
          result.served += Number(row[2]) || 0;
        }
      } else if (rec.t === 'finding' && (rec.rule === 'KR-P002' || rec.rule === 'KR-P012')) {
        const { t: _t, at: _at, ...finding } = rec;
        result.findings.push(upgradeFinding(finding));
      } else if (rec.t === 'finding' && PLAN_RULES.has(rec.rule as string)) {
        const { t: _t, at: _at, ...finding } = rec;
        result.plans.push(finding as unknown as PlanFinding);
      } else if (rec.t === 'finding' && HAZARD_RULES.has(rec.rule as string)) {
        const { t: _t, at: _at, ...finding } = rec;
        result.hazards.push(finding as unknown as HazardFinding);
      }
    }
  }
  return result;
}

const PLAN_RULES = new Set(['KR-P001', 'KR-P010', 'KR-P003']);
const HAZARD_RULES = new Set(['KR-S001', 'KR-S002', 'KR-S003', 'KR-S004', 'KR-P006']);

/**
 * Captures written by earlier versions hold KR-P002 findings without a data link ('likely' or 'pattern'
 * confidence). Those are read as KR-P012, which is what the current rule would report for them.
 */
function upgradeFinding(rec: Record<string, unknown>): Finding {
  const parent = rec.parent as { field?: unknown } | undefined;
  if (rec.rule === 'KR-P002' && (rec.confidence === 'strong' || rec.confidence === 'derived') && typeof parent?.field === 'string') {
    return rec as unknown as Finding;
  }
  if (rec.rule === 'KR-P012') return rec as unknown as Finding;
  const { confidence: _c, parent: _p, ...rest } = rec;
  return { ...rest, rule: 'KR-P012', severity: 'info' } as unknown as RepeatedLookupFinding;
}

export interface FindingGroup {
  rule: Finding['rule'];
  key: string;
  /** Units of work in which this pattern was found. */
  occurrences: number;
  /** Context labels (routes, `run()` labels) with how often each produced it. */
  labels: Record<string, number>;
  queries: { min: number; max: number };
  /** Occurrences in which auto-batching answered some of the lookups. */
  autoBatched: number;
  /** The strongest, then largest, occurrence: what the report shows. */
  representative: Finding;
}

function rank(f: Finding): number {
  return f.rule === 'KR-P012' ? 0 : f.confidence === 'strong' ? 2 : 1;
}

/** Same rule, query shape, parent and first call site → one pattern, however many requests hit it. */
export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const f of findings) {
    const parent = f.rule === 'KR-P002' ? f.parent : undefined;
    const key = [f.rule, f.fingerprint, parent?.fingerprint ?? '', parent?.field ?? '', f.callSites[0] ?? ''].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { rule: f.rule, key, occurrences: 0, labels: {}, queries: { min: f.queries, max: f.queries }, autoBatched: 0, representative: f };
      groups.set(key, g);
    }
    g.occurrences++;
    g.labels[f.context] = (g.labels[f.context] ?? 0) + 1;
    g.queries.min = Math.min(g.queries.min, f.queries);
    g.queries.max = Math.max(g.queries.max, f.queries);
    if (f.autoBatched) g.autoBatched++;
    const r = g.representative;
    if (rank(f) > rank(r) || (rank(f) === rank(r) && f.queries > r.queries)) g.representative = f;
  }
  // N+1 first, then repeated lookups; within each, most total wasted round trips first.
  return [...groups.values()].sort((a, b) => order(a) - order(b) || cost(b) - cost(a) || a.key.localeCompare(b.key));
}

function order(g: FindingGroup): number {
  return g.rule === 'KR-P002' ? 0 : 1;
}

/** Groups that count as N+1 patterns (what `krepis analyze --fail` fails on). */
export function nPlusOneGroups(groups: readonly FindingGroup[]): FindingGroup[] {
  return groups.filter((g) => g.rule === 'KR-P002');
}

function cost(g: FindingGroup): number {
  return g.occurrences * projectedExtraMs(g.representative, 1);
}

export interface PlanGroup {
  rule: PlanFinding['rule'];
  key: string;
  /** Processes (observers) that reported it: each reports a shape once. */
  occurrences: number;
  labels: Record<string, number>;
  representative: PlanFinding;
}

/** Plan findings for the same rule, shape and joined collection → one group. */
export function groupPlanFindings(plans: readonly PlanFinding[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const f of plans) {
    const key = [f.rule, f.fingerprint, f.lookup?.from ?? '', f.lookup?.foreignField ?? ''].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { rule: f.rule, key, occurrences: 0, labels: {}, representative: f };
      groups.set(key, g);
    }
    g.occurrences++;
    g.labels[f.context] = (g.labels[f.context] ?? 0) + 1;
  }
  const order = { 'KR-P001': 0, 'KR-P003': 1, 'KR-P010': 2 };
  return [...groups.values()].sort((a, b) => order[a.rule] - order[b.rule] || a.representative.namespace.localeCompare(b.representative.namespace) || a.key.localeCompare(b.key));
}

export interface HazardGroup {
  rule: HazardFinding['rule'];
  key: string;
  /** Processes (observers) that reported it: each reports a shape once. */
  occurrences: number;
  labels: Record<string, number>;
  representative: HazardFinding;
}

/** Hazards that fail `krepis analyze --fail`; KR-S003 and KR-S004 are informational. */
export const FAILING_HAZARDS = new Set<HazardFinding['rule']>(['KR-S001', 'KR-S002', 'KR-P006']);

/** Hazard findings for the same rule, shape and fields → one group; failing rules first. */
export function groupHazardFindings(hazards: readonly HazardFinding[]): HazardGroup[] {
  const groups = new Map<string, HazardGroup>();
  for (const f of hazards) {
    const key = [f.rule, f.fingerprint, f.fields.join(','), f.rule === 'KR-S001' ? f.callSites[0] ?? '' : ''].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { rule: f.rule, key, occurrences: 0, labels: {}, representative: f };
      groups.set(key, g);
    }
    g.occurrences++;
    g.labels[f.context] = (g.labels[f.context] ?? 0) + 1;
    if ((f.returned ?? 0) > (g.representative.returned ?? 0)) g.representative = f;
  }
  const order = { 'KR-S001': 0, 'KR-S002': 1, 'KR-P006': 2, 'KR-S003': 3, 'KR-S004': 4 };
  return [...groups.values()].sort((a, b) => order[a.rule] - order[b.rule] || a.representative.namespace.localeCompare(b.representative.namespace) || a.key.localeCompare(b.key));
}

export interface AnalyzeOptions extends ReportOptions {
  /** Labels listed per group. Default 3. */
  topLabels?: number;
}

export function formatAnalysis(loaded: LoadedCaptures, groups: FindingGroup[], options: AnalyzeOptions = {}): string {
  const out: string[] = [];
  const n = (x: number) => x.toLocaleString('en-US');
  out.push(`krepis analyze: ${n(loaded.files.length)} capture file(s), ${n(loaded.contexts)} units of work, ${n(loaded.commands)} commands` +
    (loaded.served > 0 ? ` (${n(loaded.served)} answered by optimize)` : '') + '.');
  for (const s of loaded.skipped) out.push(`  skipped ${s.file}: ${s.reason}`);
  if (loaded.malformed > 0) out.push(`  ${n(loaded.malformed)} unreadable line(s) ignored (a process stopped mid-write).`);
  if (loaded.contexts === 0 && groups.length === 0 && loaded.plans.length === 0 && loaded.hazards.length === 0) {
    out.push('No units of work captured. Is observe(client, { capture: true }) running, and does work run inside a context?');
    return out.join('\n');
  }
  const nPlusOne = nPlusOneGroups(groups);
  const repeated = groups.filter((g) => g.rule === 'KR-P012');
  const plans = groupPlanFindings(loaded.plans);
  const hazards = groupHazardFindings(loaded.hazards);
  const failingHazards = hazards.filter((g) => FAILING_HAZARDS.has(g.rule)).length;
  const units = (gs: FindingGroup[]) => gs.reduce((s, g) => s + g.occurrences, 0);
  out.push(nPlusOne.length === 0 ? 'No N+1 patterns found.' : `${n(nPlusOne.length)} N+1 pattern(s), found in ${n(units(nPlusOne))} units of work.`);
  if (plans.length > 0) out.push(`${n(plans.length)} index finding(s): collection scans, in-memory sorts or unindexed $lookup.`);
  if (hazards.length > 0) {
    out.push(`${n(hazards.length)} hazard(s): ${n(failingHazards)} injection, server-side JavaScript or unbounded read; ${n(hazards.length - failingHazards)} info.`);
  }
  if (repeated.length > 0) {
    out.push(`${n(repeated.length)} repeated-lookup pattern(s) (info, not N+1), found in ${n(units(repeated))} units of work.`);
  }
  const top = options.topLabels ?? 3;
  const section = (gs: FindingGroup[], prefix: string) => gs.forEach((g, i) => {
    const labels = Object.entries(g.labels).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = labels.slice(0, top).map(([l, c]) => `${l} (${c})`).join(', ');
    const more = labels.length > top ? `, and ${labels.length - top} more` : '';
    const range = g.queries.min === g.queries.max ? `${g.queries.max}` : `${g.queries.min}–${g.queries.max}`;
    out.push('');
    out.push(`[${prefix}${i + 1}] seen in ${n(g.occurrences)} unit(s) of work, ${range} queries each: ${shown}${more}` +
      (g.autoBatched > 0 ? `; auto-batched in ${n(g.autoBatched)}` : ''));
    out.push(formatFinding(g.representative, options));
  });
  section(nPlusOne, '');
  if (plans.length > 0) {
    out.push('');
    out.push('Index findings (from the query planner, once per query shape):');
    plans.forEach((g, i) => {
      const labels = Object.keys(g.labels).sort();
      const shown = labels.slice(0, top).join(', ') + (labels.length > top ? `, and ${labels.length - top} more` : '');
      out.push('');
      out.push(`[I${i + 1}] first seen in ${shown}`);
      out.push(formatFinding(g.representative, options));
    });
  }
  if (hazards.length > 0) {
    out.push('');
    out.push('Hazards (once per query shape; field and operator names only):');
    hazards.forEach((g, i) => {
      const labels = Object.keys(g.labels).sort();
      const shown = labels.slice(0, top).join(', ') + (labels.length > top ? `, and ${labels.length - top} more` : '');
      out.push('');
      out.push(`[H${i + 1}] first seen in ${shown}`);
      out.push(formatFinding(g.representative, options));
    });
  }
  if (repeated.length > 0) {
    out.push('');
    out.push('Repeated lookups (no earlier result supplies the values; deduplication or loader material, not N+1):');
    section(repeated, 'R');
  }
  return out.join('\n');
}

/** JSON form of an analysis: stable field names, for scripts and CI. */
export function analysisJson(loaded: LoadedCaptures, groups: FindingGroup[]): unknown {
  const plans = groupPlanFindings(loaded.plans);
  const hazards = groupHazardFindings(loaded.hazards);
  return {
    summary: {
      files: loaded.files.length,
      skipped: loaded.skipped,
      contexts: loaded.contexts,
      commands: loaded.commands,
      served: loaded.served,
      malformed: loaded.malformed,
      patterns: nPlusOneGroups(groups).length,
      repeatedLookups: groups.length - nPlusOneGroups(groups).length,
      indexFindings: plans.length,
      hazards: hazards.length,
    },
    groups,
    plans,
    hazards,
  };
}
