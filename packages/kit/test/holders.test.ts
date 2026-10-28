import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { watchConnections } from '@sameernair/krepis/connections';
import { observe } from '../src/index.ts';
import { describeCommand } from '../src/fingerprint.ts';
import { URI } from './helpers.ts';

// ADR-056 W5: KR-C006 names the queries holding the connections, by the analyser's fingerprint.
test('W5 KR-C006 names the slow query holding the pool, by unit and fingerprint', async () => {
  const DB = 'krepis_kit_c006';
  const SLOW = { $where: 'sleep(300) || true' };
  const client = new MongoClient(URI, { maxPoolSize: 2 });
  const observer = observe(client);
  const w = watchConnections(client, { checkoutWaits: true, holders: observer.holders() });
  try {
    await client.connect();
    const db = client.db(DB);
    await db.dropDatabase();
    await db.collection('reports').insertOne({ _id: 1 } as never);
    await db.collection('users').insertOne({ _id: 1 } as never);
    await Promise.all([db.collection('users').findOne({ _id: 1 } as never), db.collection('users').findOne({ _id: 1 } as never)]);
    await Promise.all([
      observer.run('GET /reports', () => Promise.all(Array.from({ length: 4 }, () => db.collection('reports').find(SLOW).toArray()))),
      observer.run('GET /users', () => Promise.all(Array.from({ length: 4 }, () => db.collection('users').findOne({ _id: 1 } as never)))),
    ]);
    const found = w.findings.filter((f) => f.rule === 'KR-C006');
    assert.equal(found.length, 1, JSON.stringify(w.findings));
    const fp = describeCommand('find', DB, { find: 'reports', filter: SLOW })!.fingerprint;
    const e = found[0]!.evidence;
    assert.equal(e.holder1, `GET /reports: find ${DB}.reports ${fp}`, found[0]!.message);
    assert.ok((e.holder1SharePct as number) >= 90, String(e.holder1SharePct));
    assert.match(found[0]!.message, /Held longest by: GET \/reports: find/);
    await db.dropDatabase();
  } finally {
    w.stop();
    observer.detach();
    await client.close();
  }
});
