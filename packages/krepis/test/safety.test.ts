import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId, type CommandStartedEvent } from 'mongodb';
import { createDal, KrepisInputError, match, op, schema, t, type Doc } from '../src/dal/index.ts';
import { isTrusted } from '../src/dal/input.ts';
import { mongooseModel } from '../src/compat/index.ts';
import { URI } from './helpers.ts';

// Operator objects from input, server-side JavaScript, hidden fields and escaped regex helpers.

const client = new MongoClient(URI, { monitorCommands: true });
const db = () => client.db('krepis_safety_test');
const sent: CommandStartedEvent[] = [];
client.on('commandStarted', (e) => sent.push(e));

const accounts = schema({
  name: t.string(),
  email: t.string(),
  resetToken: t.string().optional(),
  passwordHash: t.string().hidden(),
  age: t.number().optional(),
  tags: t.array(t.string()).default(() => []),
  orgId: t.objectId().optional(),
  meta: t.mixed().optional(),
  items: t.array(t.object({ sku: t.string() })).optional(),
});
const orgs = schema({ name: t.string(), secret: t.string().hidden() });

const dal = createDal(client, { dbName: 'krepis_safety_test' });
const Accounts = dal.collection('accounts', accounts);
const Orgs = dal.collection('orgs', orgs);
const Stamped = dal.collection('stamped', schema({ a: t.number(), b: t.number().optional() }, { timestamps: true }));
const Loose = createDal(client, { dbName: 'krepis_safety_test', strictInput: false }).collection('accounts', accounts);

/** A request body: parsed JSON, untyped, as an application receives it. */
const body = (json: string): any => JSON.parse(json);

const orgId = new ObjectId();
before(() => client.connect());
after(() => client.close());
beforeEach(async () => {
  await db().dropDatabase();
  await Orgs.raw().insertOne({ _id: orgId, name: 'acme', secret: 's3' });
  await Accounts.insertMany([
    { name: 'ada', email: 'ada@x.test', resetToken: 'tok-a', passwordHash: 'h1', age: 36, tags: ['a', 'b'], orgId, items: [{ sku: 'x1' }] },
    { name: 'a.b', email: 'ab@x.test', passwordHash: 'h2', age: 20, tags: ['b'] },
    { name: 'axb', email: 'axb@x.test', passwordHash: 'h3', age: 50, tags: [] },
  ]);
  sent.length = 0;
});

test('S6 an operator object from input is refused on a scalar field, inside $or, and on an array of strings', async () => {
  const { token } = body('{"token":{"$ne":null}}');
  await assert.rejects(Accounts.findOne({ resetToken: token }), (e: unknown) => e instanceof KrepisInputError && e.path === 'resetToken');
  await assert.rejects(Accounts.find({ $or: [{ name: 'x' }, { resetToken: token }] }).limit(5).toArray(), KrepisInputError);
  // Inside $nor too: the operator Mongoose's sanitizeFilter missed until GHSA-wpg9-53fq-2r8h.
  await assert.rejects(Accounts.count({ $nor: [{ resetToken: token }] }), KrepisInputError);
  await assert.rejects(Accounts.count({ tags: body('{"$ne":"zzz"}') }), KrepisInputError);
  await assert.rejects(Accounts.updateOne({ email: body('{"$gt":""}') }, { $set: { age: 1 } }), KrepisInputError);
  await assert.rejects(Accounts.deleteMany({ _id: body('{"$exists":true}') }), KrepisInputError);
  assert.equal(sent.filter((e) => e.commandName !== 'endSessions').length, 0, 'nothing reached the server');
  assert.equal(await Accounts.raw().countDocuments(), 3, 'nothing was deleted');
});

test('S6 operators built with op are accepted, and strictInput: false restores pass-through', async () => {
  assert.equal(await Accounts.count({ age: op.gte(30) }), 2);
  assert.equal(await Accounts.count({ age: op({ $gte: 30, $lt: 40 }) }), 1);
  assert.equal(await Accounts.count({ tags: op.all(['a', 'b']) }), 1);
  assert.equal(await Accounts.count({ name: op.in(['ada', 'axb']), resetToken: op.exists(false) }), 1);
  assert.equal(await Accounts.count({ name: op.not(match.prefix('a')) }), 0);
  // Not scalar fields: a mixed field and unknown keys are left alone.
  assert.equal(await Accounts.count({ meta: { $exists: false } }), 3);
  assert.equal((await Loose.findOne({ resetToken: body('{"$ne":null}') }))?.name, 'ada');
});

test('S6 $where, $function and $accumulator are refused unless the object holding them is built with op', async () => {
  await assert.rejects(Accounts.find(body('{"$where":"true"}')).limit(5).toArray(), (e: unknown) => e instanceof KrepisInputError && e.path === '$where');
  await assert.rejects(Accounts.count({ $or: [body('{"$where":"true"}')] }), KrepisInputError);
  await assert.rejects(Loose.count(body('{"$where":"true"}')), KrepisInputError, 'whatever strictInput says');
  assert.throws(() => Accounts.aggregate().addFields({ x: { $function: { body: 'function () { return 1 }', args: [], lang: 'js' } } } as never), KrepisInputError);
  assert.throws(() => Accounts.aggregate().stage({ $group: { _id: null, n: { $accumulator: {} } } }), KrepisInputError);
  assert.throws(() => Accounts.aggregate().project({ _id: 1 }).match(body('{"$where":"true"}')), KrepisInputError);
  assert.equal(await Accounts.find(op({ $where: 'this.age > 40' })).limit(5).toArray().then((r) => r.length), 1);
});

test('S6 a hidden field is absent from every read unless selected by name', async () => {
  const has = (d: object | null | undefined) => d !== null && d !== undefined && 'passwordHash' in d;
  assert.equal(has(await Accounts.findOne({ name: 'ada' })), false, 'findOne');
  assert.equal((await Accounts.find({}).limit(5).toArray()).some(has), false, 'find');
  assert.equal((await Accounts.find({}).select({ name: 0 }).limit(5).toArray()).some(has), false, 'exclusion projection');
  assert.equal(has(await Accounts.findOneAndUpdate({ name: 'ada' }, { $set: { age: 37 } })), false, 'findOneAndUpdate');
  assert.equal(has(await Accounts.findOneAndDelete({ name: 'axb' })), false, 'findOneAndDelete');
  assert.equal((await Accounts.aggregate().match({ name: 'ada' }).limit(1).toArray()).some(has), false, 'aggregate');
  const [row] = await Accounts.find({ name: 'ada' }).limit(1).include({ org: { from: Orgs, local: 'orgId' } }).toArray();
  assert.equal(row?.org?.name, 'acme');
  assert.equal(row?.org !== null && row?.org !== undefined && 'secret' in row.org, false, 'include target');
  const [joined] = await Accounts.aggregate().match({ name: 'ada' }).limit(1).lookup({ from: Orgs, localField: 'orgId', foreignField: '_id', as: 'org' }).toArray();
  assert.equal(has(joined), false);
  assert.equal('secret' in (joined?.org[0] ?? {}), false, 'aggregate lookup target');

  assert.equal((await Accounts.findOne({ name: 'ada' }, { projection: { passwordHash: 1 } }))?.passwordHash, 'h1');
  assert.equal((await Accounts.find({ name: 'ada' }).select({ passwordHash: 1 }).limit(1).toArray())[0]?.passwordHash, 'h1');
  assert.equal((await Accounts.aggregate().match({ name: 'ada' }).project({ passwordHash: 1 }).limit(1).toArray())[0]?.passwordHash, 'h1');
  assert.equal(await Accounts.count({ passwordHash: 'h1' }), 1, 'filters still see it');
});

test('S6 hidden: read types make the field optional; inserts still require it; nested hidden is refused', () => {
  type Row = Doc<typeof accounts>;
  const optional: Row['passwordHash'] = undefined;
  // @ts-expect-error inserts still require a hidden field
  const insert = () => Accounts.insertOne({ name: 'x', email: 'y' });
  assert.equal(optional, undefined);
  assert.equal(typeof insert, 'function');
  assert.throws(() => schema({ a: t.object({ b: t.string().hidden() }) }), TypeError);
  assert.throws(() => schema({ a: t.array(t.string().hidden()) }), TypeError);
});

test('S6 match.prefix and match.contains escape input', async () => {
  const names = async (cond: object) => (await Accounts.find({ name: cond as never }).sort({ name: 1 }).limit(5).toArray()).map((d) => d.name);
  assert.deepEqual(await names(match.prefix('a.b')), ['a.b']);
  assert.deepEqual(await names(match.contains('.')), ['a.b']);
  assert.deepEqual(await names(match.prefix('A', { ignoreCase: true })), ['a.b', 'ada', 'axb']);
  const evil = match.contains('^(a|aa)+$', { ignoreCase: true });
  assert.equal(evil.$regex, '\\^\\(a\\|aa\\)\\+\\$');
  assert.equal(evil.$options, 'i');
  assert.deepEqual(await names(evil), []);
  assert.throws(() => match.contains(body('{"$ne":1}')), TypeError);
  await assert.rejects(Accounts.find({ name: { $regex: body('{"q":"^a"}').q } }).limit(5).toArray(), KrepisInputError, 'raw $regex is an operator object');
  assert.throws(() => match.contains('a\0b'), TypeError, 'MongoDB refuses a NUL in a regex');
});

// Bypasses found by a security review. Each test fails on the code before its fix.

const hasHash = (d: unknown): boolean => JSON.stringify(d ?? null).includes('"passwordHash"');

test('R2 aggregate: a stage that carries whole documents does not carry hidden fields', async () => {
  assert.equal(hasHash(await Accounts.aggregate().replaceWith('$$ROOT').limit(5).toArray()), false, 'replaceWith $$ROOT');
  assert.equal(hasHash(await Accounts.aggregate().addFields({ me: '$$ROOT' }).limit(5).toArray()), false, 'copied under another field');
  assert.equal(hasHash(await Accounts.aggregate().group({ _id: null, all: { $push: '$$ROOT' } }).all()), false, '$group $push $$ROOT');
  assert.equal(hasHash(await Accounts.aggregate().stage({ $facet: { rows: [{ $limit: 20 }] } }).all()), false, '$facet');
  // Filtering and sorting on it still work, and naming it in a later stage opts in.
  const [ada] = await Accounts.aggregate().match({ passwordHash: 'h1' }).sort({ passwordHash: 1 }).replaceWith('$$ROOT').limit(1).toArray();
  assert.equal(ada?.name, 'ada');
  assert.equal(hasHash(ada), false);
  const [named] = await Accounts.aggregate().match({ name: 'ada' }).addFields({ h: '$passwordHash' }).limit(1).toArray();
  assert.equal(named?.h, 'h1');
  assert.equal('passwordHash' in (named ?? {}), false, 'the stored field is still removed at the end');
});

test('R2 projections: $slice-only is not an inclusion, { _id: 1 } is', async () => {
  const sliced = await Accounts.findOne({ name: 'ada' }, { projection: { tags: { $slice: 1 } } } as never);
  assert.deepEqual(sliced?.tags, ['a']);
  assert.equal(hasHash(sliced), false);
  const [onlyId] = await Accounts.find({ name: 'ada' }).select({ _id: 1 }).limit(1).toArray();
  assert.deepEqual(Object.keys(onlyId ?? {}), ['_id']);
});

test('R2 strictInput: $elemMatch, $pull and a $match through stage() or compat aggregate', async () => {
  const inj = () => body('{"$ne":null}');
  await assert.rejects(Accounts.count({ items: { $elemMatch: { sku: inj() } } }), KrepisInputError, '$elemMatch');
  assert.equal(await Accounts.count({ items: { $elemMatch: { sku: 'x1' } } }), 1);
  await assert.rejects(Accounts.updateOne({ name: 'ada' }, { $pull: { tags: inj() } }), KrepisInputError, '$pull');
  await assert.rejects(Accounts.updateOne({ name: 'ada' }, { $pull: { items: { sku: inj() } } }), KrepisInputError, '$pull on objects');
  await Accounts.updateOne({ name: 'ada' }, { $pull: { tags: 'a' } });
  assert.deepEqual((await Accounts.findOne({ name: 'ada' }))?.tags, ['b']);
  assert.throws(() => Accounts.aggregate().stage({ $match: { email: inj() } }), KrepisInputError, 'stage $match');
  const Model = mongooseModel(Accounts);
  await assert.rejects(async () => Model.aggregate([{ $match: { email: inj() } }, { $limit: 5 }]).exec(), KrepisInputError, 'compat');
  const rows = await Model.aggregate([{ $match: { email: 'ada@x.test' } }, { $limit: 5 }]).exec();
  assert.equal(rows.length, 1);
  assert.equal(hasHash(rows), false);
});

test('R2 filter shape: logical elements must be objects; __proto__ is refused', async () => {
  await assert.rejects(Accounts.count({ $or: [null] } as never), KrepisInputError);
  await assert.rejects(Accounts.count({ $or: ['ab'] } as never), KrepisInputError);
  await assert.rejects(Accounts.count(body('{"__proto__":{"email":{"$ne":null}}}')), KrepisInputError);
  await assert.rejects(Loose.count(body('{"__proto__":{"email":{"$ne":null}}}')), KrepisInputError, 'whatever strictInput says');
  // Inherited keys are not schema fields: dropped from an insert like any unknown key.
  await Accounts.insertOne(body('{"name":"z","email":"z@x.test","passwordHash":"h","constructor":"x","toString":"y"}'));
  const raw = await Accounts.raw().findOne({ name: 'z' });
  assert.deepEqual([Object.hasOwn(raw!, 'constructor'), Object.hasOwn(raw!, 'toString')], [false, false]);
});

test('R2 op: the mark is an own property and covers only its own level', async () => {
  assert.equal(isTrusted(Object.create(op({}))), false);
  await assert.rejects(Accounts.find(op({ $and: [body('{"$where":"true"}')] })).limit(5).toArray(), KrepisInputError, 'input under a marked object is scanned');
  assert.equal((await Accounts.find(op({ $where: 'this.age > 40' })).limit(5).toArray()).length, 1);
});

// An update that is not an object was turned into index keys and dropped, and the write misreported.

test('U1 an update that is not a plain object is refused, and nothing is sent', async () => {
  await Stamped.insertOne({ a: 1 });
  sent.length = 0;
  const pipe = (): any => [{ $set: { b: { $add: ['$a', 1] } } }];
  const refused = (e: unknown) => e instanceof KrepisInputError && e.path === '';
  await assert.rejects(Accounts.updateOne({ name: 'ada' }, pipe()), refused);
  await assert.rejects(Stamped.updateOne({ a: 1 }, pipe()), refused, 'timestamps used to send updatedAt alone');
  await assert.rejects(Stamped.updateMany({ a: 1 }, pipe()), refused);
  await assert.rejects(Stamped.findOneAndUpdate({ a: 1 }, pipe()), refused);
  await assert.rejects(Stamped.bulkWrite([{ updateOne: { filter: { a: 1 }, update: pipe() } }]), refused);
  await assert.rejects(mongooseModel(Stamped).updateOne({ a: 1 }, pipe()), refused, 'compat');
  await assert.rejects(Stamped.updateOne({ a: 1 }, 'ab' as any), refused, 'a string');
  await assert.rejects(Stamped.updateOne({ a: 1 }, null as any), refused, 'null');
  assert.deepEqual(sent.filter((e) => e.commandName === 'update' || e.commandName === 'findAndModify'), []);
  const doc = await Stamped.raw().findOne({});
  assert.equal(doc?.b, undefined);
  assert.equal(String(doc?.updatedAt), String(doc?.createdAt));
});
