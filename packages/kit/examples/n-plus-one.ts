// Runnable example: `node examples/n-plus-one.ts` against a local MongoDB.
import { MongoClient } from 'mongodb';
import { formatFinding, observe } from '../src/index.ts';

const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true');
const krepis = observe(client, { onFinding: (f) => console.log(`\n${formatFinding(f)}\n`) });
await client.connect();
const db = client.db('krepis_example');

await db.dropDatabase();
const authors = await db.collection('authors').insertMany(
  Array.from({ length: 5 }, (_, i) => ({ name: `Author ${i}` })),
);
await db.collection('books').insertMany(
  Array.from({ length: 12 }, (_, i) => ({ title: `Book ${i}`, authorId: authors.insertedIds[i % 5] })),
);

async function listBooksWithAuthors() {
  const books = await db.collection('books').find({}).toArray();
  for (const book of books) {
    book.author = await db.collection('authors').findOne({ _id: book.authorId });
  }
  return books;
}

await krepis.run('GET /books', listBooksWithAuthors);
await db.dropDatabase();
await client.close();
