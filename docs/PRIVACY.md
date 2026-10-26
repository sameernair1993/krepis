# Privacy

## Principles

- **Local by default.** Captures and reports stay on the machine or CI runner that produced them.
- **Shapes, not data.** Krepis records the structure of queries and documents, never their contents.
- **No telemetry.** Krepis does not phone home. There is no usage tracking.

## What is captured at runtime

Observe mode, with capture on:

| Captured | Example |
|---|---|
| Collection and operation | `orders`, `find` |
| Query fingerprint | `{ status: <string>, total: { $gte: <number> } }` |
| Counts and timings per unit of work | queries, failures, total and slowest duration, documents returned |
| Unit-of-work label | `GET /orders/:id`, or the label passed to `run()` |
| Call sites, in findings | `src/routes/orders.ts:42` |

## What is never captured

- Field **values** in filters, updates or documents
- Connection strings or credentials
- Request bodies, headers, user identifiers

## What analysis reads

`krepis analyze` reads capture files only. It does not connect to your database.

## Storage and retention

- Captures live in `.krepis/` by default (add it to `.gitignore`; `krepis init` does this).
- Segments rotate by size and are pruned by a retention setting (`retentionDays`, default 7): when a segment opens, expired `krepis-*.ndjson` files in the capture directory are deleted.
- Capture files contain shapes, fingerprints, counts, timings, finished findings, **context labels** (route patterns with id-like segments masked, or the label passed to `run()`, which is yours to keep free of personal data) and **call-site paths** from your source tree. A test asserts that no seeded value (names, ObjectIds, field values) reaches a capture.
- Flight-recorder dumps (`IncidentMonitor`) hold client labels, server addresses, error codes and counts; never error messages, URIs or credentials. They are written only where you point `dumpDir`, or handed to your `onDump`.
