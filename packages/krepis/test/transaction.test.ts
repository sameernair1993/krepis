import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient, type CommandStartedEvent } from 'mongodb';
import mongoose from 'mongoose';
import {
  createDal,
  fromMongoose,
  op,
  schema,
  t,
  TransactionEndedError,
  TransactionTimeoutError,
  TransactionsUnsupportedError,
  type Transaction,
} from '../src/dal/index.ts';
import { URI } from './helpers.ts';

const DB = 'krepis_tx_test';
const client = new MongoClient(URI, { monitorCommands: true });
const db = () => client.db(DB);

let commands: CommandStartedEvent[] = [];
client.on('commandStarted', (e) => {
  if (e.databaseName === DB || e.commandName === 'commitTransaction' || e.commandName === 'abortTransaction') commands.push(e);
});

const dal = createDal(client, { dbName: DB });
const Items = dal.collection('items', schema({ name: t.string() }));
const Counters = dal.collection('counters', schema({ name: t.string(), n: t.number() }));
const Users = dal.collection('users', schema({ name: t.string() }));
const Posts = dal.collection('posts', schema({ title: t.string(), authorId: t.objectId() }));

async function failPoint(data: Record<string, unknown>, times = 1) {
  await client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times }, data });
}

before(() => client.connect());
after(() => client.close());
beforeEach(async () => {
  await db().dropDatabase();
  // Collections must exist before a transaction on servers before 4.4; creating them keeps timing comparable.
  for (const c of ['items', 'counters', 'users', 'posts']) await db().createCollection(c);
  commands = [];
});
afterEach(() => client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' }));

const names = async () => (await Items.find().all()).map((d) => d.name).sort();

test('T2: operations join the transaction without a session argument; abort discards, commit publishes', async () => {
  await assert.rejects(
    dal.transaction(async () => {
      await Items.insertOne({ name: 'a' });
      await Items.updateOne({ name: 'a' }, { name: 'b' });
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(await names(), []);

  let seenOutside: string[] | undefined;
  const result = await dal.transaction(async () => {
    await Items.insertMany([{ name: 'x' }, { name: 'y' }]);
    seenOutside = (await db().collection('items').find().toArray()).map((d) => d.name as string);
    const inside = await Items.find().all();
    return inside.length;
  });
  assert.equal(result, 2, 'reads inside see the transaction’s writes');
  assert.deepEqual(seenOutside, [], 'a read outside the transaction sees nothing before commit');
  assert.deepEqual(await names(), ['x', 'y']);
  const lsids = new Set(commands.filter((c) => c.commandName === 'insert' || c.commandName === 'find').map((c) => JSON.stringify(c.command.lsid)));
  assert.ok(commands.filter((c) => c.commandName === 'insert').every((c) => c.command.txnNumber !== undefined));
  assert.ok(lsids.size >= 1);
});

test('T3: a transient error re-runs the callback; only the successful attempt’s afterCommit hooks run', async () => {
  await failPoint({ failCommands: ['insert'], errorCode: 112, errorLabels: ['TransientTransactionError'] });
  const attempts: number[] = [];
  const hooks: number[] = [];
  const result = await dal.transaction(async (tx) => {
    attempts.push(tx.attempt);
    tx.afterCommit(() => hooks.push(tx.attempt));
    await Items.insertOne({ name: `try${tx.attempt}` });
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(hooks, [2]);
  assert.deepEqual(await names(), ['try2']);
});

test('T4: an unknown commit result is retried without re-running the callback', async () => {
  await failPoint({ failCommands: ['commitTransaction'], errorCode: 91, closeConnection: false }, 2);
  let runs = 0;
  await dal.transaction(async () => {
    runs++;
    await Items.insertOne({ name: 'once' });
  });
  assert.equal(runs, 1);
  assert.deepEqual(await names(), ['once']);
  assert.ok(commands.filter((c) => c.commandName === 'commitTransaction').length >= 3);
});

test('T5: concurrent transactions on one document lose no update', async () => {
  await Counters.insertOne({ name: 'c', n: 0 });
  let held!: () => void;
  const hold = new Promise<void>((r) => (held = r));
  let entered!: () => void;
  const inFirst = new Promise<void>((r) => (entered = r));
  const runs = { a: 0, b: 0 };
  const a = dal.transaction(async () => {
    runs.a++;
    await Counters.updateOne({ name: 'c' }, { $inc: { n: 1 } });
    entered();
    await hold;
  });
  await inFirst;
  const b = dal.transaction(async () => {
    runs.b++;
    await Counters.updateOne({ name: 'c' }, { $inc: { n: 1 } });
  });
  await sleep(100);
  held();
  await Promise.all([a, b]);
  assert.equal((await Counters.findOne({ name: 'c' }))?.n, 2);
  assert.equal(runs.a, 1);
  assert.ok(runs.b >= 2, `b ran ${runs.b} times`);
});

test('T6: an operation that runs after its transaction ended is refused and writes nothing', async () => {
  let late: Promise<unknown> | undefined;
  await dal.transaction(async () => {
    await Items.insertOne({ name: 'in' });
    late = sleep(50).then(() => Items.insertOne({ name: 'late' }));
  });
  await assert.rejects(late!, (e: unknown) => {
    assert.ok(e instanceof TransactionEndedError);
    assert.match((e as Error).message, /items/);
    assert.match((e as Error).message, /insertOne/);
    return true;
  });
  assert.deepEqual(await names(), ['in']);
});

test('T7: a nested transaction joins the outer one', async () => {
  const hooks: string[] = [];
  await assert.rejects(
    dal.transaction(async () => {
      await dal.transaction(async (inner) => {
        await Items.insertOne({ name: 'inner' });
        inner.afterCommit(() => hooks.push('inner'));
      });
      throw new Error('outer fails');
    }),
    /outer fails/,
  );
  assert.deepEqual(await names(), []);
  assert.equal(hooks.length, 0);

  await dal.transaction(async (outer) => {
    await dal.transaction(async (inner) => {
      assert.equal(inner, outer);
      await Items.insertOne({ name: 'inner' });
      inner.afterCommit(() => hooks.push('inner'));
    });
    hooks.push('outer body done');
  });
  assert.deepEqual(hooks, ['outer body done', 'inner']);
});

test('T8: a Mongoose write given tx.session rolls back with the Krepis transaction', async () => {
  const m = new mongoose.Mongoose();
  await m.connect(URI, { dbName: DB });
  try {
    const shared = fromMongoose(m as never);
    const Notes = shared.collection('notes', schema({ text: t.string() }));
    const Log = m.model('Log', new m.Schema({ msg: String }), 'logs');
    await Log.createCollection();
    await Notes.raw().insertOne({ text: 'seed' } as never);
    await assert.rejects(
      shared.transaction(async (tx) => {
        await Notes.insertOne({ text: 'krepis' });
        // The cast bridges two copies of the driver's types (mongoose pins its own); the session is the same object.
        await new Log({ msg: 'mongoose' }).save({ session: tx.session as never });
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(await Notes.count(), 1);
    assert.equal(await Log.countDocuments(), 0);
  } finally {
    await m.disconnect();
  }
});

test('T9: a standalone server reports that transactions need a replica set', { skip: !process.env.KREPIS_TEST_STANDALONE_URI }, async () => {
  const solo = new MongoClient(process.env.KREPIS_TEST_STANDALONE_URI!);
  await solo.connect();
  try {
    const S = createDal(solo, { dbName: DB }).collection('items', schema({ name: t.string() }));
    await assert.rejects(
      createDal(solo, { dbName: DB }).transaction(() => S.insertOne({ name: 'x' })),
      (e: unknown) => {
        assert.ok(e instanceof TransactionsUnsupportedError);
        assert.match((e as Error).message, /replica set/);
        assert.ok((e as Error).cause);
        return true;
      },
    );
  } finally {
    await solo.close();
  }
});

test('T10: three writes cost three write commands and one commit, nothing else', async () => {
  commands = [];
  await dal.transaction(async () => {
    await Items.insertOne({ name: 'a' });
    await Items.updateOne({ name: 'a' }, { name: 'b' });
    await Items.deleteOne({ name: 'b' });
  });
  assert.deepEqual(
    commands.map((c) => c.commandName),
    ['insert', 'update', 'delete', 'commitTransaction'],
  );
});

test('T11: an operation past the deadline throws, and the transaction aborts even if the callback swallows it', async () => {
  let runs = 0;
  await assert.rejects(
    dal.transaction(
      async () => {
        runs++;
        await Items.insertOne({ name: 'early' });
        await sleep(300);
        await Items.insertOne({ name: 'late' });
      },
      { timeoutMs: 200 },
    ),
    TransactionTimeoutError,
  );
  assert.equal(runs, 1);
  assert.deepEqual(await names(), []);

  await assert.rejects(
    dal.transaction(
      async () => {
        await Items.insertOne({ name: 'early' });
        await sleep(300);
        await Items.insertOne({ name: 'late' }).catch(() => {});
        return 'pretend success';
      },
      { timeoutMs: 200 },
    ),
    TransactionTimeoutError,
  );
  assert.deepEqual(await names(), []);
});

test('T12: parallel operations at the start of a transaction succeed (20 trials), and include() works inside', async () => {
  for (let i = 0; i < 20; i++) {
    await dal.transaction(async () => {
      await Promise.all(Array.from({ length: 10 }, (_, j) => Items.insertOne({ name: `${i}-${j}` })));
    });
  }
  assert.equal(await Items.count(), 200);

  const [u1, u2] = await Users.insertMany([{ name: 'ann' }, { name: 'bob' }]);
  for (let i = 0; i < 20; i++) {
    const { posts, authors } = await dal.transaction(async () => {
      await Posts.insertMany([{ title: `p${i}a`, authorId: u1!._id }, { title: `p${i}b`, authorId: u2!._id }]);
      return {
        posts: await Posts.find({ title: op.in([`p${i}a`, `p${i}b`]) })
          .sort({ title: 1 })
          .include({ author: { from: Users, local: 'authorId' } })
          .all(),
        authors: await Users.find({ _id: op.in([u1!._id, u2!._id]) })
          .sort({ name: 1 })
          .include({ posts: { from: Posts, foreign: 'authorId', all: true } })
          .all(),
      };
    });
    assert.deepEqual(posts.map((r) => r.author?.name), ['ann', 'bob']);
    assert.equal(authors[0]!.posts.length, i + 1, 'the include sees writes made earlier in the same transaction');
  }
});

test('afterCommit: hooks run outside the transaction, in order, and a failing hook does not fail the commit', async () => {
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);
  process.on('warning', onWarning);
  try {
    const order: string[] = [];
    const out = await dal.transaction(async (tx) => {
      await Items.insertOne({ name: 'a' });
      tx.afterCommit(async () => {
        order.push('first');
        await Items.insertOne({ name: 'from-hook' });
      });
      tx.afterCommit(() => {
        throw new Error('hook broke');
      });
      tx.afterCommit(() => order.push('third'));
      return 1;
    });
    await sleep(0);
    assert.equal(out, 1);
    assert.deepEqual(order, ['first', 'third']);
    assert.deepEqual(await names(), ['a', 'from-hook']);
    assert.ok(warnings.some((w) => /hook broke/.test(String((w as Error & { cause?: Error }).cause?.message ?? w.message))));
  } finally {
    process.off('warning', onWarning);
  }
});

test('a collection on another client cannot join, and is refused rather than run outside', async () => {
  const other = new MongoClient(URI);
  await other.connect();
  try {
    const Elsewhere = createDal(other, { dbName: DB }).collection('items', schema({ name: t.string() }));
    await assert.rejects(
      dal.transaction(async () => {
        await Elsewhere.insertOne({ name: 'escaped' });
      }),
      /different MongoClient/,
    );
    assert.deepEqual(await names(), []);
  } finally {
    await other.close();
  }
});

function typeChecks(tx: Transaction) {
  const n: Promise<number> = dal.transaction(async () => 1);
  // @ts-expect-error the result type flows from the callback
  const s: Promise<string> = dal.transaction(async () => 1);
  tx.afterCommit(() => undefined);
  // @ts-expect-error afterCommit takes a function
  tx.afterCommit('nope');
  void n;
  void s;
}
void typeChecks;
