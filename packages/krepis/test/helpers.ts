import { ObjectId, type Db } from 'mongodb';

// 27018, not 27017: a developer's own mongod usually owns 127.0.0.1:27017 and would win over a container's port
// mapping, silently running the suite (and its dropDatabase calls) against it. See CONTRIBUTING.md.
export const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';

export interface Seed {
  users: Array<{ _id: ObjectId; name: string; tenant: string }>;
  orders: Array<{ _id: ObjectId; userId: ObjectId; status: string; n: number }>;
}

/** 10 users; 30 orders round-robin over them, so any 10 consecutive orders touch all 10 users. */
export async function seed(db: Db): Promise<Seed> {
  await db.dropDatabase();
  const users = Array.from({ length: 10 }, (_, i) => ({ _id: new ObjectId(), name: `user${i}`, tenant: 't1' }));
  const orders = Array.from({ length: 30 }, (_, i) => ({
    _id: new ObjectId(),
    userId: users[i % 10]!._id,
    status: i % 3 === 0 ? 'open' : 'paid',
    n: i,
  }));
  const tags = Array.from({ length: 4 }, (_, i) => ({ _id: `tag${i}`, label: `Tag ${i}` }));
  await db.collection('users').insertMany(users);
  await db.collection('orders').insertMany(orders);
  await db.collection<{ _id: string; label: string }>('tags').insertMany(tags);
  await db.collection<{ _id: string; tagIds: string[] }>('posts').insertOne({ _id: 'p1', tagIds: ['tag0', 'tag1', 'tag3'] });
  return { users, orders };
}
