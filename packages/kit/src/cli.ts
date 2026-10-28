#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ScenarioName } from './drill/index.ts';
import { analysisJson, captureFiles, formatAnalysis, groupFindings, loadCaptures } from './analyze.ts';
import { ciFindings, compareBaseline, formatMarkdown, formatSarif, readBaseline, writeBaseline, type BaselineEntry } from './ci.ts';

const HELP = `krepis — query analysis for MongoDB on Node.js

Usage:
  krepis analyze [paths...] [--format text|json|markdown|sarif] [--output file] [--rtt 1,20]
                 [--pool 100] [--baseline file] [--update-baseline] [--fail]
      Read captures (default: .krepis/) and report N+1 patterns, grouped across units of work,
      and index findings when the app ran with observe(client, { explain: true }).
      --format  text (default), json, markdown (a PR comment) or sarif (GitHub code scanning);
                --json is short for --format json
      --output  write the report to this file instead of stdout
      --rtt     round-trip times (ms) to project the cost onto (default 1,20)
      --pool    maxPoolSize to assume for parallel loops (default 100)
      --baseline         compare with a baseline of known findings; --fail then fails only on
                         findings not in it
      --update-baseline  write the current findings to the baseline file
                         (--baseline, default krepis-baseline.json) and exit 0
      --fail    exit with status 1 if any N+1 pattern, index finding, operator injection signal,
                server-side JavaScript or unbounded read is found (for test suites and CI);
                KR-P012, KR-S003 and KR-S004 are informational and never fail
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
  const valued = new Set(['--rtt', '--pool', '--scenario', '--image', '--dump-dir', '--format', '--output', '--baseline']);
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

function stringFlag(args: Parsed, name: string): string | undefined {
  const v = args.flags.get(name);
  if (v === true) fail(`${name} needs a value`);
  return v;
}

const FORMATS = ['text', 'json', 'markdown', 'sarif'] as const;
const DEFAULT_BASELINE = 'krepis-baseline.json';

function analyze(args: Parsed): number {
  const known = new Set(['--json', '--rtt', '--pool', '--fail', '--format', '--output', '--baseline', '--update-baseline']);
  for (const f of args.flags.keys()) if (!known.has(f)) fail(`unknown option ${f}`);
  const format = (stringFlag(args, '--format') ?? (args.flags.has('--json') ? 'json' : 'text')) as (typeof FORMATS)[number];
  if (!FORMATS.includes(format)) fail(`--format: expected one of ${FORMATS.join(', ')}, got "${format}"`);
  const output = stringFlag(args, '--output');
  const baselinePath = stringFlag(args, '--baseline');
  const pool = numbers(args.flags.get('--pool'), '--pool');
  const options = { rttMs: numbers(args.flags.get('--rtt'), '--rtt'), maxPoolSize: pool?.[0] };

  const paths = args.positional.length > 0 ? args.positional : ['.krepis'];
  const loaded = loadCaptures(captureFiles(paths));
  const groups = groupFindings(loaded.findings);
  let findings = ciFindings(loaded, options);

  if (args.flags.has('--update-baseline')) {
    const path = baselinePath ?? DEFAULT_BASELINE;
    writeBaseline(path, findings);
    process.stdout.write(`Wrote ${findings.length} finding${findings.length === 1 ? '' : 's'} to ${path}.\n`);
    return 0;
  }

  let fixed: BaselineEntry[] = [];
  if (baselinePath !== undefined) {
    if (!existsSync(baselinePath)) fail(`no baseline at ${baselinePath}; create one with --update-baseline`);
    let baseline;
    try {
      baseline = readBaseline(baselinePath);
    } catch (error) {
      fail((error as Error).message);
    }
    ({ findings, fixed } = compareBaseline(findings, baseline));
  }
  const fresh = findings.filter((f) => f.state !== 'known');

  let report: string;
  if (format === 'json') {
    const json = analysisJson(loaded, groups) as Record<string, unknown>;
    if (baselinePath !== undefined) {
      json.baseline = {
        path: baselinePath,
        new: fresh.map(({ key, rule, title }) => ({ key, rule, title })),
        known: findings.length - fresh.length,
        fixed,
      };
    }
    report = JSON.stringify(json, null, 2);
  } else if (format === 'markdown') {
    report = formatMarkdown(findings, fixed);
  } else if (format === 'sarif') {
    report = formatSarif(findings);
  } else {
    report = formatAnalysis(loaded, groups, options);
    if (baselinePath !== undefined) {
      report += `\n\nBaseline ${baselinePath}: ${fresh.length} new, ${findings.length - fresh.length} known, ${fixed.length} no longer seen.`;
      for (const f of fresh) report += `\n  new  ${f.rule}  ${f.title}`;
    }
  }
  if (output !== undefined) writeFileSync(output, report + '\n');
  else process.stdout.write(report + '\n');
  return args.flags.has('--fail') && fresh.length > 0 ? 1 : 0;
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
