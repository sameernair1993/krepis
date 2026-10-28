import { AsyncLocalStorage } from 'node:async_hooks';
import type { Optimizer } from './optimize.ts';
import type { CommandRecord } from './types.ts';

/**
 * Request input of a unit of work (a parsed body, query string, route parameters, GraphQL variables), read lazily
 * because bodies are parsed after the unit begins. KR-S001 compares operator objects in filters against it, in memory.
 */
export interface InputSource {
  source: string;
  read: () => unknown;
  /** Last value read, and the operator objects found in it. */
  seen?: unknown;
  ops?: Record<string, unknown>[];
}

/**
 * One unit of work (an HTTP request, a GraphQL operation, a job) whose commands are analysed
 * together. N+1 is only visible at this grain: each child query is individually perfect.
 */
export interface WorkContext {
  id: number;
  label: string;
  commands: CommandRecord[];
  retainedDocs: number;
  /** Call-site stacks captured per fingerprint in this context (a few per shape, not one per iteration). */
  sitesCaptured: Map<string, number>;
  /** Request-scoped optimisations, when enabled for this context. */
  optimizer: Optimizer | undefined;
  /** The observer that created this context; only it records into it (several may watch one client). */
  owner: object | undefined;
  /** `performance.now()` when the unit of work began. */
  startedAt: number;
  ended: boolean;
  /**
   * The context that was current when this one began. Once this one ends, code still running in it (a continuation
   * an `enterWith` reached, a fire-and-forget query) is attributed to the parent instead of being lost.
   */
  parent: WorkContext | undefined;
  /** Measurements running when this unit began (`Observer.measure`); its commands are handed to each when it ends. */
  measurements?: ReadonlyArray<{ collect(commands: readonly CommandRecord[]): void }>;
  /** Request input, when an integration recorded it and the hazard rules are on. Dropped when the unit ends. */
  inputs?: InputSource[];
}

export const contextStorage = new AsyncLocalStorage<WorkContext>();

/**
 * The GraphQL field whose resolver is running (`Order.user`), set by the Apollo plugin per field. A separate store
 * from `contextStorage`, because many fields resolve concurrently inside one unit of work. Read only as the call-site
 * fallback when a stack has no application frame.
 */
export const fieldStorage = new AsyncLocalStorage<string>();

let nextId = 1;

export function createContext(label: string, owner?: object, parent: WorkContext | undefined = currentContext()): WorkContext {
  return { id: nextId++, label, commands: [], retainedDocs: 0, sitesCaptured: new Map(), optimizer: undefined, owner, startedAt: performance.now(), ended: false, parent };
}

export function currentContext(): WorkContext | undefined {
  let ctx = contextStorage.getStore();
  while (ctx?.ended) ctx = ctx.parent;
  return ctx;
}
