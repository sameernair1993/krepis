# Vision

> Where the project is heading, not what exists today. For what works now, see the [Guide](GUIDE.md).

## The problem

MongoDB's success came from removing friction at the start: store whatever shape you have, no schema, no migrations. The cost of that ease is deferred, not removed.

1. **The engine is passive.** It observes every query and document but does almost nothing with that knowledge. Optimisation lives entirely in developers' heads.
2. **Advice without understanding.** Tooling such as the Performance Advisor and schema advisor recommends actions, but doesn't teach the performance model. Teams follow advice they can't evaluate.
3. **Relational designs in disguise.** Teams arriving from SQL model `orders.userId → users._id` without declaring it. MongoDB's own guidance for frequent `$lookup` use is to restructure the schema, which moves the engine's limitation onto the developer.
4. **Delayed punishment.** Mistakes surface at scale, long after the code that caused them, when fixing them is a migration rather than a refactor.
5. **Operational blind spots.** Connection exhaustion on Atlas is common, and teams patch it with custom cleanup logic that can make it worse.

## The intent

Krepis is a **data access layer for MongoDB (TypeScript/JavaScript) that also analyses how it is used**:

- It **understands the real schema and the real operations**: shapes, presence, references, query patterns, call sites, connection behaviour.
- It is **safe by default**: the naive path through the API is already a good path (batched relations, bounded reads, safe inputs).
- It **makes optimisation understandable**: every recommendation explains *why*, with evidence from your own workload.
- It **moves detection earlier**: development and CI, not production incidents.

## Who it is for

- **Node.js / TypeScript teams on MongoDB**, especially on Atlas, who have outgrown "it just works" and don't have a database specialist.
- **Engineering leads** who need to see what their services actually do to the database, across a fleet.
- **Teams on Mongoose** who want the analysis without a rewrite (observe mode).

## What Krepis is not

| Not | Why |
|---|---|
| A new database | It works with MongoDB as it is. |
| An auto-tuner | It never creates indexes or rewrites queries in production on its own. |
| A general security scanner | Security rules are MongoDB-specific only. Use dedicated tools for the rest. |
| A logging or APM product | It reports findings; it does not replace your monitoring stack. |
| A replacement for the driver's connection pool | The pool implements a cross-driver specification. Krepis diagnoses and configures it. |
| A cloud service | It runs locally and in your CI. Nothing is sent anywhere by default. |

## What success would look like

- A team installs observe mode and, within a day, finds problems they agree are real and worth fixing.
- A connection-exhaustion incident is explained by evidence, and custom cleanup code is deleted.
- A pull request that introduces an unindexed query shape is flagged before merge.
- A developer reads an explanation and understands *why*, not just *what*.

## Secondary benefit

With explicit, opt-in consent only, anonymised query fingerprints and shape statistics from real applications are exactly the workload data that research into better document-database engines lacks. This is never on by default (see [Privacy](PRIVACY.md)).
