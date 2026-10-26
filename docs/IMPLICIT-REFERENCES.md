# Implicit references

> Design. Not built yet: nothing on this page exists in the packages today.

## The problem

Applications often model relationships the SQL way: `orders.userId` holds the `_id` of a document in `users`. MongoDB knows nothing about this. Nothing declares the relationship, enforces it, or indexes it, so it shows up indirectly as N+1 patterns, slow `$lookup` stages and dangling data.

Krepis detects these references, maps them, and recommends what to do about each one.

## Detection signals (weakest to strongest)

| Signal | How | Strength |
|---|---|---|
| **Declared** | Mongoose `ref`, or Krepis `ref()` | Certain, when present |
| **Naming** | `userId`, `user_id`, `authorId` → candidate collections (with pluralisation) | Generates candidates only |
| **Value containment** | Sample values in the source field; measure the fraction found as `_id` in the candidate collection (batched `$in`) | Strong for ObjectIds and UUIDs |
| **Timestamp direction** | ObjectIds embed creation time; parents usually predate children | Confirms direction |
| **Runtime co-access** | The app reads a parent, then queries the candidate collection by the stored ID within the same context | Confirms by usage |

Signals combine into a confidence score. A reference is **reported** at medium confidence and **recommended for declaration** at high confidence.

## Shapes handled

- **Scalar:** `userId: ObjectId`
- **Arrays:** `tagIds: [ObjectId]` (many-to-many)
- **Nested:** `customer.accountId`
- **Polymorphic:** `refType` + `refId`; containment is measured per discriminator value
- **Non-ObjectId keys:** UUIDs and string keys with high entropy. Small integers and short strings are **excluded by default**: `status: 1` would "match" an `_id` of 1 by coincidence

## Outputs

- **Relationship map:** collections and references, with cardinality, fan-out distribution and containment rate. Rendered as text, JSON and a Mermaid diagram.
- **Findings:** `KR-R001` to `KR-R005` (see [Rules](RULES.md)).
- **Recommendations:**
  - Index the referencing field if queries filter on it (`KR-R002`).
  - Embed a subset of fields when parent and child are almost always read together, fan-out is low and the child changes rarely (`KR-R004`).
  - Keep the reference when data is accessed independently or fan-out is unbounded (`KR-R005`).
  - Investigate orphans when containment is below 100% (`KR-R003`).

Each recommendation states the observed access ratio that drove it, so the developer can disagree with evidence in hand.

## Cost controls

- Containment checks run only against a **snapshot or secondary**, never a busy primary.
- Sampling is bounded per field (default a few thousand values) with fixed seeds.
- Checks are batched; the total query budget per run is configurable.
- Only statistics are persisted, never sampled values.
