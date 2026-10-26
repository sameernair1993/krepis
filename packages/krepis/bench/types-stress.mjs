// Generates a 40-leaf, 4-level schema and 60 typed calls, then times `tsc` on it.
// Usage: node bench/types-stress.mjs && node_modules/.bin/tsc -p bench/.stress --noEmit --extendedDiagnostics
import { mkdirSync, writeFileSync } from 'node:fs';
const out = new URL('./.stress/', import.meta.url);
mkdirSync(out, { recursive: true });
// 40 leaf fields total, nesting to 4 levels, arrays of objects, maps.
const schema = `const Big = dal.collection('big', schema({
  s1: t.string(), s2: t.string(), s3: t.string(), n1: t.number(), n2: t.number(), n3: t.number(), b1: t.boolean(), d1: t.date(), o1: t.objectId(), tags: t.array(t.string()),
  a: t.object({
    s: t.string(), n: t.number(), d: t.date(),
    b: t.object({
      s: t.string(), n: t.number(), flag: t.boolean(),
      c: t.object({ s: t.string(), n: t.number(), d: t.date(), id: t.objectId(), list: t.array(t.number()) }),
    }),
  }),
  items: t.array(t.object({ sku: t.string(), qty: t.number(), price: t.number(), meta: t.object({ color: t.string(), size: t.number() }) })),
  lines: t.array(t.object({ k: t.string(), v: t.number(), sub: t.array(t.object({ x: t.number(), y: t.string() })) })),
  counts: t.map(t.number()),
  labels: t.map(t.string()),
  prefs: t.map(t.object({ on: t.boolean(), level: t.number() })),
  extra: t.mixed(),
  opt1: t.string().optional(), opt2: t.number().optional(), opt3: t.date().optional(),
}));
const Other = dal.collection('other', schema({ name: t.string(), bigId: t.objectId(), score: t.number() }));`;
const calls = [
  `Big.find({ s1: 'x', n1: { $gt: 1 } })`, `Big.find({ 'a.b.c.n': { $gte: 2 } })`, `Big.find({ 'a.b.c.s': 'x', 'a.n': 1 })`,
  `Big.find({ 'items.sku': 'x' })`, `Big.find({ 'items.meta.color': 'red' })`, `Big.find({ 'lines.sub.x': 3 })`,
  `Big.find({ 'counts.k': 1 })`, `Big.find({ 'prefs.k.level': 2 })`, `Big.find({ $or: [{ s1: 'x' }, { 'a.b.flag': true }] })`,
  `Big.find({ tags: 'x' })`, `Big.find({ 'items.0.qty': 1 })`, `Big.find({ 'a.b.c.list': 5 })`,
  `Big.find({}).sort({ 'a.b.c.n': -1, s1: 1 })`, `Big.find({}).sort({ 'items.price': 1 })`,
  `Big.find({}).select({ s1: 1, 'a.b.c.s': 1 }).all()`, `Big.find({}).select({ items: 1, n1: 1 }).all()`, `Big.findOne({ s1: 'x' }, { projection: { 'a.b': 1 } })`,
  `Big.updateOne({ s1: 'x' }, { $set: { 'a.b.c.n': 1 } })`, `Big.updateOne({ s1: 'x' }, { $set: { 'items.$.qty': 2 } })`,
  `Big.updateOne({ s1: 'x' }, { $set: { 'items.$[].price': 2 } })`, `Big.updateOne({ s1: 'x' }, { $inc: { n1: 1, 'a.b.n': 2 } })`,
  `Big.updateOne({ s1: 'x' }, { $push: { tags: 'y' } })`, `Big.updateOne({ s1: 'x' }, { $push: { items: { sku: 's', qty: 1, price: 2, meta: { color: 'c', size: 1 } } } })`,
  `Big.updateOne({ s1: 'x' }, { $addToSet: { tags: 'z' } })`, `Big.updateOne({ s1: 'x' }, { $pull: { tags: 'z' } })`,
  `Big.updateMany({ n1: 1 }, { $set: { 'counts.k': 3 } })`, `Big.updateMany({ n1: 1 }, { $set: { 'prefs.k.on': false } })`,
  `Big.updateMany({ n1: 1 }, { $mul: { n2: 2 } })`, `Big.updateMany({ n1: 1 }, { $unset: { opt1: '' } })`,
  `Big.updateMany({ n1: 1 }, { $set: { 'lines.$[].sub.$[].x': 1 } })`,
  `Big.aggregate().match({ 'a.b.c.n': 1 }).all()`, `Big.aggregate().match({ 'items.qty': { $gt: 1 } }).limit(5).all()`,
  `Big.aggregate().group({ _id: '$s1', n: { $sum: '$n1' }, avg: { $avg: '$a.b.c.n' } }).all()`,
  `Big.aggregate().group({ _id: '$a.b.s', mx: { $max: '$d1' }, first: { $first: '$s2' } }).sort({ mx: -1 }).all()`,
  `Big.aggregate().project({ s1: 1, 'a.b.c.s': 1 }).all()`, `Big.aggregate().project({ s1: 1, x: '$a.b.c.n' }).all()`,
  `Big.aggregate().addFields({ total: { $add: ['$n1', '$n2', '$n3'] } }).sort({ total: -1 }).all()`,
  `Big.aggregate().addFields({ label: { $concat: ['$s1', '-', '$s2'] } }).project({ label: 1 }).all()`,
  `Big.aggregate().unwind('$items').group({ _id: '$items.sku', q: { $sum: '$items.qty' } }).all()`,
  `Big.aggregate().unwind('$lines').match({ 'lines.v': 1 }).all()`, `Big.aggregate().unwind('$tags').group({ _id: '$tags', c: { $count: {} } }).all()`,
  `Big.aggregate().lookup({ from: Other, localField: '_id', foreignField: 'bigId', as: 'others' }).all()`,
  `Big.aggregate().lookup({ from: Other, localField: '_id', foreignField: 'bigId', as: 'o', pipeline: (p) => p.project({ name: 1 }) }).all()`,
  `Big.aggregate().match({ b1: true }).group({ _id: null, c: { $count: {} } }).all()`, `Big.aggregate().count('n').all()`,
  `Big.aggregate().sample(3).all()`, `Big.aggregate().set({ dbl: { $multiply: ['$n1', 2] } }).match({ dbl: { $gt: 3 } }).all()`,
  `Big.aggregate().unset('items').limit(1).all()`, `Big.aggregate().replaceWith('$a').all()`,
  `Big.aggregate().group({ _id: '$s1', ids: { $push: '$o1' }, set: { $addToSet: '$s3' } }).all()`,
  `Big.find({ 'a.b.c.d': { $lt: new Date() } }).all()`, `Big.find({ opt2: { $exists: true } }).all()`,
  `Big.count({ 'a.s': 'x' })`, `Big.exists({ 'items.meta.size': 3 })`, `Big.deleteMany({ 'lines.k': 'x' })`,
  `Big.findOneAndUpdate({ s1: 'x' }, { $set: { 'a.d': new Date() } })`, `Big.distinct('s1', { 'a.b.flag': true })`,
  `Big.aggregate().match({ s1: 'x' }).project({ _id: 0, s1: 1, n1: 1 }).sort({ n1: 1 }).skip(1).limit(2).all()`,
  `Other.aggregate().lookup({ from: Big, localField: 'bigId', foreignField: '_id', as: 'big' }).unwind('$big').all()`,
  `Big.aggregate().group({ _id: { s: '$s1', n: '$a.n' }, c: { $sum: 1 } }).all()`,
];
if (calls.length !== 60) throw new Error(`calls=${calls.length}`);
const src = `// Type stress file (generated). 40-leaf schema, 4 levels, arrays of objects, maps; 60 typed calls.
import type { MongoClient } from 'mongodb';
import { createDal, schema, t } from '../../src/dal/index.ts';
declare const client: MongoClient;
const dal = createDal(client, { dbName: 'stress' });
${schema}
export async function stress() {
${calls.map((c, i) => `  const r${i} = await ${c};\n  void r${i};`).join('\n')}
}
`;
writeFileSync(new URL('stress.ts', out), src);
writeFileSync(new URL('tsconfig.json', out), JSON.stringify({ extends: '../../tsconfig.json', include: [], files: ['stress.ts'] }, null, 2));
