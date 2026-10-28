import type { Finding, HazardFinding, IndexKeys, NPlusOneFinding, PlanFinding, RepeatEvidence, RepeatedLookupFinding } from './types.ts';

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

export function formatFinding(f: Finding | PlanFinding | HazardFinding, options: ReportOptions = {}): string {
  if (f.rule === 'KR-P002') return formatNPlusOne(f, options);
  if (f.rule === 'KR-P012') return formatRepeatedLookup(f, options);
  if (f.rule === 'KR-P001' || f.rule === 'KR-P010' || f.rule === 'KR-P003') return formatPlanFinding(f as PlanFinding);
  return formatHazardFinding(f as HazardFinding);
}

const code = (names: string[]) => names.map((n) => `\`${n}\``).join(', ');

export function formatHazardFinding(f: HazardFinding): string {
  const what = `${f.command} ${f.namespace} ${shortShape(f.shape)}`;
  const lines: string[] = [];
  const head = (title: string) => lines.push(`${f.rule} ${title}${f.severity === 'info' ? '  [info]' : ''}  in ${f.context}`);
  const sites = () => { for (const site of f.callSites.slice(0, 3)) lines.push(`  at ${site}`); };
  switch (f.rule) {
    case 'KR-S001':
      head('operator injection signal');
      if (f.input !== undefined) {
        lines.push(`  ${what}: ${code(f.fields)} received an operator object (${f.operators.join(', ')}) that the client sent in the request's ${f.input}.`);
        sites();
        lines.push(`  A client that can send an operator instead of a value can match documents it should not see (a { "$ne": null } matches any value).`);
      } else {
        lines.push(`  ${what}: the call site that sends ${code(f.fields)} as a value also sent it as an operator object (${f.operators.join(', ')}).`);
        sites();
        lines.push(`  If ${code(f.fields)} comes from request input (a JSON body, a parsed query string), a client can send { "$ne": null } instead of a value and match documents it should not see.`);
      }
      lines.push('');
      lines.push(`  Fix: check the type before querying (typeof value === 'string'), or compare with { ${f.fields[0]}: { $eq: value } }, which treats an object as a value.`);
      lines.push('  Mongoose: mongoose.set(\'sanitizeFilter\', true). If this field takes operators by design, ignore this finding.');
      break;
    case 'KR-S002':
      head('server-side JavaScript');
      lines.push(`  ${what} uses ${f.operators.join(', ')}. The server runs JavaScript for it: input built into it runs as code on the server.`);
      lines.push('  It is also slow, cannot use an index for its own condition, and is deprecated (server-side JavaScript in MongoDB 8.0, mapReduce in 5.0).');
      sites();
      lines.push('');
      lines.push('  Fix: express it with query operators or $expr, or an aggregation pipeline.');
      break;
    case 'KR-S003':
      head('unanchored regular expression');
      lines.push(`  ${what} matches ${code(f.fields)} with a pattern that does not start with ^, so the server tests it against every index key or document.`);
      sites();
      lines.push('  If the pattern is built from input, escape it and bound its length: special characters are otherwise interpreted, and a crafted pattern can run for a long time.');
      lines.push('');
      lines.push('  Fix: anchor it (^prefix) when a prefix match is meant; for search, use a text index or Atlas Search.');
      break;
    case 'KR-S004':
      head('sensitive field returned');
      lines.push(`  ${what} returned ${code(f.fields)}. If the result reaches a response or a log, so do they.`);
      sites();
      lines.push('');
      lines.push(`  Fix: project them out ({ projection: { ${f.fields[0]}: 0 } }); Mongoose: select: false on the schema path. Where the read needs them (a login check), ignore this.`);
      break;
    case 'KR-P006':
      head('unbounded read');
      lines.push(`  ${what} has no limit and returned ${f.returned} documents in one unit of work. Its cost grows with the collection: memory, time and transfer.`);
      sites();
      lines.push('');
      lines.push('  Fix: page it (a limit with a range on an indexed field, such as _id greater than the last one seen), or iterate the cursor if every document is needed.');
      break;
  }
  return lines.join('\n');
}

function indexText(keys: IndexKeys): string {
  return `{ ${Object.entries(keys).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${v}`).join(', ')} }`;
}

export function formatPlanFinding(f: PlanFinding): string {
  const coll = f.namespace.split('.').slice(1).join('.');
  const lines: string[] = [];
  const what = `${f.command} ${f.namespace} ${shortShape(f.shape)}`;
  if (f.rule === 'KR-P001') {
    lines.push(`KR-P001 collection scan  in ${f.context}`);
    lines.push(`  ${what} reads every document in ${coll}: no index supports this filter.`);
  } else if (f.rule === 'KR-P010') {
    lines.push(`KR-P010 in-memory sort  in ${f.context}`);
    lines.push(`  ${what} is sorted in memory: no index provides this order, so every matching document is read and sorted before the first is returned.`);
  } else {
    lines.push(`KR-P003 $lookup without an index  in ${f.context}`);
    lines.push(`  ${what} joins ${f.lookup?.from} on ${f.lookup?.foreignField}, and ${f.lookup?.from} has no index that starts with ${f.lookup?.foreignField}.`);
    lines.push(`  Without one, the server scans ${f.lookup?.from} for every input document, or builds a hash table from all of it.`);
  }
  for (const site of f.callSites.slice(0, 3)) lines.push(`  at ${site}`);
  lines.push(`  Plan: ${f.plan.stages.join(' > ') || 'unknown'}${f.plan.indexes.length > 0 ? ` (indexes: ${f.plan.indexes.join(', ')})` : ''}`);
  lines.push('');
  const target = f.rule === 'KR-P003' ? f.lookup?.from ?? coll : coll;
  lines.push(f.rule === 'KR-P003' ? '  Fix: index the joined field:' : '  Fix: add an index, with equality fields first, then the sort, then range fields:');
  lines.push(`    db.collection('${target}').createIndex(${indexText(f.suggestedIndex)})`);
  lines.push(`  In a Krepis schema: indexes: [{ keys: ${indexText(f.suggestedIndex)} }]. Mongoose: schema.index(${indexText(f.suggestedIndex)}).`);
  lines.push('  Check it against the collection\'s other queries first: an existing index may only need a field added.');
  return lines.join('\n');
}
