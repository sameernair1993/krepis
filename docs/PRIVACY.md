# Privacy

## Principles

- **Local by default.** Captures and reports stay on the machine or CI runner that produced them.
- **Shapes, not data.** Krepis records the structure of queries and documents, never their contents.
- **No telemetry.** Krepis does not phone home. There is no usage tracking.

## What is captured at runtime

| Captured | Example |
|---|---|
| Collection and operation | `orders`, `find` |
| Query fingerprint | `{ status: <string>, total: { $gte: <number> } }` |
| Timing and counts | duration, documents returned and examined |
| Context ID | an opaque per-request identifier |
| Call site (sampled) | `src/routes/orders.ts:42` |
| Pool events | created, checked out, waits, closures with reason |

## What is never captured

- Field **values** in filters, updates or documents
- Connection strings or credentials
- Request bodies, headers, user identifiers

## What analysis reads

During `krepis analyze`, `refs` and `infer`, the engine samples documents from a snapshot or secondary to compute statistics: presence rates, type distributions, value sketches, containment rates. **Only the statistics are persisted.** Sketches can't be reversed into the values that produced them, but they do reveal distributions (for example, that one value dominates a field). Treat reports as internal documents.

## Storage and retention

- Captures live in `.krepis/` by default (add it to `.gitignore`; `krepis init` does this).
- Segments rotate by size and are pruned by a retention setting (`retentionDays`, default 7): when a segment opens, expired `krepis-*.ndjson` files in the capture directory are deleted.
- Capture files contain shapes, fingerprints, counts, timings, finished findings, **context labels** (route patterns with id-like segments masked, or the label passed to `run()`, which is yours to keep free of personal data) and **call-site paths** from your source tree. A test asserts that no seeded value (names, ObjectIds, field values) reaches a capture.
- Fleet mode stores only per-instance pool counters in Redis, with a TTL.

## Opt-in sharing

A future, explicitly opt-in option may allow sharing **anonymised fingerprints and shape statistics** to support research into better document-database engines. It will be off by default, documented in full before release, and never enabled by an upgrade.
