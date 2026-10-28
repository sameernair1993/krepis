export type ConnectionRuleId =
  | 'KR-C001' | 'KR-C002' | 'KR-C003' | 'KR-C004' | 'KR-C005' | 'KR-C006' | 'KR-C007' | 'KR-C008' | 'KR-C009' | 'KR-C010' | 'KR-C011' | 'KR-C012'
  | 'KR-I001' | 'KR-I002';
export type Severity = 'error' | 'warn' | 'info';

/** A finding about connection behaviour. Every number in `message` is also in `evidence`. */
export interface ConnectionFinding {
  rule: ConnectionRuleId;
  severity: Severity;
  title: string;
  message: string;
  fix: string;
  /** Server address, for runtime findings. */
  address?: string;
  /** The watched client's label (a tenant key under TenantPools), for findings about one client. */
  client?: string;
  /** Every client involved, for findings about several (KR-I002). */
  clients?: string[];
  evidence: Record<string, string | number | boolean | null>;
}

/**
 * Names what ran on a connection, for KR-C006. `observer.holders()` from `@sameernair/krepis-kit` implements it.
 * Called at every check-in; returns the value-free name of the last command recorded on that connection, once.
 */
export interface ConnectionHolders {
  heldBy(address: string, connectionId: number): string | undefined;
}

/** The subset of resolved client options the rules read. `MongoClient.options` satisfies it. */
export interface ClientOptionsLike {
  minPoolSize?: number;
  maxPoolSize?: number;
  maxIdleTimeMS?: number;
  socketTimeoutMS?: number;
  appName?: string;
  serverMonitoringMode?: string;
  maxConnecting?: number;
}

export function formatConnectionFinding(f: ConnectionFinding): string {
  const where = (f.client ? ` {${f.client}}` : '') + (f.address ? ` [${f.address}]` : '');
  return `${f.rule} ${f.severity.toUpperCase()} ${f.title}${where}\n  ${f.message}\n  Fix: ${f.fix}`;
}
