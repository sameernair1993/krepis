#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ScenarioName } from './drill/index.ts';
import { analysisJson, captureFiles, formatAnalysis, groupFindings, loadCaptures, nPlusOneGroups } from './analyze.ts';

const HELP = `krepis — query analysis for MongoDB on Node.js

Usage:
  krepis analyze [paths...] [--json] [--rtt 1,20] [--pool 100] [--fail]
      Read captures (default: .krepis/) and report N+1 patterns, grouped across units of work.
      --json   machine-readable output
      --rtt    round-trip times (ms) to project the cost onto (default 1,20)
      --pool   maxPoolSize to assume for parallel loops (default 100)
      --fail   exit with status 1 if any N+1 pattern is found (for test suites and CI);
               repeated lookups (KR-P012) are informational and never fail
  krepis init
      Create .krepis/ and add it to .gitignore.
  krepis drill [config] [--scenario a,b] [--json] [--keep] [--image ref] [--dump-dir dir]
      Rehearse connection incidents against your own connection code, on a disposable
      mongod in docker (auth, connection rate limit, failpoints). Config defaults to
      krepis.drill.{ts,mts,js,mjs}. Scenarios: credential-rotation, auth-outage, restart,
      slow-node, overload, overload-keep, network-blip, idle; and on a three-member replica
      set: stepdown, primary-crash, rolling-restart. Exits 1 if any scenario fails, 2 on a
      usage or docker error.
      --scenario  run only these        --json      machine-readable report
      --keep      leave the container   --image     mongod image (default mongo:8.0)
      --dump-dir  write flight-recorder dumps here

Capture is turned on in the app: observe(client, { capture: true }) or KREPIS_CAPTURE=1.`;

interface Parsed { positional: string[]; flags: Map<string, string | true> }

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(['--rtt', '--pool', '--scenario', '--image', '--dump-dir']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(0, eq), a.slice(eq + 1));
      else if (valued.has(a) && i + 1 < argv.length) flags.set(a, argv[++i]!);
      else flags.set(a, true);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(message: string): never {
  process.stderr.write(`krepis: ${message}\n`);
  process.exit(2);
}

function numbers(value: string | true | undefined, name: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (value === true) fail(`${name} needs a value`);
  const list = value.split(',').map(Number);
  if (list.some((x) => !Number.isFinite(x) || x < 0)) fail(`${name}: expected non-negative numbers, got "${value}"`);
  return list;
}

function analyze(args: Parsed): number {
  const known = new Set(['--json', '--rtt', '--pool', '--fail']);
  for (const f of args.flags.keys()) if (!known.has(f)) fail(`unknown option ${f}`);
  const paths = args.positional.length > 0 ? args.positional : ['.krepis'];
  const loaded = loadCaptures(captureFiles(paths));
  const groups = groupFindings(loaded.findings);
  if (args.flags.has('--json')) {
    process.stdout.write(JSON.stringify(analysisJson(loaded, groups), null, 2) + '\n');
  } else {
    const pool = numbers(args.flags.get('--pool'), '--pool');
    process.stdout.write(formatAnalysis(loaded, groups, { rttMs: numbers(args.flags.get('--rtt'), '--rtt'), maxPoolSize: pool?.[0] }) + '\n');
  }
  return args.flags.has('--fail') && nPlusOneGroups(groups).length > 0 ? 1 : 0;
}

function init(): number {
  mkdirSync('.krepis', { recursive: true });
  const entry = '.krepis/';
  if (!existsSync('.gitignore')) {
    writeFileSync('.gitignore', `${entry}\n`);
    process.stdout.write('Created .krepis/ and .gitignore.\n');
    return 0;
  }
  const current = readFileSync('.gitignore', 'utf8');
  if (current.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === '.krepis')) {
    process.stdout.write('Created .krepis/ (already in .gitignore).\n');
    return 0;
  }
  appendFileSync('.gitignore', `${current.endsWith('\n') || current === '' ? '' : '\n'}${entry}\n`);
  process.stdout.write('Created .krepis/ and added it to .gitignore.\n');
  return 0;
}

const DRILL_FILES = ['krepis.drill.ts', 'krepis.drill.mts', 'krepis.drill.js', 'krepis.drill.mjs'];

async function drill(args: Parsed): Promise<number> {
  const known = new Set(['--scenario', '--json', '--keep', '--image', '--dump-dir']);
  for (const f of args.flags.keys()) if (!known.has(f)) fail(`unknown option ${f}`);
  if (args.positional.length > 1) fail('drill takes one config file');
  const valueOf = (name: string): string | undefined => {
    const v = args.flags.get(name);
    if (v === true) fail(`${name} needs a value`);
    return v;
  };
  const file = args.positional[0] ?? DRILL_FILES.find((f) => existsSync(f));
  if (!file) fail(`no drill config: pass a file or create one of ${DRILL_FILES.join(', ')}`);
  if (!existsSync(file)) fail(`no such file: ${file}`);
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  let mod: { default?: unknown; drill?: unknown };
  try {
    mod = await import(pathToFileURL(resolve(file)).href);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_UNKNOWN_FILE_EXTENSION' && /\.m?ts$/.test(file)) fail(`this Node (${process.version}) cannot load TypeScript directly; use Node 22.18+ or a .mjs config`);
    fail(`could not load ${file}: ${(error as Error).message}`);
  }
  const config = (mod.default ?? mod.drill) as { setup?: unknown } | undefined;
  if (!config || typeof config.setup !== 'function') fail(`${file} must export default defineDrill({ setup, ... })`);
  const { runDrill, formatDrillReport } = await import('./drill/index.ts');
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    process.stderr.write('krepis drill: interrupted; removing the drill server (Ctrl-C again to force)\n');
    controller.abort(new Error('interrupted'));
  };
  process.on('SIGINT', onSigint);
  try {
    const scenario = valueOf('--scenario');
    const report = await runDrill(config as Parameters<typeof runDrill>[0], {
      only: scenario?.split(',').map((s) => s.trim()).filter(Boolean) as ScenarioName[] | undefined,
      keep: args.flags.has('--keep'),
      image: valueOf('--image'),
      dumpDir: valueOf('--dump-dir'),
      signal: controller.signal,
      log: (line) => process.stderr.write(`krepis drill: ${line}\n`),
    });
    if (controller.signal.aborted) return 130;
    process.stdout.write((args.flags.has('--json') ? JSON.stringify(report, null, 2) : formatDrillReport(report)) + '\n');
    return report.pass ? 0 : 1;
  } catch (error) {
    if (controller.signal.aborted) return 130;
    fail((error as Error).message);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

const [command, ...rest] = process.argv.slice(2);
const args = parse(rest);
// `krepis <command> --help` prints the usage instead of failing as an unknown option.
const wantsHelp = rest.includes('--help') || rest.includes('-h');
switch (wantsHelp ? 'help' : command) {
  case 'analyze':
    process.exitCode = analyze(args);
    break;
  case 'init':
    process.exitCode = init();
    break;
  case 'drill':
    process.exitCode = await drill(args);
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(HELP + '\n');
    break;
  default:
    fail(`unknown command "${command}". Run krepis --help.`);
}
