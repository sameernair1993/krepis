import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { createDal, schema, t } from '../src/dal/index.ts';
import { URI } from './helpers.ts';

/**
 * An update operator whose key set is empty for a schema must reject every key.
 * An empty mapped type is `{}`, which skips excess-property checks, so before this an
 * operator with nothing it could legally name accepted anything.
 * Compile-time only: `npm run typecheck` fails if a `@ts-expect-error` line compiles.
 */

const client = new MongoClient(URI);
const dal = createDal(client, { dbName: 'krepis_update_keys_types' });

const NoArrays = dal.collection('noArrays', schema({ name: t.string(), age: t.number() }));
const OnlyId = dal.collection('onlyId', schema({}));
const WithArrays = dal.collection('withArrays', schema({ name: t.string(), tags: t.array(t.string()) }));

declare const id: ObjectId;

export async function arrayOperatorsOnASchemaWithNoArrays() {
  // @ts-expect-error no array paths, so $push can name nothing
  await NoArrays.updateOne({ _id: id }, { $push: { tags: 'x' } });
  // @ts-expect-error $addToSet
  await NoArrays.updateOne({ _id: id }, { $addToSet: { tags: 'x' } });
  // @ts-expect-error $pull
  await NoArrays.updateOne({ _id: id }, { $pull: { tags: 'x' } });
  // @ts-expect-error $pullAll
  await NoArrays.updateOne({ _id: id }, { $pullAll: { tags: ['x'] } });
  // @ts-expect-error a scalar field is not an array path either
  await NoArrays.updateOne({ _id: id }, { $push: { name: 'x' } });
  // An empty operand is a no-op the server accepts, so it stays legal.
  await NoArrays.updateOne({ _id: id }, { $push: {} });
  // The error lands on the offending key, not on the whole update.
  await NoArrays.updateOne(
    { _id: id },
    {
      $set: { name: 'n' },
      $addToSet: {
        // @ts-expect-error reported on this line
        tags: 'x',
      },
    },
  );
}

export async function setOperatorsOnAnIdOnlySchema() {
  // @ts-expect-error $set has nothing to set: _id is immutable
  await OnlyId.updateOne({ _id: id }, { $set: { name: 'x' } });
  // @ts-expect-error $setOnInsert
  await OnlyId.updateOne({ _id: id }, { $setOnInsert: { name: 'x' } }, { upsert: true });
  // @ts-expect-error $min
  await OnlyId.updateOne({ _id: id }, { $min: { n: 1 } });
  // @ts-expect-error $max
  await OnlyId.updateOne({ _id: id }, { $max: { n: 1 } });
  // @ts-expect-error a top-level key (always rejected)
  await OnlyId.updateOne({ _id: id }, { name: 'x' });
}

export async function controlsThatMustStillCompile() {
  await WithArrays.updateOne({ _id: id }, { $push: { tags: 'x' } });
  await WithArrays.updateOne({ _id: id }, { $push: { tags: { $each: ['a', 'b'], $slice: -5 } } });
  await WithArrays.updateOne({ _id: id }, { $addToSet: { tags: { $each: ['a'] } } });
  await WithArrays.updateOne({ _id: id }, { $pull: { tags: { $in: ['a'] } } });
  await WithArrays.updateOne({ _id: id }, { $pullAll: { tags: ['a'] } });
  await WithArrays.updateOne({ _id: id }, { $set: { name: 'x' }, $min: { name: 'a' }, $max: { name: 'z' } });
  await NoArrays.updateOne({ _id: id }, { $set: { name: 'x' }, $inc: { age: 1 } });
  // @ts-expect-error a non-empty key set still rejects unknown keys
  await WithArrays.updateOne({ _id: id }, { $push: { tagz: 'x' } });
}

test('update operator keys: compile-time only (see npm run typecheck)', () => {
  assert.equal(typeof arrayOperatorsOnASchemaWithNoArrays, 'function');
});
