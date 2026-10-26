import { fileURLToPath } from 'node:url';
import { dirname, relative, sep } from 'node:path';
import { fieldStorage } from './context.ts';

const OWN_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const STACK_LIMIT = 64;

function locationOf(line: string): string | undefined {
  const inParens = /\((.*):(\d+):(\d+)\)\s*$/.exec(line);
  const bare = /at (?:async )?(.*):(\d+):(\d+)\s*$/.exec(line);
  const m = inParens ?? bare;
  if (!m) return undefined;
  let file = m[1] ?? '';
  if (file.startsWith('file://')) file = fileURLToPath(file);
  return `${file}:${m[2]}`;
}

function isInternal(file: string): boolean {
  return file.startsWith('node:') || file.includes(`${sep}node_modules${sep}`) || file.startsWith(OWN_DIR)
    || !file.includes(sep);
}

/**
 * A captured, not yet formatted stack. V8 records the frames at capture and formats them only when `stack` is first
 * read, so capturing costs about half of `new Error().stack` and the formatting and parsing are skipped entirely for
 * the commands that never appear in a finding, which is nearly all of them.
 */
export interface CallSite {
  stack?: string;
  resolved?: string | null;
  /** GraphQL field being resolved when the command was issued, if the Apollo plugin is in use. */
  field?: string;
}

/**
 * Capture the stack for a later `resolveCallSite`. The default stack limit (10) is used up by driver frames before
 * the caller is reached, so it is raised for the capture only.
 */
export function captureCallSite(): CallSite {
  const site: CallSite = {};
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_LIMIT;
  Error.captureStackTrace(site, captureCallSite);
  Error.stackTraceLimit = previous;
  const field = fieldStorage.getStore();
  if (field !== undefined) site.field = field;
  return site;
}

/** Application frames reported per call site: the query's own frame plus its nearest callers. */
const CHAIN_DEPTH = 3;

/**
 * Nearest application frames of a captured stack, innermost first, one per file hop, joined as `a ← b ← c`
 * (memoised). Within a run of frames in one file the innermost line is kept: the call into the previous hop.
 *
 * One frame is not enough: an app with a data layer (a repository, or NodeBB's `db.getObject`) issues every query from
 * the same wrapper line, so the nearest frame names the wrapper and never the loop that calls it. On NodeBB that was
 * all six patterns. The chain names the loop, and because findings are grouped by call site, two loops over one
 * wrapper become two patterns instead of one.
 *
 * Callers that `return promise` without awaiting drop out of V8's async stack; the chain then continues at the
 * nearest awaiting caller. When no application frame is left at all (a GraphQL resolver returning the query promise),
 * the call site is the resolver, `resolver Order.user`, if the Apollo plugin recorded one.
 */
export function resolveCallSite(site: CallSite | undefined, cwd: string = process.cwd()): string | undefined {
  if (site === undefined) return undefined;
  if (site.resolved !== undefined) return site.resolved ?? undefined;
  const chain: string[] = [];
  let lastFile: string | undefined;
  for (const line of (site.stack ?? '').split('\n').slice(1)) {
    const loc = locationOf(line);
    if (!loc || isInternal(loc)) continue;
    // A hop is a change of file: helpers calling helpers inside one module would otherwise use up the whole chain
    // (NodeBB: sorted.js:86 ← sorted.js:108 ← sorted.js:18) before it reaches the caller.
    const file = loc.slice(0, loc.lastIndexOf(':'));
    if (file === lastFile) continue;
    lastFile = file;
    chain.push(loc.startsWith(cwd) ? relative(cwd, loc) : loc);
    if (chain.length === CHAIN_DEPTH) break;
  }
  site.resolved = chain.length > 0 ? chain.join(' ← ') : site.field !== undefined ? `resolver ${site.field}` : null;
  return site.resolved ?? undefined;
}
