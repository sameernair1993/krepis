import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { MongoClient } from 'mongodb';
import { currentContext } from './context.ts';

/**
 * Context-gated command monitoring.
 *
 * With `monitorCommands` on, the driver builds every CommandSucceededEvent eagerly, and for cursor replies that
 * means a second full deserialization of the reply (mongodb 7.x `cmap/connection.js`, `sendCommand`). Krepis only
 * analyses commands that run inside a context, so paying that for every command is waste. Each connection reads
 * its own `monitorCommands` field per command, so instead of switching it on client-wide we switch it on for one
 * command at a time, only when that command runs inside a Krepis context. Connections are used exclusively while
 * checked out, so the flag cannot leak onto another command.
 *
 * On promise-style drivers the flag is not used at all: the command goes to the observer that owns the
 * context, which records it from the command and the reply `Connection.command` resolves with, so the driver builds
 * no event and decodes no reply for Krepis.
 */

const PATCHED = Symbol.for('krepis.gatedCommand');

/** How the driver copy is gated: `promise` records directly, `callback` toggles monitoring per command. */
export type GateMode = 'promise' | 'callback';

interface ConnectionLike { monitorCommands: boolean }
/** Promise-returning in mongodb 5+; callback-taking and returning undefined in 4.x. */
type CommandFn = (this: ConnectionLike, ...args: unknown[]) => unknown;
interface ConnectionPrototype { command: CommandFn; [PATCHED]?: GateMode }
/** An observer that records commands itself, from their replies. */
interface Recorder { record?: (args: unknown[], run: () => Promise<unknown>) => Promise<unknown> }

const cjsRequire = createRequire(import.meta.url);

/**
 * Finds the `Connection` class of the driver copy this client was built from. Applications can load several copies
 * (Mongoose bundles its own), so the copy is identified by `instanceof`, via the CommonJS module cache: whatever
 * layout the package manager used, a constructed client's driver is already loaded there. Returns undefined when
 * the driver was bundled (no cache entry) or its layout is unknown; the caller falls back to client-wide monitoring.
 */
function findConnectionPrototype(client: MongoClient): ConnectionPrototype | undefined {
  const suffix = /[\\/]mongodb[\\/]lib[\\/]mongo_client\.js$/;
  for (const [file, mod] of Object.entries(cjsRequire.cache)) {
    if (!suffix.test(file)) continue;
    const MongoClientClass = (mod?.exports as { MongoClient?: new (...args: never[]) => unknown } | undefined)?.MongoClient;
    if (!MongoClientClass || !(client instanceof MongoClientClass)) continue;
    try {
      const connectionFile = join(dirname(file), 'cmap', 'connection.js');
      const { Connection } = cjsRequire(connectionFile) as { Connection?: { prototype: ConnectionPrototype } };
      if (typeof Connection?.prototype?.command === 'function') return Connection.prototype;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Installs the gate on the client's driver copy. Returns false if it could not, so the caller can fall back. */
export function gateMonitoring(client: MongoClient): GateMode | false {
  const proto = findConnectionPrototype(client);
  if (!proto) return false;
  if (proto[PATCHED]) return proto[PATCHED];
  const original = proto.command;
  // mongodb 7 declares `async command(ns, cmd, options, responseType)`, and responseType is a class, i.e. a function.
  const promiseStyle = original.constructor?.name === 'AsyncFunction';
  proto.command = function gatedCommand(this: ConnectionLike, ...args: unknown[]) {
    // Fast path: outside a context the driver runs untouched.
    const ctx = currentContext();
    if (ctx === undefined) return original.apply(this, args);
    if (!promiseStyle) {
      const callback = args[args.length - 1];
      // No callback on a callback-style driver is not a shape Krepis knows: leave it entirely alone.
      if (!isCallback(callback)) return original.apply(this, args);
      return callbackCommand(this, args, callback, original, ctx.optimizer);
    }
    const record = (ctx.owner as Recorder | undefined)?.record;
    const conn = this;
    // Commands the optimizer sends itself (prefetches, checks) are recorded the same way.
    const recorded = record
      ? function recordedCommand(this: ConnectionLike, ...a: unknown[]) {
        return record(a, () => original.apply(this, a) as Promise<unknown>);
      }
      : original;
    return ctx.optimizer
      ? ctx.optimizer.handle(conn, args, recorded as (...a: unknown[]) => Promise<unknown>)
      : recorded.apply(conn, args);
  };
  proto[PATCHED] = promiseStyle ? 'promise' : 'callback';
  return proto[PATCHED];
}

let warnedCallbackOptimize = false;

/**
 * Callback-style drivers (mongodb 4.x, 5.x and early 6.x: `command(ns, cmd, options, callback)`, returning undefined). The flag is
 * cleared when the driver calls back, which is when the connection's command is over. Optimization is not applied:
 * the optimizer is promise-based, and in this shape the last argument is the callback, not a reply type. The command
 * is still shown to it, so a write here still invalidates reads it has cached from a promise-based driver copy.
 */
function callbackCommand(
  conn: ConnectionLike, args: unknown[], callback: (...a: unknown[]) => unknown, original: CommandFn,
  optimizer: { observeUnmanaged(ns: unknown, cmd: unknown): void } | undefined,
): unknown {
  if (optimizer) {
    optimizer.observeUnmanaged(args[0], args[1]);
    if (!warnedCallbackOptimize) {
      warnedCallbackOptimize = true;
      process.emitWarning('krepis: optimize/autoBatch is not applied to callback-style drivers (mongodb 4.x, 5.x and 6.0); commands pass through unchanged.', { code: 'KREPIS_OPTIMIZE_CALLBACK_DRIVER' });
    }
  }
  if (conn.monitorCommands) return original.apply(conn, args);
  conn.monitorCommands = true;
  let pending = true;
  const done = () => {
    if (!pending) return;
    pending = false;
    conn.monitorCommands = false;
  };
  const wrapped = [...args.slice(0, -1), function gatedCallback(this: unknown, ...res: unknown[]) {
    done();
    return callback.apply(this, res);
  }];
  try {
    return original.apply(conn, wrapped);
  } catch (err) {
    done();
    throw err;
  }
}

function isCallback(value: unknown): value is (...a: unknown[]) => unknown {
  return typeof value === 'function' && !/^class[\s{]/.test(Function.prototype.toString.call(value));
}
