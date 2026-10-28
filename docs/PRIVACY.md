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

## Opt-in rules that read more

These read values in memory, inside your process, and record names only:

- **`explain: true`** sends a copy of each new query shape's command, values included, back to the same server as an `explain`. The command is held only until it is sent; only stage and index names are kept from the reply.
- **Hazard rules.** By default (KR-S001, KR-S002), Krepis looks at filter values to tell a plain value from an operator object, and at command keys for server-side JavaScript. When a filter field holds an operator object, it compares it with the operator objects in the request's parsed input (body, query string, route parameters, GraphQL variables), which the framework hooks point it to; the input is read in memory and released when the unit of work ends. **`hazards: true`** also checks regular expressions and decodes the first document of the first reply for each query shape to list its field names (for KR-S004). Findings record field names, operator names, call sites and which part of the request an operator came from. Neither the values, the input nor the decoded document are kept. `hazards: false` turns all of this off.

## What analysis reads

`krepis analyze` reads capture files only. It does not connect to your database.

## Storage and retention

- Captures live in `.krepis/` by default (add it to `.gitignore`; `krepis init` does this).
- Segments rotate by size and are pruned by a retention setting (`retentionDays`, default 7): when a segment opens, expired `krepis-*.ndjson` files in the capture directory are deleted.
- Capture files contain shapes, fingerprints, counts, timings, finished findings, **context labels** (route patterns with id-like segments masked, or the label passed to `run()`, which is yours to keep free of personal data) and **call-site paths** from your source tree. A test asserts that no seeded value (names, ObjectIds, field values) reaches a capture.
- Flight-recorder dumps (`IncidentMonitor`) hold client labels, server addresses, error codes and counts; never error messages, URIs or credentials. They are written only where you point `dumpDir`, or handed to your `onDump`.
- KR-C006 with `observer.holders()` names queries by unit-of-work label, namespace and fingerprint, and holds the name of each connection's last recorded command in memory until the connection is checked in.
