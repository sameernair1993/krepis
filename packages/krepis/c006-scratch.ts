import { MongoClient } from 'mongodb';
import { watchConnections } from '/Users/sameernair/Documents/Personal/V2/latest/krepis/packages/krepis/src/connections/index.ts';

const URI = 'mongodb://127.0.0.1:27018/?directConnection=true';
const client = new MongoClient(URI, { maxPoolSize: 2 });
const w = watchConnections(client, { checkoutWaits: true });
await client.connect();
const coll = client.db('krepis_c006_scratch').collection('slow');
await coll.deleteMany({});
await coll.insertOne({ _id: 1 } as never);
await Promise.all([coll.findOne({ _id: 1 } as never), coll.findOne({ _id: 1 } as never)]);
await Promise.all(Array.from({ length: 8 }, () => coll.findOne({ $where: 'sleep(300) || true' })));
for (const f of w.findings) console.log(JSON.stringify(f, null, 1));
await client.db('krepis_c006_scratch').dropDatabase();
w.stop();
await client.close();
