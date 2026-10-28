import type { CallSite } from './callsite.ts';

export interface CommandRecord {
  requestId: number;
  commandName: string;
  database: string;
  collection: string | undefined;
  /** Normalised shape with values replaced by type tokens. Safe to persist. */
  shape: string;
  fingerprint: string;
  /**
   * Lookup keys: the equality conjuncts of the filter, field -> value key. Values are kept in
   * memory for the lifetime of the context only, never persisted or reported.
   */
  point: Map<string, string> | undefined;
  /** The filter also had non-equality conjuncts (`_rperm: { $in }`, `$or`), ignored as lookup keys. */
  pointResidual?: boolean;
  /** Captured stack; formatted only if the command ends up in a finding (`resolveCallSite`). */
  callSite: CallSite | undefined;
  startedAt: number;
  endedAt: number | undefined;
  durationMs: number | undefined;
  returned: number | undefined;
  failed: boolean;
  /** Documents returned, held by reference until the context ends, for parent correlation. Read through `docsOf`. */
  docs: unknown[] | undefined;
  /** Retained documents not decoded yet, with how many each batch holds. */
  lazyDocs?: Array<{ count: number; read: () => unknown[] }>;
  cursorId: string | undefined;
  /** An `$in` prefetch sent by auto-batching, not by the application. */
  prefetch?: boolean;
  /** A lookup auto-batching answered locally, without a round trip. */
  served?: boolean;
  /** A `find` sent without a limit (KR-P006). */
  unbounded?: boolean;
}

/**
 * How the lookups were tied to the parent result. Repetition alone is never reported as N+1.
 * - strong: every looked-up value is a value of one field of the parent's documents.
 * - derived: every looked-up value is a key built from such a value (`user:3` from 3, `abc` from `_User$abc`).
 */
export type Confidence = 'strong' | 'derived';

/** What both repeat findings measure about one query shape in one unit of work. */
export interface RepeatEvidence {
  context: string;
  namespace: string;
  fingerprint: string;
  shape: string;
  queries: number;
  distinctKeys: number;
  lookupFields: string[];
  execution: 'serial' | 'parallel';
  peakConcurrency: number;
  localWallMs: number;
  localServerMs: number;
  /** Distinct call chains among the sampled repeats (up to three samples per shape per unit). */
  callSites: string[];
  /** Present when auto-batching handled this pattern in this context. */
  autoBatched: { served: number; roundTrips: number } | undefined;
}

/** KR-P002: a lookup per document of an earlier result, with the data link that proves it. */
export interface NPlusOneFinding extends RepeatEvidence {
  rule: 'KR-P002';
  severity: 'warn';
  confidence: Confidence;
  parent: {
    namespace: string;
    fingerprint: string;
    shape: string;
    returned: number | undefined;
    field: string;
    callSite: string | undefined;
  };
}

/**
 * KR-P012: the same point lookup repeated in one unit of work with no earlier result that drives it.
 * Informational, not an N+1 claim: often several code paths reading the same thing.
 */
export interface RepeatedLookupFinding extends RepeatEvidence {
  rule: 'KR-P012';
  severity: 'info';
  /** Absent: there is no parent, which is what makes this a repeated lookup and not an N+1. */
  confidence?: undefined;
  parent?: undefined;
}

export type Finding = NPlusOneFinding | RepeatedLookupFinding;

/** An index key pattern: field → 1 or -1, in index order. */
export type IndexKeys = Record<string, 1 | -1>;

/**
 * KR-P001 collection scan, KR-P010 in-memory sort, KR-P003 `$lookup` without an index: what the server's query planner
 * chose for a query shape (`observe(client, { explain: true })`). Reported once per shape per observer.
 */
export interface PlanFinding {
  rule: 'KR-P001' | 'KR-P010' | 'KR-P003';
  severity: 'warn';
  /** Unit of work in which the shape was first seen. */
  context: string;
  namespace: string;
  fingerprint: string;
  command: string;
  shape: string;
  callSites: string[];
  /** Stage and index names of the winning plan. */
  plan: { stages: string[]; indexes: string[] };
  /** The index that would serve this query, in equality, sort, range order; for KR-P003, on `lookup.from`. */
  suggestedIndex: IndexKeys;
  /** KR-P003 only: the joined collection and field. */
  lookup?: { from: string; foreignField: string };
}

/**
 * Hazards seen in observe mode, reported once per query shape (KR-S001 once per call site and field) per observer.
 * Field names and operator names only; never values.
 * - KR-S001 operator injection: a filter field received an operator object that came from request input, or one call
 *   site sent a scalar and an operator object for the same field in otherwise identical queries.
 * - KR-S002 server-side JavaScript: `$where`, `$function`, `$accumulator` or `mapReduce`.
 * - KR-S003 unanchored regular expression (info).
 * - KR-S004 sensitive field returned by a read (info).
 * - KR-P006 unbounded read: a `find` without a limit that returned more than the threshold.
 */
export interface HazardFinding {
  rule: 'KR-S001' | 'KR-S002' | 'KR-S003' | 'KR-S004' | 'KR-P006';
  severity: 'warn' | 'info';
  context: string;
  namespace: string;
  command: string;
  fingerprint: string;
  shape: string;
  callSites: string[];
  /** Field paths involved. */
  fields: string[];
  /** Operators involved (`$where`, `$ne`, ...). */
  operators: string[];
  /** KR-P006: documents the read returned. */
  returned?: number;
  /**
   * KR-S001: the request input the operator object came from (`body`, `query`, `params`, `variables`, or a name given
   * to `observer.input`). Absent when the finding comes from one call site sending both forms.
   */
  input?: string;
}
