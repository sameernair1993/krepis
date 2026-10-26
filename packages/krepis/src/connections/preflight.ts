import * as mongodb from 'mongodb';
import { resolveLimits, type DeploymentLimits } from './limits.ts';
import type { ClientOptionsLike, ConnectionFinding } from './types.ts';

export interface PreflightInput {
  /** Client options as configured, or a client (its resolved `options` are read). */
  options?: ClientOptionsLike;
  client?: { options: ClientOptionsLike };
  /** The driver module in use, for feature detection. Default: the `mongodb` this package resolves. */
  driver?: { MongoErrorLabel?: Record<string, string> };
  deployment?: DeploymentLimits;
  fleet?: {
    /** Processes (pods, workers) running this configuration. Default 1. */
    instances?: number;
    /** Clients per process, e.g. one per tenant. Default 1. */
    pools?: number;
  };
}

const IDLE_CHURN_ERROR_MS = 60_000;
const IDLE_CHURN_WARN_MS = 300_000;

/** Monitoring sockets per client per node: the streaming protocol adds a dedicated round-trip-time socket. */
export function monitorsPerNode(mode: string | undefined): number {
  return mode === 'poll' ? 1 : 2;
}

/** Whether the driver keeps its pool on a network error while establishing a connection (driver 7.1+). */
export function driverHasBackpressure(driver: PreflightInput['driver']): boolean {
  return typeof driver?.MongoErrorLabel?.SystemOverloadedError === 'string';
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Static checks on client options and fleet arithmetic. Opens no connection. */
export function checkConnectionOptions(input: PreflightInput): ConnectionFinding[] {
  const o: ClientOptionsLike = { ...input.client?.options, ...input.options };
  const limits = resolveLimits(input.deployment);
  const instances = input.fleet?.instances ?? 1;
  const pools = input.fleet?.pools ?? 1;
  const minPool = o.minPoolSize ?? 0;
  const maxPool = o.maxPoolSize ?? 100;
  const maxIdle = o.maxIdleTimeMS ?? 0;
  const findings: ConnectionFinding[] = [];

  if (minPool > 0 && maxIdle > 0 && maxIdle < IDLE_CHURN_WARN_MS) {
    // Upper bound: each cycle also spends the connection setup time (measured ~10 ms locally, more with TLS).
    const perPoolNodeHour = (minPool * 3_600_000) / maxIdle;
    const fleetPerNodeSec = (perPoolNodeHour * pools * instances) / 3600;
    const rate = limits.newConnectionsPerSecPerNode;
    findings.push({
      rule: 'KR-C008',
      severity: maxIdle < IDLE_CHURN_ERROR_MS ? 'error' : 'warn',
      title: 'Idle re-login churn',
      message:
        `minPoolSize ${minPool} with maxIdleTimeMS ${maxIdle}: each idle connection is closed every ${maxIdle} ms and the pool `
        + `immediately opens and authenticates a replacement, with no traffic at all. That is up to ${Math.round(perPoolNodeHour)} logins `
        + `per hour per client per node; across ${pools} client(s) × ${instances} instance(s), ${round(fleetPerNodeSec)} new connections per second per node`
        + (rate ? ` (${Math.round((fleetPerNodeSec / rate) * 100)}% of the ${rate}/s limit)` : '')
        + '. During a cluster event these logins are what fail first.',
      fix: 'Set minPoolSize: 0 (connections then follow demand), or raise maxIdleTimeMS to at least several minutes.',
      evidence: {
        minPoolSize: minPool, maxIdleTimeMS: maxIdle, loginsPerHourPerClientPerNode: Math.round(perPoolNodeHour),
        pools, instances, fleetNewConnectionsPerSecPerNode: round(fleetPerNodeSec), rateLimitPerSec: rate ?? null,
      },
    });
  }

  if ((o.socketTimeoutMS ?? 0) > 0) {
    findings.push({
      rule: 'KR-C010',
      severity: 'warn',
      title: 'Socket timeout closes connections',
      message:
        `socketTimeoutMS ${o.socketTimeoutMS}: any operation slower than that is abandoned by closing its connection, and the next `
        + 'operation opens and authenticates a new one. When the cluster slows down, every slow operation becomes a reconnect, '
        + 'adding login load exactly when the cluster can least take it.',
      fix: 'Set socketTimeoutMS: 0 and bound operations with maxTimeMS, which the server enforces without closing the connection.',
      evidence: { socketTimeoutMS: o.socketTimeoutMS ?? 0 },
    });
  }

  if (!o.appName) {
    findings.push({
      rule: 'KR-C011',
      severity: 'warn',
      title: 'No appName',
      message: 'Connections carry no appName, so Atlas cannot attribute connections or failed logins to this service during an incident.',
      fix: 'Set a unique appName per service (and per deployment, if several share a cluster).',
      evidence: { appName: null },
    });
  }

  if (!driverHasBackpressure(input.driver ?? mongodb)) {
    findings.push({
      rule: 'KR-C012',
      severity: 'warn',
      title: 'Driver without connection backpressure',
      message:
        'This driver clears the whole pool when opening a connection fails at the network level, for example when an overloaded '
        + 'or rate-limited server drops it. In-flight operations fail and every connection is re-established at once, which turns '
        + 'connection drops into a reconnect herd. Driver 7.1 and later keep the pool and retry with backoff instead.',
      fix: 'Use mongodb driver 7.1 or later (Mongoose 9, or Krepis with driver 7).',
      evidence: { systemOverloadedLabel: false },
    });
  }

  const limit = limits.maxConnectionsPerNode;
  if (limit) {
    const monitors = monitorsPerNode(o.serverMonitoringMode);
    const idlePerNode = pools * instances * (minPool + monitors);
    const peakPerNode = pools * instances * (maxPool + monitors);
    const evidence = { pools, instances, minPoolSize: minPool, maxPoolSize: maxPool, monitorsPerNode: monitors, idlePerNode, peakPerNode, maxConnectionsPerNode: limit };
    if (pools > 1 && idlePerNode >= 0.8 * limit) {
      findings.push({
        rule: 'KR-C007', severity: 'error', title: 'Tenant pools fill the node while idle',
        message: `${pools} clients × ${instances} instances × (${minPool} pooled + ${monitors} monitoring) = ${idlePerNode} connections per node held open with no traffic, against a limit of ${limit}.`,
        fix: "minPoolSize: 0, serverMonitoringMode: 'poll', and evict idle tenants' clients (TenantPools does all three).",
        evidence,
      });
    } else if (peakPerNode > limit) {
      findings.push({
        rule: pools > 1 ? 'KR-C007' : 'KR-C003', severity: pools > 1 ? 'warn' : 'error', title: 'Fleet demand over the node limit',
        message: `${pools} client(s) × ${instances} instance(s) × (${maxPool} max pooled + ${monitors} monitoring) = ${peakPerNode} connections per node at peak, against a limit of ${limit}.`,
        fix: 'Size maxPoolSize from measured peak checkouts, and cap the number of live clients per process.',
        evidence,
      });
    }
  }
  return findings;
}
