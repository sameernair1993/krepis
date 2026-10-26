import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, Long, ObjectId } from 'mongodb';
import { describeCommand, pointLookup, valueKey } from '../src/fingerprint.ts';

test('shape ignores $in length and value types collapse numerically', () => {
  const a = describeCommand('find', 'db', { find: 'c', filter: { _id: { $in: [1, 2, 3] } } });
  const b = describeCommand('find', 'db', { find: 'c', filter: { _id: { $in: [4, 5, 6, 7, 8, 9] } } });
  const c = describeCommand('find', 'db', { find: 'c', filter: { _id: { $in: [new Int32(1), new Double(2.5)] } } });
  assert.equal(a?.fingerprint, b?.fingerprint);
  assert.equal(a?.fingerprint, c?.fingerprint);
});

test('values never appear in the shape', () => {
  const secret = 'hunter2-secret';
  const d = describeCommand('find', 'db', {
    find: 'users',
    filter: { email: secret, $or: [{ a: secret }, { b: { $gt: 5 } }], nested: { pw: secret } },
  });
  assert.ok(d);
  assert.ok(!d.shape.includes(secret));
  assert.ok(!d.shape.includes('5'));
});

test('key order does not change the fingerprint; different operators do', () => {
  const a = describeCommand('find', 'db', { find: 'c', filter: { a: 1, b: 2 } });
  const b = describeCommand('find', 'db', { find: 'c', filter: { b: 9, a: 8 } });
  const c = describeCommand('find', 'db', { find: 'c', filter: { a: { $gt: 1 }, b: 2 } });
  assert.equal(a?.fingerprint, b?.fingerprint);
  assert.notEqual(a?.fingerprint, c?.fingerprint);
});

test('point lookup: equality only', () => {
  const id = new ObjectId();
  assert.deepEqual([...(pointLookup({ _id: id }) ?? [])], [['_id', `oid:${id.toHexString()}`]]);
  assert.ok(pointLookup({ _id: { $eq: 5 } }));
  assert.equal(pointLookup({ _id: { $in: [1, 2] } }), undefined);
  assert.equal(pointLookup({ n: { $gt: 1 } }), undefined);
  assert.equal(pointLookup({}), undefined);
  assert.equal(pointLookup({ $or: [{ a: 1 }] }), undefined);
  assert.equal(pointLookup({ name: /x/ }), undefined);
});

test('value keys agree across numeric BSON types', () => {
  assert.equal(valueKey(5), valueKey(new Int32(5)));
  assert.equal(valueKey(5), valueKey(Long.fromNumber(5)));
  assert.equal(valueKey(5), valueKey(new Double(5)));
  assert.notEqual(valueKey(5), valueKey('5'));
});

test('ignored and getMore commands', () => {
  assert.equal(describeCommand('hello', 'admin', { hello: 1 }), undefined);
  const gm = describeCommand('getMore', 'db', { getMore: Long.fromNumber(42), collection: 'c' });
  assert.equal(gm?.cursorId, '42');
});

test('a find-shaped aggregate exposes its $match as the filter; any other pipeline has none', () => {
  const agg = (pipeline: unknown[]) => describeCommand('aggregate', 'db', { aggregate: 'c', pipeline })?.filter;
  assert.deepEqual(agg([{ $match: { _id: 1 } }]), { _id: 1 });
  assert.deepEqual(agg([{ $match: { _id: { $eq: 1 } } }, { $sort: { a: 1 } }, { $skip: 1 }, { $limit: 1 }, { $project: { a: 1 } }]), { _id: { $eq: 1 } });
  assert.equal(agg([{ $match: { _id: 1 } }, { $group: { _id: '$a' } }]), undefined);
  assert.equal(agg([{ $match: { _id: 1 } }, { $lookup: { from: 'd', localField: 'a', foreignField: '_id', as: 'd' } }]), undefined);
  assert.equal(agg([{ $limit: 1 }, { $match: { _id: 1 } }]), undefined);
  assert.equal(agg([]), undefined);
});
