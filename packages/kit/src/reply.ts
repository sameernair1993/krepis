import type { CommandRecord } from './types.ts';

/**
 * Reading a command's reply without decoding it. mongodb 6.x and later resolve `Connection.command` with
 * a lazy response for cursor commands: the batch length and cursor id are read from the raw bytes, and documents are
 * decoded only when a rule or `optimize` asks for them. Older drivers and other commands resolve with a plain object.
 */

export interface ReplyFacts {
  /** Documents in the batch, if the reply has one. */
  batch: number | undefined;
  /** Id of a cursor the reply left open. */
  openCursor: string | undefined;
  /** `n` of a write or count. */
  n: number | undefined;
  /** The first `count` documents of the batch, decoded. */
  docs: (count: number) => unknown[];
}

interface LazyBatch { size(): number; get(i: number, as: number, required: true): { toObject(): unknown } }
interface LazyReply { batch: LazyBatch; id: { toString(): string }; getNumber(name: string): number | null }
interface PlainReply { n?: unknown; cursor?: { firstBatch?: unknown[]; nextBatch?: unknown[]; id?: unknown } }

const BSON_OBJECT = 3;
const NONE: ReplyFacts = { batch: undefined, openCursor: undefined, n: undefined, docs: () => [] };

export function readReply(res: unknown): ReplyFacts {
  if (typeof res !== 'object' || res === null) return NONE;
  if (typeof (res as Partial<LazyReply>).getNumber !== 'function') return readPlain(res as PlainReply);
  const lazy = res as LazyReply;
  let batch: LazyBatch | undefined;
  try {
    batch = lazy.batch; // throws when the reply has no cursor (writes, explain)
  } catch {
    batch = undefined;
  }
  if (!batch) return { ...NONE, n: lazy.getNumber('n') ?? undefined };
  const id = String(lazy.id);
  return {
    batch: batch.size(),
    openCursor: id === '0' ? undefined : id,
    n: undefined,
    docs: (count) => {
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) out.push(batch.get(i, BSON_OBJECT, true).toObject());
      return out;
    },
  };
}

function readPlain(reply: PlainReply): ReplyFacts {
  const batch = reply.cursor?.firstBatch ?? reply.cursor?.nextBatch;
  const id = reply.cursor?.id;
  return {
    batch: batch?.length,
    openCursor: id !== undefined && String(id) !== '0' ? String(id) : undefined,
    n: typeof reply.n === 'number' ? reply.n : undefined,
    docs: (count) => (batch ?? []).slice(0, count),
  };
}

/** A command's retained documents, decoding the ones not decoded yet. */
export function docsOf(record: CommandRecord): unknown[] | undefined {
  if (record.lazyDocs) {
    const decoded = record.lazyDocs.flatMap((l) => l.read());
    record.lazyDocs = undefined;
    record.docs = record.docs ? record.docs.concat(decoded) : decoded;
  }
  return record.docs;
}
