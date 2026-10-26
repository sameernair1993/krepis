import { resolveCallSite } from '../callsite.ts';
import type { WorkContext } from '../context.ts';
import { valueKey } from '../fingerprint.ts';
import { docsOf } from '../reply.ts';
import type { CommandRecord, Confidence, Finding, RepeatEvidence } from '../types.ts';

export interface NPlusOneOptions {
  /** Repeats needed to report a repeated lookup (KR-P012) when no earlier result drives them. */
  minRepeats: number;
  /**
   * Repeats needed when every looked-up value is found in one field of an earlier result. Local data
   * is small, so the loop may only run twice; the containment evidence is what makes it reportable.
   */
  minRepeatsWithParent: number;
  /**
   * Repeats needed when the looked-up values are keys derived from a parent field (`user:3` from 3).
   * Token matches are looser than exact ones, so they need one more repeat and two distinct values.
   */
  minRepeatsDerived: number;
}

const DEFAULTS: NPlusOneOptions = { minRepeats: 3, minRepeatsWithParent: 2, minRepeatsDerived: 3 };
// An aggregate has lookup keys only when it is find-shaped; any other pipeline has no `point`.
const READ_COMMANDS = new Set(['find', 'count', 'distinct', 'aggregate']);

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !('_bsontype' in v) && !(v instanceof Date);
}

function addValue(index: Map<string, Set<string>>, field: string, value: unknown): void {
  let set = index.get(field);
  if (!set) index.set(field, (set = new Set()));
  set.add(valueKey(value));
}

/** field -> value keys over the parent's documents: top level, one nested level, arrays flattened. */
function indexFields(docs: unknown[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of docs) {
    if (!isPlain(doc)) continue;
    for (const [k, v] of Object.entries(doc)) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (isPlain(item)) {
          for (const [k2, v2] of Object.entries(item)) {
            for (const leaf of Array.isArray(v2) ? v2 : [v2]) if (!isPlain(leaf)) addValue(index, `${k}.${k2}`, leaf);
          }
        } else {
          addValue(index, k, item);
        }
      }
    }
  }
  return index;
}

function peakOverlap(records: CommandRecord[]): number {
  const edges: Array<[number, number]> = [];
  for (const r of records) {
    edges.push([r.startedAt, 1]);
    edges.push([r.endedAt ?? r.startedAt, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  for (const [, d] of edges) peak = Math.max(peak, (live += d));
  return peak;
}

interface Parent { record: CommandRecord; field: string; confidence: Confidence; members: CommandRecord[]; returned?: number }

/** Separators apps use to build keys from ids: `user:3`, `_User$abc`, `tenant/7`, `a|b`, `#5`. */
const SEPARATORS = /[:$/|#]/;

/** A value key as a plain string (ObjectId hex, number, string), for derived matching; else undefined. */
function loose(key: string): string | undefined {
  for (const prefix of ['string:', 'oid:', 'number:']) if (key.startsWith(prefix)) return key.slice(prefix.length);
  return undefined;
}

/**
 * The part of each child value that varies: `user:3`, `user:7` -> `3`, `7` when the values split into
 * the same tokens everywhere but one position. Otherwise the whole (loose) values.
 */
function varyingParts(values: string[]): string[] | undefined {
  const plain: string[] = [];
  for (const v of values) {
    const l = loose(v);
    if (l === undefined || l === '') return undefined;
    plain.push(l);
  }
  const split = plain.map((v) => v.split(SEPARATORS));
  const width = split[0]!.length;
  if (width === 1 || split.some((t) => t.length !== width)) return plain;
  const varying: number[] = [];
  for (let i = 0; i < width; i++) if (new Set(split.map((t) => t[i])).size > 1) varying.push(i);
  if (varying.length !== 1) return plain;
  const parts = split.map((t) => t[varying[0]!]!);
  return parts.some((x) => x === '') ? plain : parts;
}

/** A parent field's values as plain strings, plus the tokens of delimited string values (`_User$abc` -> `abc`). */
function looseValues(values: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const l = loose(v);
    if (l === undefined || l === '') continue;
    out.add(l);
    if (v.startsWith('string:') && SEPARATORS.test(l)) for (const t of l.split(SEPARATORS)) if (t !== '') out.add(t);
  }
  return out;
}

/**
 * The earlier result whose documents supply every looked-up value. Without that data link a
 * repeat is not reported as N+1, however many times it runs: counts and timing alone matched by
 * coincidence on real applications.
 *
 * Causality: a parent can only drive lookups that started after it returned. Parents that
 * returned before the first lookup are tried first, as one group. Only if none fits, a parent that
 * returned partway through is tried against the lookups after it, so one same-shape call made earlier
 * by unrelated code no longer hides the loop. Every value looked up after the parent must still be
 * supplied by it.
 */
function findParent(group: CommandRecord[], before: CommandRecord[], lookupFields: string[], opts: NPlusOneOptions): Parent | undefined {
  if (lookupFields.length !== 1) return undefined;
  const field = lookupFields[0]!;
  const starts = group.map((r) => r.startedAt);
  const firstStart = Math.min(...starts);
  const lastStart = Math.max(...starts);
  const withDocs = before.filter((r) => r.endedAt !== undefined && (docsOf(r)?.length ?? 0) > 0);
  const preceding = withDocs.filter((r) => r.endedAt! <= firstStart).reverse();
  const midway = withDocs.filter((r) => r.endedAt! > firstStart && r.endedAt! <= lastStart).sort((a, b) => a.endedAt! - b.endedAt!);
  const index = (p: CommandRecord) => ({ p, index: indexFields(p.docs!), many: (p.returned ?? p.docs!.length) >= 2 });

  for (const [candidates, partial] of [[preceding, false], [midway, true]] as const) {
    const indexed = candidates.map(index);
    const membersOf = (p: CommandRecord) => (partial ? group.filter((r) => r.startedAt >= p.endedAt!) : group);

    // A loop needs at least two items: two documents, or two values in an array field. One document
    // with a scalar field is a re-read of something already fetched, not a fan-out.
    for (const { p, index: fields, many } of indexed) {
      const members = membersOf(p);
      if (members.length < opts.minRepeatsWithParent) continue;
      const childValues = [...new Set(members.map((r) => r.point?.get(field) ?? ''))];
      for (const [pf, values] of fields) {
        if ((many || values.size >= 2) && childValues.every((v) => values.has(v))) return { record: p, field: pf, confidence: 'strong', members };
      }
    }
    for (const { p, index: fields, many } of indexed) {
      const members = membersOf(p);
      if (members.length < opts.minRepeatsDerived) continue;
      const parts = varyingParts([...new Set(members.map((r) => r.point?.get(field) ?? ''))]);
      if (!parts || new Set(parts).size < 2) continue;
      for (const [pf, values] of fields) {
        if (!many && values.size < 2) continue;
        const pool = looseValues(values);
        if (parts.every((v) => pool.has(v))) return { record: p, field: pf, confidence: 'derived', members };
      }
    }
  }
  return findRunParent(group, withDocs, field, opts);
}

/**
 * A run of earlier reads of one shape as the parent: the second level of a nested loop, where each
 * looked-up value came from its own single-document read. Needs `minRepeats` lookups, two distinct values, and
 * for every lookup a read of the run that ended before it started and holds its value, in one shared field.
 * A read does not supply a value its own filter holds: that value came from wherever the read's did.
 */
function findRunParent(group: CommandRecord[], withDocs: CommandRecord[], field: string, opts: NPlusOneOptions): Parent | undefined {
  if (group.length < opts.minRepeats) return undefined;
  const values = group.map((r) => r.point?.get(field) ?? '');
  if (new Set(values).size < 2) return undefined;
  const lastStart = Math.max(...group.map((r) => r.startedAt));
  const runs = new Map<string, CommandRecord[]>();
  for (const r of withDocs) {
    if (r.endedAt! > lastStart) continue;
    const run = runs.get(r.fingerprint);
    if (run) run.push(r);
    else runs.set(r.fingerprint, [r]);
  }
  for (const run of runs.values()) {
    if (run.length < 2) continue;
    // field -> value -> when the run first returned it
    const firstSeen = new Map<string, Map<string, number>>();
    for (const r of run) {
      const own = new Set(r.point?.values());
      for (const [pf, vals] of indexFields(r.docs!)) {
        let seen = firstSeen.get(pf);
        if (!seen) firstSeen.set(pf, (seen = new Map()));
        for (const v of vals) {
          if (own.has(v)) continue;
          const t = seen.get(v);
          if (t === undefined || r.endedAt! < t) seen.set(v, r.endedAt!);
        }
      }
    }
    for (const [pf, seen] of firstSeen) {
      if (group.every((c, i) => (seen.get(values[i]!) ?? Infinity) <= c.startedAt)) {
        const returned = run.reduce((s, r) => s + (r.returned ?? r.docs!.length), 0);
        return { record: run[0]!, field: pf, confidence: 'strong', members: group, returned };
      }
    }
  }
  return undefined;
}

/** KR-P002 (N+1, with a parent) and KR-P012 (repeated lookups, without one) for one unit of work. */
export function detectNPlusOne(ctx: WorkContext, options: Partial<NPlusOneOptions> = {}): Finding[] {
  const opts = { ...DEFAULTS, ...options };
  const commands = ctx.commands.filter((c) => !c.failed).sort((a, b) => a.startedAt - b.startedAt);
  const groups = new Map<string, CommandRecord[]>();
  for (const c of commands) {
    if (!c.point || !READ_COMMANDS.has(c.commandName)) continue;
    const g = groups.get(c.fingerprint);
    if (g) g.push(c);
    else groups.set(c.fingerprint, [c]);
  }

  const findings: Finding[] = [];
  const floor = Math.min(opts.minRepeats, opts.minRepeatsWithParent, opts.minRepeatsDerived);
  for (const group of groups.values()) {
    if (group.length < floor) continue;
    const first = group[0]!;
    const fields = [...(first.point?.keys() ?? [])];
    const varying = fields.filter((f) => new Set(group.map((r) => r.point?.get(f))).size > 1);
    const lookupFields = varying.length > 0 ? varying : fields;
    const keyOf = (r: CommandRecord) => lookupFields.map((f) => r.point?.get(f)).join('\u0000');
    // With residual clauses and one key throughout, the queries may differ only in the residual
    // (`{ status: 'a', due: { $lt: t } }`): repetition of a key is not shown, so nothing is reported.
    if (group.some((r) => r.pointResidual) && new Set(group.map(keyOf)).size < 2) continue;

    const others = commands.filter((c) => c.fingerprint !== first.fingerprint && !c.prefetch);
    const parent = findParent(group, others, lookupFields, opts);
    if (!parent && group.length < opts.minRepeats) continue;
    // Evidence describes the lookups the parent can have driven: those after it returned.
    const members = parent ? parent.members : group;
    const keys = new Set(members.map(keyOf));

    const peak = peakOverlap(members);
    const start = Math.min(...members.map((r) => r.startedAt));
    const end = Math.max(...members.map((r) => r.endedAt ?? r.startedAt));
    const served = members.filter((r) => r.served).length;
    const prefetches = commands.filter((c) => c.prefetch && c.database === first.database && c.collection === first.collection).length;
    const evidence: RepeatEvidence = {
      context: ctx.label,
      namespace: `${first.database}.${first.collection ?? ''}`,
      fingerprint: first.fingerprint,
      shape: first.shape,
      queries: members.length,
      distinctKeys: keys.size,
      lookupFields,
      execution: peak > 1 ? 'parallel' : 'serial',
      peakConcurrency: peak,
      localWallMs: end - start,
      localServerMs: members.reduce((s, r) => s + (r.durationMs ?? 0), 0),
      callSites: [...new Set(members.map((r) => resolveCallSite(r.callSite)).filter((s): s is string => s !== undefined))],
      autoBatched: served > 0 ? { served, roundTrips: members.length - served + prefetches } : undefined,
    };
    if (!parent) {
      findings.push({ rule: 'KR-P012', severity: 'info', ...evidence });
      continue;
    }
    findings.push({
      rule: 'KR-P002',
      severity: 'warn',
      ...evidence,
      confidence: parent.confidence,
      parent: {
        namespace: `${parent.record.database}.${parent.record.collection ?? ''}`,
        fingerprint: parent.record.fingerprint,
        shape: parent.record.shape,
        returned: parent.returned ?? parent.record.returned,
        field: parent.field,
        callSite: resolveCallSite(parent.record.callSite),
      },
    });
  }
  return findings;
}
