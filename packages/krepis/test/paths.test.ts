import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { createDal, schema, t } from '../src/dal/index.ts';
import { URI } from './helpers.ts';

/**
 * Typed dotted paths, typed array update operators and projection narrowing.
 * These are compile-time tests: `npm run typecheck` fails if a `@ts-expect-error` line compiles,
 * and each one has a control line beside it that must compile. The functions are never called.
 */

const client = new MongoClient(URI);
const dal = createDal(client, { dbName: 'krepis_paths_types' });

const Orders = dal.collection(
  'orders',
  schema({
    ref: t.string(),
    total: t.number(),
    customer: t.object({
      name: t.string(),
      address: t.object({ city: t.string(), zip: t.number().optional() }),
    }),
    items: t.array(t.object({ sku: t.string(), qty: t.number(), tags: t.array(t.string()) })),
    labels: t.array(t.string()),
    prefs: t.map(t.number()),
    meta: t.mixed(),
    ownerId: t.objectId().optional(),
  }),
);

declare const id: ObjectId;

export function filters() {
  Orders.find({ 'customer.address.city': 'x' });
  // @ts-expect-error misspelled nested path
  Orders.find({ 'customer.adress.city': 'x' });
  // @ts-expect-error wrong value type on a nested path
  Orders.find({ 'customer.address.city': 5 });
  Orders.find({ 'customer.address.zip': { $gt: 1 } });
  // @ts-expect-error operator value type follows the path
  Orders.find({ 'customer.address.zip': { $gt: 'x' } });
  Orders.find({ 'items.qty': { $gte: 2 } }); // implicit array traversal
  Orders.find({ 'items.0.sku': 'a' });
  // @ts-expect-error element field misspelled
  Orders.find({ 'items.qyt': 2 });
  // @ts-expect-error implicit traversal keeps the element field's type
  Orders.find({ 'items.qty': 'two' });
  Orders.find({ 'items.tags': 'red' });
  Orders.find({ 'prefs.dark': 1 }); // map
  // @ts-expect-error map values are typed
  Orders.find({ 'prefs.dark': 'on' });
  Orders.find({ 'meta.anything.at.all': 1 }); // mixed stays open below its key
  Orders.find({ $or: [{ 'customer.name': 'a' }, { 'items.sku': 'b' }] });
  // @ts-expect-error nested inside $or too
  Orders.find({ $or: [{ 'customer.nmae': 'a' }] });
  Orders.find({ ownerId: id.toHexString() }); // still castable
}

export async function updates() {
  await Orders.updateOne({ _id: id }, { $set: { 'customer.address.city': 'y' } });
  // @ts-expect-error $set on a misspelled path
  await Orders.updateOne({ _id: id }, { $set: { 'customer.address.cty': 'y' } });
  // @ts-expect-error $set value type follows the path
  await Orders.updateOne({ _id: id }, { $set: { 'customer.address.city': 1 } });
  await Orders.updateOne({ 'items.sku': 'a' }, { $set: { 'items.$.qty': 3 } });
  await Orders.updateOne({ _id: id }, { $set: { 'items.$[].qty': 0, 'items.$[hit].sku': 'z', 'items.1.qty': 1 } });
  // @ts-expect-error positional value type follows the element field
  await Orders.updateOne({ _id: id }, { $set: { 'items.$.qty': 'three' } });
  // @ts-expect-error implicit traversal is a filter feature, not an update one
  await Orders.updateOne({ _id: id }, { $set: { 'items.qty': 1 } });
  await Orders.updateOne({ _id: id }, { $inc: { 'items.$.qty': 1, total: 2, 'prefs.dark': 1 } });
  // @ts-expect-error $inc on a string path
  await Orders.updateOne({ _id: id }, { $inc: { 'customer.name': 1 } });
  await Orders.updateOne({ _id: id }, { $mul: { total: 1.1 } });
  // @ts-expect-error $mul on a string field
  await Orders.updateOne({ _id: id }, { $mul: { ref: 2 } });
  await Orders.updateOne({ _id: id }, { $unset: { 'customer.address.zip': '' } });
  // @ts-expect-error $unset on a misspelled path
  await Orders.updateOne({ _id: id }, { $unset: { 'customer.adress.zip': '' } });
  await Orders.updateOne({ _id: id }, { $set: { 'meta.deep.key': [1] } });
}

export async function arrays() {
  await Orders.updateOne({ _id: id }, { $push: { labels: 'x' } });
  // @ts-expect-error $push element type
  await Orders.updateOne({ _id: id }, { $push: { labels: 5 } });
  // @ts-expect-error $push to a non-array field
  await Orders.updateOne({ _id: id }, { $push: { ref: 'x' } });
  await Orders.updateOne({ _id: id }, { $push: { labels: { $each: ['a', 'b'], $slice: -5 } } });
  // @ts-expect-error $each element type
  await Orders.updateOne({ _id: id }, { $push: { labels: { $each: [1] } } });
  await Orders.updateOne({ _id: id }, { $push: { items: { sku: 's', qty: 1, tags: [] } } });
  // @ts-expect-error $push a malformed element
  await Orders.updateOne({ _id: id }, { $push: { items: { sku: 's', qty: 'one', tags: [] } } });
  await Orders.updateOne({ _id: id }, { $push: { 'items.$.tags': 'new' } });
  await Orders.updateOne({ _id: id }, { $addToSet: { labels: 'x' } });
  // @ts-expect-error $addToSet element type
  await Orders.updateOne({ _id: id }, { $addToSet: { labels: 1 } });
  await Orders.updateOne({ _id: id }, { $pull: { labels: 'x', items: { qty: { $lt: 1 } } } });
  // @ts-expect-error $pull condition on a misspelled element field
  await Orders.updateOne({ _id: id }, { $pull: { items: { qyt: { $lt: 1 } } } });
  await Orders.updateOne({ _id: id }, { $pullAll: { labels: ['a', 'b'] } });
  // @ts-expect-error $pullAll element type
  await Orders.updateOne({ _id: id }, { $pullAll: { labels: [1] } });
}

export async function sortAndProject() {
  Orders.find({}).sort({ 'customer.address.city': 1, total: -1 });
  // @ts-expect-error sort on a misspelled path
  Orders.find({}).sort({ 'customer.adress.city': 1 });
  Orders.find({}).select({ 'customer.name': 1 });
  // @ts-expect-error select a misspelled path
  Orders.find({}).select({ 'customer.nme': 1 });
}

export async function narrowing() {
  const [a] = await Orders.find({}).select({ ref: 1, 'customer.address.city': 1 }).limit(1).toArray();
  a._id.toHexString(); // _id is kept by an inclusion projection
  a.ref.toUpperCase();
  a.customer.address.city.toUpperCase();
  // @ts-expect-error not selected
  a.total.toFixed();
  // @ts-expect-error nested sibling not selected
  a.customer.name.toUpperCase();

  const [b] = await Orders.find({}).select({ ref: 1, _id: 0 }).limit(1).toArray();
  b.ref.toUpperCase();
  // @ts-expect-error _id excluded
  b._id.toHexString();

  const [c] = await Orders.find({}).select({ items: 0, 'customer.address': 0 }).limit(1).toArray();
  c.total.toFixed();
  c.customer.name.toUpperCase();
  // @ts-expect-error excluded field
  c.items.length;
  // @ts-expect-error excluded nested field
  c.customer.address.city.toUpperCase();

  const [d] = await Orders.find({}).select({ 'items.qty': 1 }).limit(1).toArray();
  d.items[0].qty.toFixed();
  // @ts-expect-error not selected inside the array element
  d.items[0].sku.toUpperCase();

  // @ts-expect-error inclusion and exclusion cannot be mixed (except _id)
  Orders.find({}).select({ ref: 1, total: 0 });

  const e = await Orders.findOne({ ref: 'x' }, { projection: { ref: 1 } });
  e?.ref.toUpperCase();
  // @ts-expect-error findOne narrows too
  e?.total.toFixed();

  const f = await Orders.findOneAndUpdate({ ref: 'x' }, { $set: { total: 1 } }, { projection: { total: 1 } });
  f?.total.toFixed();
  // @ts-expect-error findOneAndUpdate narrows too
  f?.ref.toUpperCase();

  // Not a literal: no narrowing, the full document.
  const wide: { ref?: 0 | 1 } = {};
  const [g] = await Orders.find({}).select(wide).limit(1).toArray();
  g.total.toFixed();
}

/** A projection with dynamic keys (built at runtime) is not a literal either. */
export async function dynamicProjection(fields: string[]) {
  const exclude: Record<string, 0> = { items: 0 };
  for (const f of fields) exclude[f] = 0;
  const [a] = await Orders.find({}, { projection: exclude }).limit(1).toArray();
  a.total.toFixed(); // no narrowing: the full document
  a.ref.toUpperCase();
  const [b] = await Orders.find({}).select(exclude).limit(1).toArray();
  b.customer.name.toUpperCase();
  const c = await Orders.findOne({ ref: 'x' }, { projection: exclude });
  c?.total.toFixed();
  const include: Record<string, 1> = { ref: 1 };
  const [d] = await Orders.find({}).select(include).limit(1).toArray();
  d.ref.toUpperCase();
  // A literal is still narrowed and still path-checked beside it.
  const [e] = await Orders.find({}).select({ items: 0 }).limit(1).toArray();
  // @ts-expect-error excluded field
  e.items.length;
  // @ts-expect-error select a misspelled path
  Orders.find({}).select({ 'customer.nme': 0 });
}

const Users = dal.collection('users', schema({ name: t.string(), email: t.string(), age: t.number() }));
const Posts = dal.collection('posts', schema({ title: t.string(), body: t.string(), authorId: t.objectId() }));

export async function narrowingWithIncludes() {
  // select then include, and include then select, give the same row
  const [a] = await Posts.find({}).select({ title: 1 }).include({ author: { from: Users, local: 'authorId' } }).limit(1).toArray();
  const [b] = await Posts.find({}).include({ author: { from: Users, local: 'authorId' } }).select({ title: 1 }).limit(1).toArray();
  for (const r of [a, b]) {
    r.title.toUpperCase();
    r.author?.name.toUpperCase(); // a relation survives any projection at runtime, so it does in the type
    // @ts-expect-error not selected
    r.body.toUpperCase();
  }
  // A relation's own select narrows the loaded document.
  const [c] = await Posts.find({}).include({ author: { from: Users, local: 'authorId', select: { name: 1 } } }).limit(1).toArray();
  c.author?.name.toUpperCase();
  // @ts-expect-error not selected on the relation
  c.author?.email.toUpperCase();
}

test('typed paths: compile-time only (see npm run typecheck)', () => {
  assert.equal(typeof filters, 'function');
});
