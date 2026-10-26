import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createDal, schema, t } from '../src/dal/index.ts';
import { URI } from './helpers.ts';

/**
 * Geospatial query operators on GeoJSON and legacy-pair fields.
 * Type lines are checked by `npm run typecheck`; the runtime test proves the filter
 * reaches the server unchanged.
 */

const client = new MongoClient(URI);
const dal = createDal(client, { dbName: 'krepis_geo' });

const Places = dal.collection(
  'places',
  schema(
    {
      name: t.string(),
      rank: t.number(),
      location: t.object({ type: t.enum(['Point']).default('Point'), coordinates: t.array(t.number()) }),
      legacy: t.array(t.number()).optional(),
    },
    { indexes: [{ keys: { location: '2dsphere' } }] },
  ),
);

after(() => client.close());

export async function geoOperatorTypes() {
  const centre: number[] = [0, 0];
  await Places.find({ location: { $geoWithin: { $centerSphere: [centre, 0.01] } } }).all();
  await Places.find({ location: { $geoWithin: { $geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } } } }).all();
  await Places.find({ location: { $near: { $geometry: { type: 'Point', coordinates: [0, 0] }, $maxDistance: 1000 } } }).limit(5).toArray();
  await Places.find({ location: { $nearSphere: { $geometry: { type: 'Point', coordinates: [0, 0] }, $minDistance: 1 } } }).limit(5).toArray();
  await Places.find({ location: { $geoIntersects: { $geometry: { type: 'Point', coordinates: [0, 0] } } } }).all();
  await Places.find({ legacy: { $geoWithin: { $box: [[0, 0], [1, 1]] } } }).all();
  await Places.find({ legacy: { $near: [0, 0], $maxDistance: 1 } }).limit(5).toArray();

  // @ts-expect-error a string field is not a geometry
  await Places.find({ name: { $geoWithin: { $centerSphere: [centre, 0.01] } } }).all();
  // @ts-expect-error a number field is not a geometry
  await Places.find({ rank: { $near: [0, 0] } }).limit(1).toArray();
  // @ts-expect-error $centerSphere takes [point, radius]
  await Places.find({ location: { $geoWithin: { $centerSphere: [centre] } } }).all();
  // @ts-expect-error $geometry needs coordinates
  await Places.find({ location: { $geoIntersects: { $geometry: { type: 'Point' } } } }).all();
}

test('geo operators reach the server unchanged', async () => {
  await client.connect();
  await Places.raw().drop().catch(() => undefined);
  await dal.ensureIndexes();
  await Places.insertMany([
    { name: 'origin', rank: 1, location: { type: 'Point', coordinates: [0, 0] } },
    { name: 'near', rank: 2, location: { type: 'Point', coordinates: [0.01, 0.01] } },
    { name: 'far', rank: 3, location: { type: 'Point', coordinates: [10, 10] } },
  ]);

  const within = await Places.find({ location: { $geoWithin: { $centerSphere: [[0, 0], 5 / 6378.1] } } }).all();
  assert.deepEqual(within.map((d) => d.name).sort(), ['near', 'origin']);

  const nearest = await Places.find({
    location: { $near: { $geometry: { type: 'Point', coordinates: [10, 10] }, $maxDistance: 10_000_000 } },
  }).limit(3).toArray();
  assert.deepEqual(nearest.map((d) => d.name), ['far', 'near', 'origin']);

  const hit = await Places.find({ location: { $geoIntersects: { $geometry: { type: 'Point', coordinates: [0, 0] } } } }).all();
  assert.deepEqual(hit.map((d) => d.name), ['origin']);
});
