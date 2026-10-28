import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MongoClient, type Db } from 'mongodb';
import Fastify from 'fastify';
import Koa from 'koa';
import Router from '@koa/router';
import { Hono } from 'hono';
import { observe, type Observer } from '../src/index.ts';
import { URI } from './helpers.ts';

let client: MongoClient;
let db: Db;

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10 });
  await client.connect();
  db = client.db('krepis_frameworks');
  await db.dropDatabase();
  await db.collection('users').insertMany(Array.from({ length: 10 }, (_, i) => ({ _id: i as never, name: `u${i}` })));
  await db.collection('orders').insertMany(Array.from({ length: 10 }, (_, i) => ({ status: 'paid', userId: i })));
});

after(async () => {
  await client.close();
});

/** An N+1: the user of every order, one query each. */
async function ordersWithUsers(status: string) {
  const orders = await db.collection('orders').find({ status }).toArray();
  for (const o of orders) await db.collection('users').findOne({ _id: o.userId });
  return orders.length;
}

async function withObserver(fn: (obs: Observer) => Promise<void>) {
  const obs = observe(client);
  try {
    await fn(obs);
  } finally {
    obs.detach();
  }
}

const labels = (obs: Observer) => obs.findings.filter((f) => f.rule === 'KR-P002').map((f) => f.context).sort();

test('W1 Fastify: route pattern labels, and the unit survives body parsing', async () => {
  await withObserver(async (obs) => {
    const app = Fastify();
    await app.register(obs.fastifyPlugin());
    app.get('/users/:id/orders', async () => ({ n: await ordersWithUsers('paid') }));
    app.post('/search', async (req) => ({ n: await ordersWithUsers((req.body as { status: string }).status) }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      assert.equal((await (await fetch(`${base}/users/42/orders?x=1`)).json() as { n: number }).n, 10);
      const res = await fetch(`${base}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'paid' }) });
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(labels(obs), ['GET /users/:id/orders', 'POST /search']);

      const { queries } = await obs.measure('fastify request', () => fetch(`${base}/users/1/orders`).then((r) => r.json()));
      assert.equal(queries.commands, 11);
    } finally {
      await app.close();
    }
  });
});

test('W2 Koa with @koa/router: route pattern labels', async () => {
  await withObserver(async (obs) => {
    const app = new Koa();
    app.use(obs.koaMiddleware());
    const router = new Router();
    router.get('/users/:id/orders', async (ctx) => {
      ctx.body = { n: await ordersWithUsers('paid') };
    });
    app.use(router.routes());
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal((await (await fetch(`${base}/users/7/orders`)).json() as { n: number }).n, 10);
      assert.deepEqual(labels(obs), ['GET /users/:id/orders']);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test('W3 Hono: route pattern labels, JSON bodies', async () => {
  await withObserver(async (obs) => {
    const app = new Hono();
    app.use(obs.honoMiddleware());
    app.get('/users/:id/orders', async (c) => c.json({ n: await ordersWithUsers('paid') }));
    app.post('/search', async (c) => c.json({ n: await ordersWithUsers((await c.req.json<{ status: string }>()).status) }));
    const res = await app.fetch(new Request('http://local/users/3/orders'));
    assert.equal((await res.json() as { n: number }).n, 10);
    await app.fetch(new Request('http://local/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'paid' }) }));
    assert.deepEqual(labels(obs), ['GET /users/:id/orders', 'POST /search']);
  });
});

test('W4 unsampled requests run untouched', async () => {
  const obs = observe(client, { sampleRate: 0 });
  try {
    const app = new Hono();
    app.use(obs.honoMiddleware());
    app.get('/x', async (c) => c.json({ n: await ordersWithUsers('paid') }));
    assert.equal(((await (await app.fetch(new Request('http://local/x'))).json()) as { n: number }).n, 10);
    assert.deepEqual(obs.findings, []);
  } finally {
    obs.detach();
  }
});

// The lookup a password-reset route makes with the token from the request; the token is not checked to be a string.
const byName = (name: unknown) => db.collection('users').findOne({ name });
const injected = JSON.stringify({ name: { $ne: null } });
const s001 = (obs: Observer) => obs.hazardFindings.filter((f) => f.rule === 'KR-S001').map((f) => `${f.context} ${f.input}`);

test('W5 request input reaches KR-S001 through each hook: one injected request is reported', async () => {
  // One observer per hook: a finding is reported once per query shape per observer.
  const reported = async (send: (obs: Observer) => Promise<void>) => {
    let out: string[] = [];
    await withObserver(async (obs) => {
      await send(obs);
      await new Promise((r) => setTimeout(r, 20));
      out = s001(obs);
    });
    return out;
  };

  assert.deepEqual(await reported(async (obs) => {
    const fastify = Fastify();
    await fastify.register(obs.fastifyPlugin());
    fastify.post('/fastify', async (req) => ({ found: Boolean(await byName((req.body as { name: unknown }).name)) }));
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    try {
      const base = `http://127.0.0.1:${(fastify.server.address() as AddressInfo).port}`;
      await fetch(`${base}/fastify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: injected });
    } finally {
      await fastify.close();
    }
  }), ['POST /fastify body']);

  assert.deepEqual(await reported(async (obs) => {
    const koa = new Koa();
    koa.use(obs.koaMiddleware());
    koa.use(async (ctx, next) => { // what a body parser does
      (ctx.request as { body?: unknown }).body = JSON.parse(injected);
      await next();
    });
    const router = new Router();
    router.post('/koa', async (ctx) => {
      ctx.body = { found: Boolean(await byName((ctx.request as { body?: { name: unknown } }).body!.name)) };
    });
    koa.use(router.routes());
    const server = koa.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/koa`, { method: 'POST' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  }), ['POST /koa body']);

  assert.deepEqual(await reported(async (obs) => {
    const hono = new Hono();
    hono.use(obs.honoMiddleware());
    hono.post('/hono', async (c) => c.json({ found: Boolean(await byName((await c.req.json<{ name: unknown }>()).name)) }));
    await hono.fetch(new Request('http://local/hono', { method: 'POST', headers: { 'content-type': 'application/json' }, body: injected }));
  }), ['POST /hono body']);

  // Express: body and query are set after the middleware, by the parsers; `?name[$ne]=` parses to an object (qs).
  for (const [path, part] of [['/express-body', 'body'], ['/express-query', 'query']] as const) {
    assert.deepEqual(await reported(async (obs) => {
      const handle = obs.middleware();
      const req: Record<string, unknown> = { method: 'POST', originalUrl: path };
      const res = new EventEmitter();
      await new Promise<void>((resolve) => {
        handle(req as never, res as never, async () => {
          req[part] = part === 'body' ? JSON.parse(injected) : { name: { $ne: '' } };
          await byName((req[part] as { name: unknown }).name);
          res.emit('finish');
          resolve();
        });
      });
    }), [`POST ${path} ${part}`]);
  }
});

test('W6 hazards: false leaves Hono\'s request untouched and reports nothing', async () => {
  const obs = observe(client, { hazards: false });
  try {
    const app = new Hono();
    app.use(obs.honoMiddleware());
    let own = false;
    app.post('/x', async (c) => {
      own = Object.hasOwn(c.req, 'json');
      return c.json({ found: Boolean(await byName((await c.req.json<{ name: unknown }>()).name)) });
    });
    await app.fetch(new Request('http://local/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: injected }));
    assert.equal(own, false);
    assert.deepEqual(obs.hazardFindings, []);
  } finally {
    obs.detach();
  }
});
