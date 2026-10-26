# Security

Krepis's security scope is deliberately narrow: **MongoDB-specific risks only**. It is not a general application security scanner and does not compete with one.

## Protections in the data layer

Built into the data layer, and on by default:

| Risk | Protection |
|---|---|
| **Operator injection** (`{"password": {"$ne": null}}` from a request body) | `strictInput` rejects operator objects where the schema expects a scalar. Operators must be built with explicit `op.*` helpers. |
| **Sensitive data leaking** | `.hidden()` fields are left out of Krepis reads unless selected by name. |
| **Regex denial of service** | `match.prefix()` / `match.contains()` escape user input and anchor where possible. |
| **Server-side JavaScript** | `$where`, `$function` and `$accumulator` are refused unless the object holding them is built with `op`. |
| **Unbounded reads used as denial of service** | `find` requires `limit` or an explicit cursor. |
| **Update pipelines from input** | An array update is refused unless built with `op.pipeline`. Inside a pipeline, input values must be wrapped in `{ $literal: value }`; Krepis cannot tell them apart from code there. |

What these do not cover:

- `strictInput` checks fields the schema declares as scalars or arrays of scalars. Values for `t.mixed()`, `t.map()` and object fields, and paths the schema does not declare, are passed through.
- Calls through `collection.raw()`, Mongoose or the plain driver bypass the data layer and get none of these checks.
- They work at the database layer. Validating input, authentication and access control remain your app's job.

**Prior art.** Mongoose's `sanitizeFilter` option (and the `mongo-sanitize` / `express-mongo-sanitize` packages) already strip or wrap `$`-prefixed keys from untrusted filters. `strictInput` differs by being schema-aware: it rejects an operator object only where the schema expects a scalar, so legitimate operators built with `op.*` still work. If you use Mongoose without the data layer, turn on its `sanitizeFilter`. Its limits show why `strictInput` is schema-aware: until Mongoose 6.13.9 / 7.8.9 / 8.22.1 / 9.1.6, `$nor` was missing from the operators it recursed into, so operators inside a `$nor` array passed through unsanitised (advisory GHSA-wpg9-53fq-2r8h). A list of operators to neutralise has to be complete; a check of what the schema allows does not.

## Krepis's own security

- **No values captured.** Fingerprints replace values with type tokens (see [Privacy](PRIVACY.md)).
- **No secrets in drill reports.** `krepis drill` redacts the secrets it is given from errors before reporting them.
- **Offline analysis.** `krepis analyze` reads capture files. It does not connect to your database.
- **Supply chain.** The release workflow publishes from CI with npm provenance. Runtime dependencies are kept minimal.

## Reporting a vulnerability

Report privately at [github.com/sameernair1993/krepis/security/advisories/new](https://github.com/sameernair1993/krepis/security/advisories/new). Do not open a public issue.
