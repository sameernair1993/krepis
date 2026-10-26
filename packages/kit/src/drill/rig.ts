import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import * as mongodb from 'mongodb';
import type { CounterSample } from './judge.ts';

/** Commands the faults apply to. The drill's own connection never issues these. */
export const FAULTED_COMMANDS = ['find', 'getMore', 'aggregate', 'count', 'distinct', 'insert', 'update', 'delete', 'findAndModify', 'ping'];

export interface DockerServerOptions {
  image: string;
  rateLimitPerSec: number;
  cpus: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export function secret(): string {
  return randomBytes(18).toString('base64url');
}

function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim().split('\n').slice(-3).join(' ');
        reject(new Error(`docker ${args[0]} failed: ${detail}`));
      } else resolve(String(stdout).trim());
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A disposable, authenticated, rate-limited mongod in docker, with failpoints enabled. */
export class DockerServer {
  readonly name: string;
  readonly port: number;
  readonly adminPassword: string;
  private readonly rateLimitPerSec: number;
  private admin: mongodb.MongoClient;
  private stopped = false;

  private constructor(name: string, port: number, adminPassword: string, rateLimitPerSec: number) {
    this.name = name;
    this.port = port;
    this.adminPassword = adminPassword;
    this.rateLimitPerSec = rateLimitPerSec;
    this.admin = this.newAdmin();
  }

  static async start(o: DockerServerOptions): Promise<DockerServer> {
    try {
      await docker(['version', '--format', '{{.Server.Version}}'], 15_000);
    } catch {
      throw new Error('krepis drill needs a running docker daemon (`docker version` failed).');
    }
    const port = await freePort();
    const name = `krepis-drill-${randomBytes(4).toString('hex')}`;
    const server = new DockerServer(name, port, secret(), o.rateLimitPerSec);
    const params = ['--setParameter', 'enableTestCommands=1'];
    if (o.rateLimitPerSec > 0) {
      params.push(
        '--setParameter', 'ingressConnectionEstablishmentRateLimiterEnabled=true',
        '--setParameter', `ingressConnectionEstablishmentRatePerSec=${o.rateLimitPerSec}`,
        '--setParameter', 'ingressConnectionEstablishmentBurstCapacitySecs=1',
        '--setParameter', `ingressConnectionEstablishmentMaxQueueDepth=${o.rateLimitPerSec * 2}`,
      );
    }
    o.log?.(`starting ${o.image} as ${name} on 127.0.0.1:${port}`);
    await docker([
      'run', '-d', '--rm', '--name', name, '--label', 'krepis.drill=1', '--cpus', String(o.cpus),
      '-p', `127.0.0.1:${port}:27017`,
      '-e', 'MONGO_INITDB_ROOT_USERNAME=krepis_drill_admin', '-e', `MONGO_INITDB_ROOT_PASSWORD=${server.adminPassword}`,
      o.image, ...params,
    ], 300_000);
    try {
      await server.waitReady(120_000, o.signal);
    } catch (error) {
      await server.stop();
      throw error;
    }
    return server;
  }

  private newAdmin(): mongodb.MongoClient {
    return new mongodb.MongoClient(`mongodb://krepis_drill_admin:${encodeURIComponent(this.adminPassword)}@127.0.0.1:${this.port}/?authSource=admin`, {
      maxPoolSize: 2, minPoolSize: 0, serverMonitoringMode: 'poll', serverSelectionTimeoutMS: 2_000, connectTimeoutMS: 2_000, appName: 'krepis-drill',
    } as mongodb.MongoClientOptions);
  }

  uri(user: string, password: string): string {
    return `mongodb://${user}:${encodeURIComponent(password)}@127.0.0.1:${this.port}/?authSource=admin`;
  }

  /** Waits until the server accepts an authenticated command. */
  async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.admin.db('admin').command({ hello: 1 });
        return;
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`the drill server did not become ready within ${timeoutMs / 1000} s: ${(error as Error).name}`);
        // A client whose first connect failed stays closed; start over with a fresh one.
        await this.admin.close().catch(() => {});
        this.admin = this.newAdmin();
      }
      await sleep(250, signal);
    }
  }

  async createUser(user: string, password: string, database: string): Promise<void> {
    await this.admin.db('admin').command({ createUser: user, pwd: password, roles: [{ role: 'readWrite', db: database }] });
  }

  async setPassword(user: string, password: string): Promise<void> {
    await this.admin.db('admin').command({ updateUser: user, pwd: password });
  }

  async failpoint(mode: 'alwaysOn' | 'off', data?: Record<string, unknown>): Promise<void> {
    await this.admin.db('admin').command({ configureFailPoint: 'failCommand', mode, ...(data ? { data: { failCommands: FAULTED_COMMANDS, ...data } } : {}) });
  }

  /**
   * Opens the admin pool to its full size, so the drill's own commands never need a new connection while
   * `admission('overload')` is refusing them. Pool connections never idle out (`maxIdleTimeMS` 0).
   */
  async warmAdmin(): Promise<void> {
    await Promise.all([1, 2].map(() => this.admin.db('admin').command({ hello: 1 })));
  }

  /**
   * `overload` admits one new connection per second with a queue of one, so the server refuses most new
   * connections and keeps established ones, as a node at its connection limit does. A burst under 1 s
   * would disable limiting entirely, so 1 s is the floor. `normal` restores the configured limiter.
   */
  async admission(mode: 'overload' | 'normal'): Promise<void> {
    const r = this.rateLimitPerSec;
    const set = mode === 'overload'
      ? { ingressConnectionEstablishmentRateLimiterEnabled: true, ingressConnectionEstablishmentRatePerSec: 1, ingressConnectionEstablishmentBurstCapacitySecs: 1, ingressConnectionEstablishmentMaxQueueDepth: 1 }
      : r > 0
        ? { ingressConnectionEstablishmentRateLimiterEnabled: true, ingressConnectionEstablishmentRatePerSec: r, ingressConnectionEstablishmentBurstCapacitySecs: 1, ingressConnectionEstablishmentMaxQueueDepth: r * 2 }
        : { ingressConnectionEstablishmentRateLimiterEnabled: false };
    await this.admin.db('admin').command({ setParameter: 1, ...set });
  }

  /** Restarts the container; resolves once the server accepts again. */
  async restart(signal?: AbortSignal): Promise<void> {
    await docker(['restart', '-t', '2', this.name], 120_000);
    await this.waitReady(120_000, signal);
  }

  async sample(): Promise<CounterSample | undefined> {
    try {
      const s = await this.admin.db('admin').command({ serverStatus: 1, metrics: 0, wiredTiger: 0, locks: 0, opLatencies: 0, tcmalloc: 0, repl: 0 });
      const auth = s.security?.authentication?.mechanisms?.['SCRAM-SHA-256']?.authenticate ?? {};
      const c = s.connections ?? {};
      return {
        t: Date.now(),
        received: Number(auth.received ?? 0),
        successful: Number(auth.successful ?? 0),
        created: Number(c.totalCreated ?? 0),
        rejected: Number(c.establishmentRateLimit?.rejected ?? 0),
        queued: Number(c.queuedForEstablishment ?? 0),
      };
    } catch {
      return undefined;
    }
  }

  /** Closes the rig's own clients and, unless `remove` is false (`--keep`), removes the container. */
  async stop(remove = true): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.admin.close().catch(() => {});
    if (remove) await docker(['rm', '-f', '-v', this.name], 60_000).catch(() => {});
  }
}

export interface DockerReplicaSetOptions extends DockerServerOptions {
  /** Members of the set. Default 3. */
  members?: number;
}

interface MemberCounters {
  last: CounterSample | undefined;
  total: CounterSample;
}

const REPLICA_SET = 'rs0';
const ADMIN_USER = 'krepis_drill_admin';

/**
 * A disposable three-member replica set in one container: one `mongod` per member, each on a port published under
 * the same number, so the member hosts (`127.0.0.1:<port>`) resolve both inside the container and from the host.
 * Members share a keyfile, enforce authentication and run the same establishment rate limiter as `DockerServer`.
 */
export class DockerReplicaSet {
  readonly name: string;
  readonly ports: number[];
  readonly adminPassword: string;
  private admin: mongodb.MongoClient;
  private readonly members: mongodb.MongoClient[];
  private readonly counters: MemberCounters[];
  private readonly rateLimitPerSec: number;
  private stopped = false;

  private constructor(name: string, ports: number[], adminPassword: string, rateLimitPerSec: number) {
    this.name = name;
    this.ports = ports;
    this.adminPassword = adminPassword;
    this.rateLimitPerSec = rateLimitPerSec;
    this.admin = this.client(ports.map((p) => `127.0.0.1:${p}`).join(','), `replicaSet=${REPLICA_SET}`);
    this.members = ports.map((p) => this.client(`127.0.0.1:${p}`, 'directConnection=true'));
    const zero = (): CounterSample => ({ t: 0, received: 0, successful: 0, created: 0, rejected: 0, queued: 0 });
    this.counters = ports.map(() => ({ last: undefined, total: zero() }));
  }

  /** The first member's port, for display. */
  get port(): number {
    return this.ports[0]!;
  }

  static async start(o: DockerReplicaSetOptions): Promise<DockerReplicaSet> {
    try {
      await docker(['version', '--format', '{{.Server.Version}}'], 15_000);
    } catch {
      throw new Error('krepis drill needs a running docker daemon (`docker version` failed).');
    }
    const count = o.members ?? 3;
    const ports: number[] = [];
    while (ports.length < count) {
      const p = await freePort();
      if (!ports.includes(p)) ports.push(p);
    }
    const name = `krepis-drill-rs-${randomBytes(4).toString('hex')}`;
    const rs = new DockerReplicaSet(name, ports, secret(), o.rateLimitPerSec);
    const limiter = o.rateLimitPerSec > 0
      ? [
          '--setParameter ingressConnectionEstablishmentRateLimiterEnabled=true',
          `--setParameter ingressConnectionEstablishmentRatePerSec=${o.rateLimitPerSec}`,
          '--setParameter ingressConnectionEstablishmentBurstCapacitySecs=1',
          `--setParameter ingressConnectionEstablishmentMaxQueueDepth=${o.rateLimitPerSec * 2}`,
        ].join(' ')
      : '';
    // /m.sh <n> (re)starts member n; the drill uses it again to restart a member it stopped.
    const member = [
      '#!/bin/bash',
      `PORTS=(0 ${ports.join(' ')})`,
      'mkdir -p /data/m$1',
      `exec mongod --replSet ${REPLICA_SET} --port \${PORTS[$1]} --bind_ip_all --keyFile /data/kf --dbpath /data/m$1 --fork --logpath /data/m$1.log --pidfilepath /data/m$1.pid --setParameter enableTestCommands=1 ${limiter}`,
    ].join('\n');
    const hosts = ports.map((p) => `127.0.0.1:${p}`).join(',');
    const config = `{_id:'${REPLICA_SET}',members:[${ports.map((p, i) => `{_id:${i},host:'127.0.0.1:${p}'}`).join(',')}]}`;
    // The localhost exception allows the first user only from inside the container. Retried until a primary exists.
    const createAdmin = `try{db.getSiblingDB('admin').createUser({user:'${ADMIN_USER}',pwd:process.env.ADMIN_PW,roles:['root']},{w:'majority'})}catch(e){if(!/already exists/.test(e.message))throw e}`;
    const script = [
      'set -e',
      'head -c 756 /dev/urandom | base64 > /data/kf && chmod 400 /data/kf',
      `echo ${Buffer.from(member).toString('base64')} | base64 -d > /m.sh && chmod +x /m.sh`,
      ...ports.map((_, i) => `/m.sh ${i + 1} > /dev/null`),
      `mongosh --quiet --port ${ports[0]} --eval "rs.initiate(${config})" > /dev/null`,
      `until mongosh --quiet "mongodb://${hosts}/?replicaSet=${REPLICA_SET}&serverSelectionTimeoutMS=2000" --eval "${createAdmin}" > /dev/null 2>&1; do sleep 1; done`,
      'touch /data/ready',
      'exec sleep infinity',
    ].join('\n');
    o.log?.(`starting ${o.image} replica set as ${name} on 127.0.0.1:${ports.join(',')}`);
    await docker([
      // --init: forked members are reparented to PID 1, which must reap them or a stopped member lingers as a zombie.
      'run', '-d', '--rm', '--init', '--name', name, '--label', 'krepis.drill=1', '--cpus', String(o.cpus),
      ...ports.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]),
      '-e', `ADMIN_PW=${rs.adminPassword}`, '--entrypoint', 'bash', o.image, '-c', script,
    ], 300_000);
    try {
      await rs.waitHealthy(180_000, o.signal);
    } catch (error) {
      await rs.stop();
      throw error;
    }
    return rs;
  }

  private client(hosts: string, extra: string): mongodb.MongoClient {
    return new mongodb.MongoClient(`mongodb://${ADMIN_USER}:${encodeURIComponent(this.adminPassword)}@${hosts}/?authSource=admin&${extra}`, {
      maxPoolSize: 2, minPoolSize: 0, serverMonitoringMode: 'poll', serverSelectionTimeoutMS: 2_000, connectTimeoutMS: 2_000, appName: 'krepis-drill',
    } as mongodb.MongoClientOptions);
  }

  uri(user: string, password: string): string {
    const hosts = this.ports.map((p) => `127.0.0.1:${p}`).join(',');
    return `mongodb://${user}:${encodeURIComponent(password)}@${hosts}/?authSource=admin&replicaSet=${REPLICA_SET}`;
  }

  /** Member index of a host string (`127.0.0.1:<port>`). */
  indexOf(host: string): number {
    const i = this.ports.findIndex((p) => host === `127.0.0.1:${p}`);
    if (i < 0) throw new Error(`krepis drill: ${host} is not a member of the drill replica set`);
    return i;
  }

  private async state(i: number): Promise<{ primary: boolean; secondary: boolean; me: string } | undefined> {
    try {
      const h = await this.members[i]!.db('admin').command({ hello: 1 });
      return { primary: h['isWritablePrimary'] === true, secondary: h['secondary'] === true, me: String(h['me']) };
    } catch {
      // A client whose connect failed (member not up yet, or the user not yet created) does not recover; replace it.
      const old = this.members[i]!;
      this.members[i] = this.client(`127.0.0.1:${this.ports[i]}`, 'directConnection=true');
      await old.close().catch(() => {});
      return undefined;
    }
  }

  /** The current writable primary, other than `not`, once there is one. */
  async waitPrimary(timeoutMs: number, signal?: AbortSignal, not?: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const states = await Promise.all(this.members.map((_, i) => this.state(i)));
      const p = states.find((s) => s?.primary && s.me !== not);
      if (p) return p.me;
      if (Date.now() > deadline) throw new Error(`the drill replica set had no ${not ? 'new ' : ''}primary within ${timeoutMs / 1000} s`);
      await sleep(250, signal);
    }
  }

  /** Waits until every member is up, in PRIMARY or SECONDARY state, and the admin user can run a command. */
  async waitHealthy(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const states = await Promise.all(this.members.map((_, i) => this.state(i)));
      if (states.every((s) => s && (s.primary || s.secondary)) && states.some((s) => s?.primary)) {
        try {
          await this.admin.db('admin').command({ ping: 1 });
          return;
        } catch {
          // A client whose first connect failed stays closed; start over with a fresh one.
          await this.admin.close().catch(() => {});
          this.admin = this.client(this.ports.map((p) => `127.0.0.1:${p}`).join(','), `replicaSet=${REPLICA_SET}`);
        }
      }
      if (Date.now() > deadline) throw new Error(`the drill replica set did not become healthy within ${timeoutMs / 1000} s`);
      await sleep(250, signal);
    }
  }

  async createUser(user: string, password: string, database: string): Promise<void> {
    await this.admin.db('admin').command({ createUser: user, pwd: password, roles: [{ role: 'readWrite', db: database }], writeConcern: { w: 'majority' } });
  }

  async setPassword(user: string, password: string): Promise<void> {
    await this.admin.db('admin').command({ updateUser: user, pwd: password, writeConcern: { w: 'majority' } });
  }

  /** Applied to every reachable member. */
  async failpoint(mode: 'alwaysOn' | 'off', data?: Record<string, unknown>): Promise<void> {
    const cmd = { configureFailPoint: 'failCommand', mode, ...(data ? { data: { failCommands: FAULTED_COMMANDS, ...data } } : {}) };
    await Promise.allSettled(this.members.map((m) => m.db('admin').command(cmd)));
  }

  async warmAdmin(): Promise<void> {
    await Promise.all([1, 2].map(() => this.admin.db('admin').command({ hello: 1 })));
  }

  /** Applied to every reachable member. */
  async admission(mode: 'overload' | 'normal'): Promise<void> {
    const r = this.rateLimitPerSec;
    const set = mode === 'overload'
      ? { ingressConnectionEstablishmentRateLimiterEnabled: true, ingressConnectionEstablishmentRatePerSec: 1, ingressConnectionEstablishmentBurstCapacitySecs: 1, ingressConnectionEstablishmentMaxQueueDepth: 1 }
      : r > 0
        ? { ingressConnectionEstablishmentRateLimiterEnabled: true, ingressConnectionEstablishmentRatePerSec: r, ingressConnectionEstablishmentBurstCapacitySecs: 1, ingressConnectionEstablishmentMaxQueueDepth: r * 2 }
        : { ingressConnectionEstablishmentRateLimiterEnabled: false };
    await Promise.allSettled(this.members.map((m) => m.db('admin').command({ setParameter: 1, ...set })));
  }

  /** Asks the primary to step down; it stays unelectable for 10 s. */
  async stepDown(primary: string): Promise<void> {
    await this.members[this.indexOf(primary)]!.db('admin').command({ replSetStepDown: 10, secondaryCatchUpPeriodSecs: 5 }).catch((error: unknown) => {
      // The stepping-down primary may close the connection the command arrived on; the election is what matters.
      if (!(error instanceof mongodb.MongoNetworkError)) throw error;
    });
  }

  /** Stops member `i`: `KILL` is a crash, `TERM` a clean shutdown. Resolves once the process has exited. */
  async kill(i: number, signal: 'KILL' | 'TERM'): Promise<void> {
    const pid = `/data/m${i + 1}.pid`;
    await docker(['exec', this.name, 'bash', '-c', `p=$(cat ${pid}); kill -${signal} $p; while kill -0 $p 2>/dev/null; do sleep 0.1; done`], 120_000);
  }

  /** Starts member `i` again (it must be stopped). */
  async startMember(i: number): Promise<void> {
    await docker(['exec', this.name, '/m.sh', String(i + 1)], 120_000);
  }

  /** Clean restart of member `i`; resolves once the set is healthy again. */
  async restartMember(i: number, signal?: AbortSignal): Promise<void> {
    await this.kill(i, 'TERM');
    await this.startMember(i);
    await this.waitHealthy(120_000, signal);
  }

  /**
   * Counters summed across members. Each member's cumulative counters reset when it restarts, so they are
   * accumulated per member and the sum stays cumulative. Activity between a member's last sample and its stop is lost.
   * Calls must not overlap: a stale reading that resolves late would look like a reset and count the member's whole history.
   */
  async sample(): Promise<CounterSample | undefined> {
    const raw = await Promise.all(this.members.map((m) => sampleOf(m)));
    if (raw.every((s) => s === undefined)) return undefined;
    const out: CounterSample = { t: Date.now(), received: 0, successful: 0, created: 0, rejected: 0, queued: 0 };
    raw.forEach((s, i) => {
      const c = this.counters[i]!;
      if (s) {
        for (const k of ['received', 'successful', 'created', 'rejected'] as const) {
          const prev = c.last?.[k];
          c.total[k] += prev === undefined ? s[k] : s[k] >= prev ? s[k] - prev : s[k];
        }
        c.last = s;
        out.queued += s.queued;
      }
      for (const k of ['received', 'successful', 'created', 'rejected'] as const) out[k] += c.total[k];
    });
    return out;
  }

  /** Closes the rig's own clients and, unless `remove` is false (`--keep`), removes the container. */
  async stop(remove = true): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled([this.admin.close(), ...this.members.map((m) => m.close())]);
    if (remove) await docker(['rm', '-f', '-v', this.name], 60_000).catch(() => {});
  }
}

async function sampleOf(client: mongodb.MongoClient): Promise<CounterSample | undefined> {
  try {
    const s = await client.db('admin').command({ serverStatus: 1, metrics: 0, wiredTiger: 0, locks: 0, opLatencies: 0, tcmalloc: 0, repl: 0 });
    const auth = s['security']?.authentication?.mechanisms?.['SCRAM-SHA-256']?.authenticate ?? {};
    const c = s['connections'] ?? {};
    return {
      t: Date.now(),
      received: Number(auth.received ?? 0),
      successful: Number(auth.successful ?? 0),
      created: Number(c.totalCreated ?? 0),
      rejected: Number(c.establishmentRateLimit?.rejected ?? 0),
      queued: Number(c.queuedForEstablishment ?? 0),
    };
  } catch {
    return undefined;
  }
}
