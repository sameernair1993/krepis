# Security

Krepis's security scope is deliberately narrow: **MongoDB-specific risks only**. It is not a general application security scanner and does not compete with one.

## Protections by construction (data access layer)

Built into the data layer, and on by default:

| Risk | Protection |
|---|---|
| **Operator injection** (`{"password": {"$ne": null}}` from a request body) | `strictInput` rejects operator objects where the schema expects a scalar. Operators must be built with explicit `op.*` helpers. |
| **Sensitive data leaking** | `.hidden()` fields are never returned unless selected by name. |
| **Regex denial of service** | `match.prefix()` / `match.contains()` escape user input and anchor where possible. |
| **Server-side JavaScript** | `$where`, `$function` and `$accumulator` are refused unless the object holding them is built with `op`. |
| **Unbounded reads used as denial of service** | `find` requires `limit` or an explicit cursor. |
| **Update pipelines from input** | An array update is refused unless built with `op.pipeline`. Inside a pipeline, input values must be wrapped in `{ $literal: value }`; Krepis cannot tell them apart from code there. |

**Prior art.** Mongoose's `sanitizeFilter` option (and the `mongo-sanitize` / `express-mongo-sanitize` packages) already strip or wrap `$`-prefixed keys from untrusted filters. `strictInput` differs by being schema-aware: it rejects an operator object only where the schema expects a scalar, so legitimate operators built with `op.*` still work. Observe-mode users on Mongoose should be pointed to `sanitizeFilter` first. Its limits show why `strictInput` is schema-aware: until Mongoose 6.13.9 / 7.8.9 / 8.22.1 / 9.1.6, `$nor` was missing from the operators it recursed into, so operators inside a `$nor` array passed through unsanitised (advisory GHSA-wpg9-53fq-2r8h). A list of operators to neutralise has to be complete; a check of what the schema allows does not.

## Detections (planned)

Not built yet. These rules are designed for observe mode and CI:

| Rule | What it catches |
|---|---|
| `KR-S001` | A call site whose fingerprint changes from a scalar to an operator object for the same field: the signature of operator injection. In practice it fires in tests and CI (fuzzing, malformed fixtures), because capture is normally off or sampled in production |
| `KR-S002` | Server-side JavaScript operators in use |
| `KR-S003` | Unanchored `$regex` built from request input |
| `KR-S004` | Fields matching configured sensitive patterns returned by reads |

## Krepis's own security

- **No values captured.** Fingerprints replace values with type tokens (see [Privacy](PRIVACY.md)).
- **No secrets in drill reports.** `krepis drill` redacts the secrets it is given from errors before reporting them.
- **Offline analysis.** `krepis analyze` reads capture files. It does not connect to your database.
- **Supply chain.** The release workflow publishes from CI with npm provenance. Runtime dependencies are kept minimal.

## Reporting a vulnerability

Report privately via the repository's security advisory feature. Do not open a public issue. (Contact details to be added before the first release.)
