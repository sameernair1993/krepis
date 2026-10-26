/**
 * Atlas per-node limits, verified against the Atlas documentation on 2026-10-07. Always check the current docs:
 * these change. `rateLimitAlways`: the new-connection rate limit applies on every server version (M10/M20);
 * otherwise only from MongoDB 9.0.
 */
export const ATLAS_TIERS = {
  M10: { maxConnections: 1_500, newConnectionsPerSec: 15, rateLimitAlways: true },
  M20: { maxConnections: 3_000, newConnectionsPerSec: 15, rateLimitAlways: true },
  M30: { maxConnections: 3_000, newConnectionsPerSec: 24, rateLimitAlways: false },
  M40: { maxConnections: 6_000, newConnectionsPerSec: 85, rateLimitAlways: false },
  M50: { maxConnections: 16_000, newConnectionsPerSec: 170, rateLimitAlways: false },
  M60: { maxConnections: 32_000, newConnectionsPerSec: 320, rateLimitAlways: false },
} as const;

export type AtlasTier = keyof typeof ATLAS_TIERS;

/** Limits to check against: an Atlas tier, explicit numbers, or both (explicit numbers win). */
export interface DeploymentLimits {
  tier?: AtlasTier;
  maxConnectionsPerNode?: number;
  newConnectionsPerSecPerNode?: number;
  /** Data-bearing nodes each client connects to (a 3-member replica set is 3). Default 3. */
  nodes?: number;
}

export interface ResolvedLimits {
  maxConnectionsPerNode: number | undefined;
  newConnectionsPerSecPerNode: number | undefined;
  nodes: number;
}

export function resolveLimits(d: DeploymentLimits = {}): ResolvedLimits {
  const tier = d.tier ? ATLAS_TIERS[d.tier] : undefined;
  return {
    maxConnectionsPerNode: d.maxConnectionsPerNode ?? tier?.maxConnections,
    newConnectionsPerSecPerNode: d.newConnectionsPerSecPerNode ?? tier?.newConnectionsPerSec,
    nodes: d.nodes ?? 3,
  };
}
