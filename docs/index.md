---
layout: home
title: Krepis
titleTemplate: A typed data layer for MongoDB
hero:
  name: Krepis
  text: A typed data layer for MongoDB
  tagline: For Node.js and TypeScript. Safe defaults over the official driver, and an analyser that looks for N+1 queries in the app you already have.
  actions:
    - theme: brand
      text: Read the guide
      link: /GUIDE
    - theme: alt
      text: View on GitHub
      link: https://github.com/sameernair1993/krepis
features:
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
    title: Typed against your schema
    details: Filters, updates, projections and aggregation stages are checked at compile time, written in MongoDB's own syntax.
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
    title: Safe defaults
    details: Operator objects from request input are refused, reads need a limit, and hidden fields stay out of results unless selected.
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>'
    title: Relations in batched reads
    details: include loads each relation with one read per level, rather than one read per document.
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
    title: An N+1 analyser
    details: krepis-kit attaches to an existing driver or Mongoose client and reports N+1 patterns, with the evidence behind each one.
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>'
    title: Connection helpers
    details: Per-tenant client pools with a login circuit breaker, and drills that rehearse connection incidents in a throwaway container.
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
    title: Shapes, not values
    details: Captures record query shapes and counts, never the values in them, and stay on your machine.
---

<section class="kr-section">

## Two packages

<p class="kr-lead">Use the analyser on its own, the data layer on its own, or both.</p>

<div class="kr-grid">
  <div class="kr-card">
    <h3>krepis</h3>
    <p class="kr-role">The data layer</p>
    <p>Typed collections over the official MongoDB driver, for new code or for moving off Mongoose one collection at a time.</p>
    <ul>
      <li>Schemas, typed queries and updates, <code>include</code>, aggregation, transactions</li>
      <li><code>fromMongoose</code> to share an existing Mongoose connection</li>
      <li><code>@sameernair/krepis/connections</code> for per-tenant pools and connection checks</li>
    </ul>
    <a class="kr-more" href="GUIDE.html#the-data-layer">Data layer guide →</a>
  </div>
  <div class="kr-card">
    <h3>krepis-kit</h3>
    <p class="kr-role">The analyser and CLI</p>
    <p>Attach it to the client your app already has. It records query shapes per request, and the CLI reports N+1 patterns from them.</p>
    <ul>
      <li>Express middleware and an Apollo Server plugin</li>
      <li><code>krepis analyze</code>, with <code>--fail</code> for CI</li>
      <li><code>krepis drill</code> to rehearse connection incidents</li>
    </ul>
    <a class="kr-more" href="GUIDE.html#the-analyser">Analyser guide →</a>
  </div>
</div>

</section>

<section class="kr-section">

## A first look

<p class="kr-lead">Short examples. The <a href="GUIDE.html">guide</a> covers each part properly.</p>

::: code-group

```ts [Data layer]
import { MongoClient } from 'mongodb';
import { createDal, schema, t, op } from '@sameernair/krepis';

const client = new MongoClient(process.env.MONGODB_URI!);
const dal = createDal(client, { dbName: 'shop' });

const Users = dal.collection('users', schema({
  email: t.string().lowercase().trim(),
  passwordHash: t.string().hidden(),   // left out of reads unless selected
  plan: t.enum(['free', 'pro']),       // checked on every write
}));

// Plain MongoDB filter syntax, typed from the schema.
const pro = await Users.find({ plan: op.in(['pro']) }).limit(50).toArray();

// { "$ne": null } arriving from a request body throws KrepisInputError
// instead of matching every document.
await Users.findOne({ email: req.body.email });
```

```ts [Analyser]
import { observe } from '@sameernair/krepis-kit';

// Attach before client.connect(). With Mongoose: mongoose.connection.getClient().
const observer = observe(client, { capture: true });

app.use(observer.middleware());   // Express: one unit of work per request
// or: new ApolloServer({ plugins: [observer.apolloPlugin()] })
```

```bash [CLI]
npx krepis init            # adds .krepis/ to .gitignore
npm test                   # run your app or tests with capture on
npx krepis analyze         # N+1 patterns, with call sites and a suggested fix
npx krepis analyze --fail  # exit 1 when one is found, for CI
```

:::

</section>

<section class="kr-section">

## Where it stands

<p class="kr-lead">Krepis is new. This is an honest summary; each documentation page says what exists today.</p>

<div class="kr-status">
  <div class="kr-card is-done">
    <h3>Built and tested</h3>
    <p>The data layer, <code>@sameernair/krepis/connections</code>, and the analyser, CLI and drills. Tested against drivers 4.17 to 7 and Mongoose 6 to 9. Published to npm as alpha releases: see <a href="GUIDE.html#install">Install</a>.</p>
  </div>
  <div class="kr-card is-next">
    <h3>Not yet</h3>
    <p>Used in production. APIs may change before v0.1.</p>
  </div>
  <div class="kr-card is-design">
    <h3>Design only</h3>
    <p>Parts of <a href="ARCHITECTURE.html">Architecture</a>, <a href="RULES.html">Rules</a> and <a href="IMPLICIT-REFERENCES.html">Implicit references</a> describe planned work, and are marked as such.</p>
  </div>
</div>

</section>

<section class="kr-section kr-name">

<img src="/logo.svg" alt="" />

<p><strong>κρηπίς (krepis)</strong> is the stepped stone platform a Greek temple stands on. The aim is the same: a plain, solid base for the data code above it.</p>

<p>Feedback and issues are welcome on <a href="https://github.com/sameernair1993/krepis/issues">GitHub</a>.</p>

</section>
