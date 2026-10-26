import type { Finding, NPlusOneFinding, RepeatEvidence, RepeatedLookupFinding } from './types.ts';

export interface ReportOptions {
  /**
   * Round-trip times to project the cost onto. Locally a round trip is ~0.1 ms, which is why N+1
   * goes unnoticed; on Atlas every extra query pays the network round trip.
   * Defaults: 1 ms (app in the same region as the cluster), 20 ms (another region, or a laptop).
   */
  rttMs?: number[];
  /** Driver default is 100. Parallel N+1 opens up to this many connections per process. */
  maxPoolSize?: number;
}

function ms(n: number): string {
  return n >= 100 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`;
}

function shortShape(shape: string): string {
  try {
    const parsed = JSON.parse(shape) as { filter?: unknown };
    return JSON.stringify(parsed.filter ?? parsed);
  } catch {
    return shape;
  }
}

/** Extra round trips beyond the one a batched `$in` query would need, at a given RTT. */
export function projectedExtraMs(f: RepeatEvidence, rttMs: number, maxPoolSize = 100): number {
  const waves = f.execution === 'serial' ? f.queries : Math.ceil(f.queries / Math.max(1, Math.min(f.peakConcurrency, maxPoolSize)));
  return Math.max(0, waves - 1) * rttMs;
}

export function formatNPlusOne(f: NPlusOneFinding, options: ReportOptions = {}): string {
  const rtts = options.rttMs ?? [1, 20];
  const pool = options.maxPoolSize ?? 100;
  const coll = f.namespace.split('.').slice(1).join('.');
  const field = f.lookupFields.join(', ');
  const lines: string[] = [];

  lines.push(`KR-P002 N+1 query  [${f.confidence}]  in ${f.context}`);
  lines.push(`  ${f.queries} × ${f.namespace} ${shortShape(f.shape)} in one unit of work, ${f.execution}` +
    (f.execution === 'parallel' ? ` (up to ${f.peakConcurrency} at once)` : ''));
  for (const site of f.callSites.slice(0, 3)) lines.push(`  at ${site}`);

  lines.push(`  Driven by ${f.parent.namespace} (${f.parent.returned ?? '?'} document${f.parent.returned === 1 ? '' : 's'}${f.parent.callSite ? `, ${f.parent.callSite}` : ''}):`);
  lines.push(f.confidence === 'strong'
    ? `  every ${field} looked up is a value of its \`${f.parent.field}\` field.`
    : `  every ${field} looked up is a key built from a value of its \`${f.parent.field}\` field.`);
  if (f.distinctKeys < f.queries) {
    lines.push(`  Only ${f.distinctKeys} distinct ${field} value(s): ${f.queries - f.distinctKeys} of these queries fetched something already fetched.`);
  }

  lines.push('');
  lines.push(`  Why it hides locally: these took ${ms(f.localWallMs)} here, because a local round trip is almost free.`);
  lines.push('  Each query is an ideal indexed lookup, so server-side tools (profiler, Performance Advisor) never flag it.');
  for (const rtt of rtts) {
    lines.push(`  At ${rtt} ms per round trip: about +${ms(projectedExtraMs(f, rtt, pool))} per execution, growing with the number of parent documents.`);
  }
  if (f.execution === 'parallel') {
    lines.push(`  Run in parallel it costs connections instead of latency: each execution can hold up to ${Math.min(f.queries, pool)} pooled connections per process at once.`);
  }

  lines.push('');
  if (f.autoBatched) {
    lines.push(`  Auto-batched: ${f.autoBatched.served} of ${f.queries} lookups were answered from a prefetch, so this execution made ` +
      `${f.autoBatched.roundTrips} round trip(s) instead of ${f.queries}. That is a runtime patch; the code fix below is still the real one.`);
  }
  // flatMap, not map: the parent field may be an array (tagIds), and flatMap of a scalar is just the scalar.
  const parentVar = `parents.flatMap((p) => p.${f.parent.field})`;
  if (f.confidence === 'derived') {
    lines.push(`  Fix: build every key from ${parentVar} first, then fetch them in one query with ${field}: { $in: keys } and join in memory.`);
  } else if (f.lookupFields.length === 1) {
    lines.push('  Fix: fetch them in one query and join in memory:');
    lines.push(`    const rows = await db.collection('${coll}').find({ ${field}: { $in: [...new Set(${parentVar})] } }).toArray();`);
    lines.push(`    const by = new Map(rows.map((r) => [String(r.${field}), r]));`);
  } else {
    lines.push(`  Fix: fetch them in one query with $or over (${field}), or restructure to a single $in on the varying field.`);
  }
  lines.push('  GraphQL resolvers: batch with DataLoader. Mongoose: populate() already batches with $in.');
  return lines.join('\n');
}

export function formatRepeatedLookup(f: RepeatedLookupFinding, options: ReportOptions = {}): string {
  const rtts = options.rttMs ?? [1, 20];
  const pool = options.maxPoolSize ?? 100;
  const field = f.lookupFields.join(', ');
  const lines: string[] = [];
  lines.push(`KR-P012 repeated lookup  [info]  in ${f.context}`);
  lines.push(`  ${f.queries} × ${f.namespace} ${shortShape(f.shape)} in one unit of work, ${f.execution}, ${f.distinctKeys} distinct ${field} value(s)`);
  for (const site of f.callSites.slice(0, 3)) lines.push(`  at ${site}`);
  lines.push('  No earlier result in this unit supplies these values, so this is not reported as N+1.');
  if (f.distinctKeys < f.queries) {
    lines.push(`  ${f.queries - f.distinctKeys} of them fetched something already fetched in the same unit of work.`);
  }
  for (const rtt of rtts) lines.push(`  At ${rtt} ms per round trip, if batched or deduplicated: about ${ms(projectedExtraMs(f, rtt, pool))} less per execution.`);
  lines.push('');
  lines.push(f.callSites.length > 1
    ? '  Several code paths read the same shape. A request-scoped loader or cache in the data layer serves them with one query.'
    : '  If these come from a loop, collect the values first and fetch them with one $in; if not, reuse the first result.');
  lines.push("  Mongoose and the native driver both accept { _id: { $in: ids } }; Krepis's dedupeReads option removes exact repeats at runtime.");
  return lines.join('\n');
}

export function formatFinding(f: Finding, options: ReportOptions = {}): string {
  return f.rule === 'KR-P002' ? formatNPlusOne(f, options) : formatRepeatedLookup(f, options);
}
