# Contributing

> Krepis is in alpha: built, tested and published to npm, not yet used in production.

## Prerequisites

- Node.js 22.18+ for development (the tests run `.ts` files directly); the published package supports 20.19+
- pnpm 10 (`npx -y pnpm@10` if your global pnpm is older; the lockfile and store are v10)
- Docker (tests run against real MongoDB)
- Rust (stable) only if and when the engine is ported

## Setup

```bash
pnpm install
pnpm build          # krepis, then krepis-kit (dependency order)
pnpm test           # one package at a time: they share one mongod
```

Two published packages:

- `packages/krepis`, npm `@sameernair/krepis`: the data layer and `@sameernair/krepis/connections`.
- `packages/kit`, npm `@sameernair/krepis-kit`: the analyser, CLI and drills. It depends on `@sameernair/krepis` (`workspace:^`).

In development, kit resolves `krepis` to its TypeScript source through the `krepis-source` export condition (`--conditions=krepis-source` in kit's test script, `customConditions` in its `tsconfig.json`), so kit's tests never need a `krepis` build. Kit's build configs reset `customConditions` to `[]` so the build compiles against `krepis`'s declarations, as consumers do; build `krepis` first. **Publish kit with pnpm only:** `npm pack` would ship `workspace:^` verbatim, and `prepublishOnly` refuses other clients.

## Repository layout

See [Architecture → Monorepo layout](docs/ARCHITECTURE.md#monorepo-layout).

## Testing rules

1. **Test against real MongoDB, not mocks.** Integration tests run against a replica set in Docker. Driver behaviour (events, pooling, errors) is never mocked; mocked tests have missed real bugs before.

   ```sh
   docker run -d --rm --name krepis-mongo --cpus 1 -p 27018:27018 mongo:8.0 --replSet rs0 --port 27018 --setParameter enableTestCommands=1
   docker exec krepis-mongo mongosh --port 27018 --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27018"}]})'
   ```

   `enableTestCommands` lets the transaction tests inject server errors with the `failCommand` fail point. Never enable it on a server holding real data. The standalone-server test (T9) runs only when `KREPIS_TEST_STANDALONE_URI` points at a non-replica-set server, for example `docker run -d --rm --name krepis-mongo-solo --cpus 1 -p 27020:27017 mongo:8.0` with `KREPIS_TEST_STANDALONE_URI=mongodb://127.0.0.1:27020`.

   The suite defaults to `127.0.0.1:27018` (override with `KREPIS_TEST_URI`), **not** 27017. A locally installed `mongod` normally binds `127.0.0.1:27017`, and a specific-address bind wins over a container's wildcard port mapping, so `localhost:27017` silently reaches your own server instead of the container, and the suite's `dropDatabase` calls run there. mongod runs on 27018 *inside* the container too, so the replica-set member host is `localhost:27018`: a client without `directConnection` follows the member host during discovery, and a member host of `localhost:27017` would redirect it to your own server even when the URI says 27018. This happened during development: all results before 2026-10-05 were measured against a Homebrew MongoDB 7.0.2 replica set, not the intended `mongo:8.0`.
   The connection tests (`test/connections.test.ts`, `test/incidents.test.ts`) need a second server with **authentication and the connection-establishment rate limiter on**, standing in for an Atlas M10 node (15 new connections per second). Without it those live tests skip.

   ```sh
   docker run -d --rm --name krepis-mongo-auth --cpus 1 -p 27019:27017 \
     -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=rootpw mongo:8.0 \
     --setParameter ingressConnectionEstablishmentRateLimiterEnabled=true \
     --setParameter ingressConnectionEstablishmentRatePerSec=15 \
     --setParameter ingressConnectionEstablishmentBurstCapacitySecs=1 \
     --setParameter ingressConnectionEstablishmentMaxQueueDepth=30
   ```

   Override the URI with `KREPIS_AUTH_URI` (default `mongodb://root:rootpw@127.0.0.1:27019/?authSource=admin`). The rate limiter needs mongod 8.0.12 or later. Measure on server counters (`serverStatus` SCRAM `authenticate`, `connections`), never on app-side counts. The drill starts its own containers, so it needs only docker. Its live tests run with `KREPIS_DRILL_DOCKER=1` (about two minutes: a standalone rig, then a three-member replica set); otherwise they skip. Drill and the analyser live in `packages/kit`; a full run of a config is `node --conditions=krepis-source src/cli.ts drill <config>` there.
2. **Known-answer fixtures for statistics.** Every statistic (presence, containment, skew) is tested on datasets where the correct answer is known in advance, including small-sample cases.
3. **Every rule needs positive and negative fixtures.**
4. **Overhead benchmarks run in CI.** A change that pushes collector overhead past the budget fails the build.
5. **Determinism.** Analysis tests assert identical output for identical inputs.
6. **Test every supported driver major.** Anything that touches driver internals (the gate, the optimiser) runs in kit's `test/legacyDrivers.test.ts` against real mongodb 4.17.2, 5.9.2 and 6.0.0, installed as aliased dev dependencies (`mongodb-v4`, `mongodb-v5`, `mongodb-v6`), as well as the current 7.x. The peer range is the oldest version tested there. Seed data with the v7 client: bson 5 and later rejects BSON values created by a different bson major.

   The DAL has its own matrix in `packages/krepis/test/dalMatrix.test.ts`: every driver above plus `mongodb-v6-latest` and `mongodb-next` (the driver's `nightly` build, the earliest signal of the next major), and `fromMongoose` on `mongoose-v6`, `-v7`, `-v8` and the current 9.x. Refresh the nightly before a release with `npx -y pnpm@10 add -D mongodb-next@npm:mongodb@nightly`. For the server matrix, run the suite with the container above on `mongo:7.0`, `mongo:8.0` and `mongo:9.0`.
7. **Check the package, not just the source.** In each package, `npm run build` emits `dist/` (shared script: `scripts/build-package.mjs`); `npm run check:package` runs arethetypeswrong on the packed tarball; `npm run check:dist` rebuilds and checks the built package itself (one implementation per subpath, `import` and `require` return the same objects, a size budget). Transpile-only consumers (swc, esbuild) never typecheck, so verify a migration by running `tsc` on the consumer as well as its tests, and confirm by coverage that the replacement code actually ran.

## Adding a rule

Follow the checklist in [Rules → Adding a rule](docs/RULES.md#adding-a-rule).

## Commits and releases

- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck, both test suites against MongoDB containers, and the package checks on every pull request, and on every push to main through the release workflow.
- Releases ([.github/workflows/release.yml](.github/workflows/release.yml)) are automatic. Every push to main runs CI. If CI passes and a published file changed since the latest `vX.Y.Z` tag, the workflow:
  - picks the next version after that tag (`0.1.0-alpha.2` → `0.1.0-alpha.3`, `0.1.0` → `0.1.1`);
  - packs with pnpm;
  - publishes `@sameernair/krepis` and `@sameernair/krepis-kit` to npmjs, and `@<owner>/krepis` and `@<owner>/krepis-kit` to GitHub Packages;
  - creates the tag.

  Published files are package sources, package.json, README, LICENSE and the build script. Changes to tests, benchmarks, docs or CI don't release.

  To choose a milestone (`0.1.0`, `0.2.0-beta.0`, `1.0.0`), set both package.json versions to it; a version higher than the latest tag is used as is. The workflow doesn't commit versions back, so package.json can lag behind npm; the tags are the record.

  A prerelease goes to the dist-tag named by its first identifier (`alpha`). A failed publish leaves no tag, so the next push to main retries it. A manual run is a dry run unless unticked. npm provenance is added once the repository is public.
- Native binaries, if any, are built only in CI.

## Code of conduct

This applies everywhere the project is discussed or worked on: issues, pull requests, reviews, discussions, and any other channel the project uses, as well as to anyone representing the project elsewhere.

**Expected:**

- Be respectful and patient, including with people new to MongoDB, TypeScript or open source.
- Criticise code, designs and measurements, not people. Say what is wrong and, where you can, what would fix it.
- Back claims with evidence (a test, a measurement, a reproduction), and accept evidence that contradicts your own.
- Assume good faith, and ask before assuming someone meant harm.
- Credit other people's work and ideas.

**Not accepted:**

- Harassment, insults, threats, or demeaning comments, including about anyone's identity, background, experience or appearance.
- Sexual language or imagery, and unwelcome attention of any kind.
- Publishing someone's private information (an address, an email, credentials, data from a database) without their permission.
- Repeatedly disrupting discussions or pull requests after being asked to stop.

**Reporting.** Report a problem by [opening an issue](https://github.com/sameernair1993/krepis/issues/new). Issues are public, so describe what happened without repeating anyone's private information. Security vulnerabilities go through [Security → Reporting a vulnerability](docs/SECURITY.md#reporting-a-vulnerability) instead.

**Enforcement.** The maintainer reviews every report and responds as fits what happened, from a private note to editing or removing comments and code, a temporary ban, or a permanent ban from the project's spaces. Anyone asked to stop is expected to stop immediately.
