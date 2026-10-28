import { resolveCallSite } from './callsite.ts';
import type { Observer } from './collector.ts';
import type { CommandRecord } from './types.ts';

/** One query shape within a measurement. */
export interface QueryShapeCount {
  namespace: string;
  command: string;
  shape: string;
  /** Commands of this shape the application issued. */
  count: number;
  /** Nearest application frames of the first one, when a stack was captured. */
  callSite: string | undefined;
}

export interface QueryCount {
  /** Commands the application issued. A cursor's `getMore` batches belong to the command that opened it. */
  commands: number;
  /** Commands sent to the server: `commands`, less those `optimize` answered locally, plus its own prefetches. */
  roundTrips: number;
  /** Units of work that contributed. */
  units: number;
  /** Per shape, most frequent first. */
  shapes: QueryShapeCount[];
}

/** @internal Collects the commands of every unit of work that begins while a measurement runs. */
export class Measurement {
  readonly units = new Set<object>();
  private readonly records: CommandRecord[] = [];
  private seen = 0;

  collect(commands: readonly CommandRecord[]): void {
    this.seen++;
    this.records.push(...commands);
  }

  result(): QueryCount {
    const shapes = new Map<string, QueryShapeCount & { site: CommandRecord['callSite'] }>();
    let commands = 0;
    let roundTrips = 0;
    for (const r of this.records) {
      if (!r.served) roundTrips++;
      if (r.prefetch) continue;
      commands++;
      const namespace = `${r.database}.${r.collection ?? ''}`;
      const key = `${r.commandName} ${namespace} ${r.shape}`;
      const entry = shapes.get(key);
      if (entry) {
        entry.count++;
        entry.site ??= r.callSite;
      } else {
        shapes.set(key, { namespace, command: r.commandName, shape: r.shape, count: 1, callSite: undefined, site: r.callSite });
      }
    }
    return {
      commands,
      roundTrips,
      units: this.seen,
      shapes: [...shapes.values()]
        .sort((a, b) => b.count - a.count)
        .map(({ site, ...s }) => ({ ...s, callSite: resolveCallSite(site) })),
    };
  }
}

export interface QueryBudget {
  /** Most commands the application may issue. */
  max: number;
}

/** Thrown by `expectQueries` when a block issues more commands than its budget. */
export class KrepisQueryBudgetError extends Error {
  readonly queries: QueryCount;
  readonly budget: QueryBudget;

  constructor(label: string, budget: QueryBudget, queries: QueryCount) {
    super(formatQueryCount(`Expected at most ${budget.max} quer${budget.max === 1 ? 'y' : 'ies'} in ${label}, got ${queries.commands}`, queries));
    this.name = 'KrepisQueryBudgetError';
    this.queries = queries;
    this.budget = budget;
  }
}

function shortShape(shape: string): string {
  try {
    const parsed = JSON.parse(shape) as { filter?: unknown };
    return JSON.stringify(parsed.filter ?? parsed);
  } catch {
    return shape;
  }
}

/** A heading followed by the shapes, most frequent first, each with its call site. */
export function formatQueryCount(heading: string, queries: QueryCount): string {
  const lines = [`${heading}:`];
  const width = String(queries.shapes[0]?.count ?? 0).length;
  for (const s of queries.shapes) {
    lines.push(`  ${String(s.count).padStart(width)} × ${s.command} ${s.namespace} ${shortShape(s.shape)}`);
    if (s.callSite) lines.push(`  ${' '.repeat(width)}   at ${s.callSite}`);
  }
  return lines.join('\n');
}

/**
 * Runs `fn` and throws `KrepisQueryBudgetError` if it issues more than `budget.max` commands, with each query shape
 * and its call site in the message. Commands in units of work that begin while `fn` runs (requests served in this
 * process, e.g. through supertest) are counted too, so run one measurement at a time per observer.
 */
export async function expectQueries<T>(observer: Observer, budget: QueryBudget, fn: () => Promise<T> | T, label = 'the measured block'): Promise<T> {
  const { result, queries } = await observer.measure(label, fn);
  if (queries.commands > budget.max) throw new KrepisQueryBudgetError(label, budget, queries);
  return result;
}
