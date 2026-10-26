import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId, type CommandStartedEvent } from 'mongodb';
import mongoose from 'mongoose';
import {
  createDal,
  schema,
  t,
  KrepisUnboundedReadError,
  type Doc,
  type ScopeContext,
} from '../src/dal/index.ts';
import { URI } from './helpers.ts';

const DB = 'krepis_include_test';
const client = new MongoClient(URI, { monitorCommands: true });
const db = () => client.db(DB);

let reads: CommandStartedEvent[] = [];
client.on('commandStarted', (e) => {
  if (e.databaseName === DB && (e.commandName === 'find' || e.commandName === 'aggregate')) reads.push(e);
});

const orgs = schema({ name: t.string() });
const users = schema({
  name: t.string(),
  email: t.string().optional(),
  orgId: t.objectId().optional(),
  tenantId: t.string().optional(),
});
const posts = schema({
  title: t.string(),
  authorId: t.objectId(),
  editorId: t.objectId().optional(),
  tagIds: t.array(t.objectId()).default(() => []),
});
const tags = schema({ label: t.string() });
const comments = schema({ postId: t.objectId(), body: t.string(), n: t.number() });

let tenant: string | undefined;
const tenantScope = (): ScopeContext | undefined =>
  tenant === undefined ? undefined : { filter: { tenantId: tenant } };

const dal = createDal(client, { dbName: DB });
const Orgs = dal.collection('orgs', orgs);
const Users = dal.collection('users', users, { scope: tenantScope });
const Posts = dal.collection('posts', posts);
const Tags = dal.collection('tags', tags);
const Comments = dal.collection('comments', comments);

before(() => client.connect());
after(() => client.close());
beforeEach(async () => {
  tenant = undefined;
  await db().dropDatabase();
  reads = [];
});

async function seed(nPosts = 10) {
  const [acme, globex] = await Orgs.insertMany([{ name: 'Acme' }, { name: 'Globex' }]);
  const [ann, bob] = await Users.insertMany([
    { name: 'Ann', email: 'ann@x', orgId: acme._id, tenantId: 'a' },
    { name: 'Bob', email: 'bob@x', orgId: globex._id, tenantId: 'b' },
  ]);
  const [red, blue] = await Tags.insertMany([{ label: 'red' }, { label: 'blue' }]);
  const list = await Posts.insertMany(
    Array.from({ length: nPosts }, (_, i) => ({
      title: `p${i}`,
      authorId: i % 2 ? bob._id : ann._id,
      tagIds: [blue._id, red._id, blue._id],
    })),
  );
  reads = [];
  return { acme, globex, ann, bob, red, blue, posts: list };
}

// ---------------------------------------------------------------------------
// Forward relations
// ---------------------------------------------------------------------------

test('forward: attaches the referenced document under a new name', async () => {
  const { ann, bob } = await seed(4);
  const rows = await Posts.find().sort({ title: 1 }).limit(4).include({ author: { from: Users, local: 'authorId' } }).toArray();
  const author: Doc<typeof users> | null = rows[0].author;
  assert.equal(author?.name, 'Ann');
  assert.deepEqual(rows.map((r) => r.author?._id.toHexString()), [ann, bob, ann, bob].map((u) => u._id.toHexString()));
  assert.ok(rows[0].authorId instanceof ObjectId, 'the local field is kept');
});

test('forward: a missing or null local value yields null and no read when nothing to load', async () => {
  await seed(3);
  const rows = await Posts.find().limit(3).include({ editor: { from: Users, local: 'editorId' } }).toArray();
  assert.deepEqual(rows.map((r) => r.editor), [null, null, null]);
  assert.equal(reads.length, 1, 'only the parent read');
});

test('forward: an array keeps order, repeats duplicates and drops missing ids', async () => {
  const { blue, red } = await seed(1);
  const ghost = new ObjectId();
  await Posts.updateMany({}, { $set: { tagIds: [blue._id, ghost, red._id, blue._id] } });
  const [row] = await Posts.find().limit(1).include({ tags: { from: Tags, local: 'tagIds' } }).toArray();
  const list: Doc<typeof tags>[] = row.tags;
  assert.deepEqual(list.map((x) => x.label), ['blue', 'red', 'blue']);
});

test('forward: in place, replacing the id with the document', async () => {
  await seed(2);
  const rows = await Posts.find().sort({ title: 1 }).limit(2).include({ authorId: { from: Users, local: 'authorId' } }).toArray();
  assert.equal(rows[0].authorId?.name, 'Ann');
});

test('forward: ids stored as strings are cast by the target schema and still match', async () => {
  const { ann } = await seed(0);
  await Posts.raw().insertOne({ _id: new ObjectId(), title: 's', authorId: ann._id.toHexString() as never, tagIds: [] });
  const [row] = await Posts.find().limit(1).include({ author: { from: Users, local: 'authorId' } }).toArray();
  assert.equal(row.author?.name, 'Ann');
});

test('forward: select and where apply to the included read', async () => {
  await seed(2);
  const rows = await Posts.find()
    .sort({ title: 1 })
    .limit(2)
    .include({ author: { from: Users, local: 'authorId', select: { name: 1 }, where: { name: 'Ann' } } }).toArray();
  assert.deepEqual(Object.keys(rows[0].author ?? {}).sort(), ['_id', 'name']);
  assert.equal(rows[1].author, null, 'Bob is filtered out by where');
});

test('forward: a parent projection that omits the local field still resolves the relation', async () => {
  await seed(2);
  const rows = await Posts.find().select({ title: 1 }).sort({ title: 1 }).limit(2).include({ author: { from: Users, local: 'authorId' } }).toArray();
  assert.equal(rows[0].author?.name, 'Ann');
});

test('forward: ids are deduplicated across parents', async () => {
  await seed(1000);
  await Posts.find().limit(1000).include({ author: { from: Users, local: 'authorId' }, tags: { from: Tags, local: 'tagIds' } }).toArray();
  const user = reads.find((r) => r.command.find === 'users');
  const tag = reads.find((r) => r.command.find === 'tags');
  assert.equal((user?.command.filter._id.$in as unknown[]).length, 2);
  assert.equal((tag?.command.filter._id.$in as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// Round trips (I1, I2)
// ---------------------------------------------------------------------------

for (const n of [1, 10, 100, 1000]) {
  test(`round trips: 1 + K at N=${n}`, async () => {
    await seed(n);
    const rows = await Posts.find()
      .limit(n)
      .include({ author: { from: Users, local: 'authorId' }, tags: { from: Tags, local: 'tagIds' } }).toArray();
    assert.equal(rows.length, n);
    assert.equal(reads.length, 3);
  });
}

for (const n of [10, 1000]) {
  test(`round trips: depth-2 nesting costs 1 + relations at N=${n}`, async () => {
    await seed(n);
    const rows = await Posts.find()
      .limit(n)
      .include({
        author: { from: Users, local: 'authorId', include: { org: { from: Orgs, local: 'orgId' } } },
        tags: { from: Tags, local: 'tagIds' },
      }).toArray();
    const org: Doc<typeof orgs> | null | undefined = rows[0].author?.org;
    assert.equal(org?.name, 'Acme');
    assert.equal(rows[1].author?.org?.name, 'Globex');
    assert.equal(reads.length, 4);
  });
}

test('select: fields a relation needs are read, used, and removed again', async () => {
  await seed(4);
  const users = await Users.find()
    .sort({ name: 1 })
    .limit(2)
    .include({ posts: { from: Posts, foreign: 'authorId', select: { title: 1 }, all: true } })
    .toArray();
  assert.equal(users[0].posts.length, 2, 'matched on authorId although select left it out');
  assert.deepEqual(Object.keys(users[0].posts[0]).sort(), ['_id', 'title']);

  const rows = await Posts.find()
    .sort({ title: 1 })
    .limit(2)
    .include({ author: { from: Users, local: 'authorId', select: { name: 1 }, include: { org: { from: Orgs, local: 'orgId' } } } })
    .toArray();
  assert.equal(rows[0].author?.org?.name, 'Acme', 'nested local read although select left it out');
  assert.deepEqual(Object.keys(rows[0].author ?? {}).sort(), ['_id', 'name', 'org']);
});

// ---------------------------------------------------------------------------
// Reverse relations (I6, I7)
// ---------------------------------------------------------------------------

test('reverse: attaches every match as an array', async () => {
  const { ann } = await seed(5);
  const rows = await Users.find().sort({ name: 1 }).limit(2).include({ posts: { from: Posts, foreign: 'authorId', all: true } }).toArray();
  const list: Doc<typeof posts>[] = rows[0].posts;
  assert.equal(list.length, 3);
  assert.ok(list.every((p) => p.authorId.equals(ann._id)));
  assert.equal(rows[1].posts.length, 2);
});

test('reverse: unbounded under the error policy throws before any child read (I6)', async () => {
  await seed(2);
  await assert.rejects(
    Users.find().limit(2).include({ posts: { from: Posts, foreign: 'authorId' } }).toArray(),
    (e: unknown) => e instanceof KrepisUnboundedReadError,
  );
  assert.equal(reads.filter((r) => r.command.find === 'posts' || r.command.aggregate === 'posts').length, 0);
});

test('reverse: a per-parent limit follows sort and equals separate reads (I7)', async () => {
  const { posts: list } = await seed(4);
  await Comments.insertMany(
    list.flatMap((p, i) => Array.from({ length: 3 + i }, (_, n) => ({ postId: p._id, body: `c${n}`, n: (n * 7) % 5 }))),
  );
  const rows = await Posts.find()
    .sort({ title: 1 })
    .limit(4)
    .include({ comments: { from: Comments, foreign: 'postId', sort: { n: -1, body: 1 }, limit: 2 } }).toArray();
  for (const row of rows) {
    const expected = await Comments.find({ postId: row._id }).sort({ n: -1, body: 1 }).limit(2).toArray();
    assert.deepEqual(row.comments, expected);
  }
});

// ---------------------------------------------------------------------------
// Scope, guards (I5)
// ---------------------------------------------------------------------------

test('scope: the target collection scope applies to included reads (I5)', async () => {
  await seed(2);
  tenant = 'a';
  const rows = await Posts.find().sort({ title: 1 }).limit(2).include({ author: { from: Users, local: 'authorId' } }).toArray();
  assert.equal(rows[0].author?.name, 'Ann');
  assert.equal(rows[1].author, null, "tenant a cannot load tenant b's user");
});

test('guards: cursor() refuses includes, and a relation needs local or foreign', async () => {
  await seed(1);
  assert.throws(() => Posts.find().limit(1).include({ author: { from: Users, local: 'authorId' } }).cursor(), /include/);
  await assert.rejects(
    Posts.find().limit(1).include({ author: { from: Users } as never }).toArray(),
    /local or foreign/,
  );
  await assert.rejects(
    Posts.find().limit(1).include({ author: { from: Users, local: 'authorId', limit: 1 } }).toArray(),
    /many relations/,
  );
});

// ---------------------------------------------------------------------------
// Parity with Mongoose populate (I3)
// ---------------------------------------------------------------------------

test('parity: matches Mongoose 9 populate().lean() on six shapes (I3)', async () => {
  const { ann, blue, red } = await seed(0);
  const ghost = new ObjectId();
  await Posts.raw().insertMany([
    { _id: new ObjectId(), title: 'single', authorId: ann._id, tagIds: [] },
    { _id: new ObjectId(), title: 'null', authorId: ann._id, editorId: null as never, tagIds: [] },
    { _id: new ObjectId(), title: 'missing', authorId: ann._id, tagIds: [] },
    { _id: new ObjectId(), title: 'dups', authorId: ann._id, tagIds: [blue._id, red._id, blue._id] },
    { _id: new ObjectId(), title: 'ghost', authorId: ann._id, tagIds: [ghost, red._id] },
    { _id: new ObjectId(), title: 'inplace', authorId: ann._id, editorId: ann._id, tagIds: [red._id] },
  ]);
  const conn = await mongoose.createConnection(URI, { dbName: DB }).asPromise();
  try {
    const S = mongoose.Schema;
    conn.model('User', new S({ name: String, email: String, orgId: S.Types.ObjectId, tenantId: String }), 'users');
    conn.model('Tag', new S({ label: String }), 'tags');
    const MPost = conn.model(
      'Post',
      new S({
        title: String,
        authorId: { type: S.Types.ObjectId, ref: 'User' },
        editorId: { type: S.Types.ObjectId, ref: 'User' },
        tagIds: [{ type: S.Types.ObjectId, ref: 'Tag' }],
      }),
      'posts',
    );
    const theirs = await MPost.find().sort({ title: 1 }).populate('authorId').populate('editorId').populate('tagIds').lean();
    const ours = await Posts.find()
      .sort({ title: 1 })
      .limit(100)
      .include({
        authorId: { from: Users, local: 'authorId' },
        editorId: { from: Users, local: 'editorId' },
        tagIds: { from: Tags, local: 'tagIds' },
      }).toArray();
    const norm = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (x === undefined ? '__undefined' : x)));
    const strip = (d: Record<string, unknown>) => {
      const { __v: _v, ...rest } = d;
      return rest;
    };
    assert.equal(ours.length, 6);
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(norm(ours[i]), norm(strip(theirs[i] as never)), `shape ${String(ours[i].title)}`);
    }
  } finally {
    await conn.close();
  }
});

// ---------------------------------------------------------------------------
// Types (I8): compiled by `tsc --noEmit`, never executed
// ---------------------------------------------------------------------------

export function typeChecks(): void {
  // @ts-expect-error unknown local field
  void Posts.find().include({ a: { from: Users, local: 'nope' } });
  // @ts-expect-error unknown foreign field
  void Users.find().include({ p: { from: Posts, foreign: 'nope', all: true } });
  // @ts-expect-error unknown nested local field
  void Posts.find().include({ a: { from: Users, local: 'authorId', include: { o: { from: Orgs, local: 'nope' } } } });
  // @ts-expect-error unknown where field
  void Posts.find().include({ a: { from: Users, local: 'authorId', where: { nope: 1 } } });

  void (async () => {
    const one = await Posts.find().limit(1).include({ a: { from: Users, local: 'authorId' } }).toArray();
    const a: Doc<typeof users> | null = one[0].a;
    const many = await Posts.find().limit(1).include({ t: { from: Tags, local: 'tagIds' } }).toArray();
    const ts: Doc<typeof tags>[] = many[0].t;
    const rev = await Users.find().limit(1).include({ p: { from: Posts, foreign: 'authorId', all: true } }).toArray();
    const ps: Doc<typeof posts>[] = rev[0].p;
    // @ts-expect-error a forward single relation is not an array
    const wrong: Doc<typeof users>[] = one[0].a;
    void [a, ts, ps, wrong];
  });
}
