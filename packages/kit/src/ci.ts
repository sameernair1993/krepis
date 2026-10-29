import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { FAILING_HAZARDS, groupFindings, groupHazardFindings, groupPlanFindings, nPlusOneGroups, type LoadedCaptures } from './analyze.ts';
import { packageVersion } from './capture.ts';
import { formatFinding, type ReportOptions } from './report.ts';
import type { HazardFinding, NPlusOneFinding, PlanFinding } from './types.ts';

/**
 * CI support for `krepis analyze`: a committed baseline of known findings so a build fails only on what a branch
 * introduces, and Markdown (a PR comment) and SARIF 2.1.0 (GitHub code scanning) reports.
 *
 * A finding's key is built from its rule, collection names and value-free shapes. It leaves out line numbers, which
 * move with every edit, and database names, which test runs often vary per worker.
 */

export const BASELINE_VERSION = 1;
const RULES_URL = 'https://sameernair1993.github.io/krepis/RULES.html';

/**
 * A finding that can fail a build: N+1 (KR-P002), the plan rules, and the hazards KR-S001, KR-S002 and KR-P006.
 * Repeated lookups (KR-P012), unanchored regular expressions (KR-S003) and sensitive fields (KR-S004) are informational.
 */
export interface CiFinding {
  key: string;
  rule: 'KR-P002' | PlanFinding['rule'] | 'KR-S001' | 'KR-S002' | 'KR-P006';
  /** One line: what and where. */
  title: string;
  /** Nearest application frames, if captured. */
  callSite: string | undefined;
  /** The full report text for this finding. */
  text: string;
  /** Set when compared with a baseline. */
  state?: 'new' | 'known';
}

const collectionOf = (namespace: string) => namespace.split('.').slice(1).join('.');
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

function shortShape(shape: string): string {
  try {
    const parsed = JSON.parse(shape) as { filter?: unknown };
    return JSON.stringify(parsed.filter ?? parsed);
  } catch {
    return shape;
  }
}

export function nPlusOneKey(f: NPlusOneFinding): string {
  return hash(['KR-P002', collectionOf(f.namespace), f.shape, collectionOf(f.parent.namespace), f.parent.shape, f.parent.field].join('|'));
}

export function planKey(f: PlanFinding): string {
  return hash([f.rule, collectionOf(f.namespace), f.command, f.shape, f.lookup?.from ?? '', f.lookup?.foreignField ?? ''].join('|'));
}

export function hazardKey(f: HazardFinding): string {
  return hash([f.rule, collectionOf(f.namespace), f.command, f.shape, f.fields.join(',')].join('|'));
}

/** The findings of an analysis that CI acts on, one per pattern. */
export function ciFindings(loaded: LoadedCaptures, options: ReportOptions = {}): CiFinding[] {
  const out: CiFinding[] = [];
  const seen = new Set<string>();
  for (const g of nPlusOneGroups(groupFindings(loaded.findings))) {
    const f = g.representative as NPlusOneFinding;
    const key = nPlusOneKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      rule: 'KR-P002',
      title: `N+1: ${f.queries} × ${collectionOf(f.namespace)} ${shortShape(f.shape)} per ${collectionOf(f.parent.namespace)} result, in ${f.context}`,
      callSite: f.callSites[0],
      text: formatFinding(f, options),
    });
  }
  const names = { 'KR-P001': 'collection scan', 'KR-P010': 'in-memory sort', 'KR-P003': '$lookup without an index' } as const;
  for (const g of groupPlanFindings(loaded.plans)) {
    const f = g.representative;
    const key = planKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      rule: f.rule,
      title: `${names[f.rule]}: ${f.command} ${collectionOf(f.namespace)} ${shortShape(f.shape)}${f.lookup ? ` joining ${f.lookup.from}.${f.lookup.foreignField}` : ''}, in ${f.context}`,
      callSite: f.callSites[0],
      text: formatFinding(f, options),
    });
  }
  const hazardNames = { 'KR-S001': 'operator injection signal', 'KR-S002': 'server-side JavaScript', 'KR-P006': 'unbounded read' } as const;
  for (const g of groupHazardFindings(loaded.hazards)) {
    const f = g.representative;
    if (!FAILING_HAZARDS.has(f.rule)) continue;
    const rule = f.rule as keyof typeof hazardNames;
    const key = hazardKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = f.rule === 'KR-S001' ? ` on ${f.fields.join(', ')}` : f.rule === 'KR-S002' ? ` (${f.operators.join(', ')})` : '';
    out.push({
      key,
      rule,
      title: `${hazardNames[rule]}: ${f.command} ${collectionOf(f.namespace)} ${shortShape(f.shape)}${detail}, in ${f.context}`,
      callSite: f.callSites[0],
      text: formatFinding(f, options),
    });
  }
  return out;
}

export interface BaselineEntry { key: string; rule: string; title: string }
export interface Baseline { krepis_baseline: number; findings: BaselineEntry[] }

export function readBaseline(path: string): Baseline {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Baseline>;
  if (typeof parsed.krepis_baseline !== 'number' || !Array.isArray(parsed.findings)) {
    throw new Error(`${path} is not a krepis baseline`);
  }
  if (parsed.krepis_baseline > BASELINE_VERSION) throw new Error(`${path} was written by a newer krepis (baseline version ${parsed.krepis_baseline})`);
  return parsed as Baseline;
}

/** Sorted by key, with the context label left out of titles, so the file changes only when findings do. */
export function writeBaseline(path: string, findings: readonly CiFinding[]): void {
  const entries = findings
    .map((f) => ({ key: f.key, rule: f.rule, title: f.title.replace(/, in .*$/, '') }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const baseline: Baseline = { krepis_baseline: BASELINE_VERSION, findings: entries };
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
}

/** Marks each finding new or known. Baseline entries no longer found are returned as `fixed`. */
export function compareBaseline(findings: CiFinding[], baseline: Baseline): { findings: CiFinding[]; fixed: BaselineEntry[] } {
  const known = new Set(baseline.findings.map((e) => e.key));
  const current = new Set(findings.map((f) => f.key));
  return {
    findings: findings.map((f) => ({ ...f, state: known.has(f.key) ? 'known' : 'new' })),
    fixed: baseline.findings.filter((e) => !current.has(e.key)),
  };
}

const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A PR comment: new findings first, each with its full report in a collapsed block. */
export function formatMarkdown(findings: readonly CiFinding[], fixed: readonly BaselineEntry[] = []): string {
  const fresh = findings.filter((f) => f.state !== 'known');
  const known = findings.length - fresh.length;
  const lines: string[] = ['## Krepis', ''];
  const compared = findings.some((f) => f.state !== undefined) || fixed.length > 0;
  if (fresh.length === 0) {
    lines.push(compared ? 'No new findings.' : 'No findings.');
  } else {
    lines.push(`**${fresh.length} ${compared ? 'new ' : ''}finding${fresh.length === 1 ? '' : 's'}**`, '');
    lines.push('| Rule | Finding | Call site |', '|---|---|---|');
    for (const f of fresh) lines.push(`| ${f.rule} | ${escapeCell(f.title)} | ${f.callSite ? `\`${escapeCell(f.callSite)}\`` : ''} |`);
    for (const f of fresh) {
      lines.push('', `<details><summary>${f.rule}: ${escapeCell(f.title).replace(/</g, '&lt;')}</summary>`, '', '```text', f.text, '```', '', '</details>');
    }
  }
  if (known > 0) lines.push('', `${known} known finding${known === 1 ? '' : 's'} in the baseline.`);
  if (fixed.length > 0) lines.push('', `${fixed.length} baseline finding${fixed.length === 1 ? '' : 's'} no longer seen; run \`krepis analyze --update-baseline\` to remove ${fixed.length === 1 ? 'it' : 'them'}.`);
  return lines.join('\n');
}

const RULE_INFO: Record<CiFinding['rule'], { name: string; description: string; anchor: string }> = {
  'KR-P002': { name: 'NPlusOneQuery', description: 'A lookup per document of an earlier result (N+1).', anchor: 'kr-p002-in-detail' },
  'KR-P001': { name: 'CollectionScan', description: 'A filtered query that no index supports reads the whole collection.', anchor: 'plan-evidence' },
  'KR-P010': { name: 'InMemorySort', description: 'A sort that no index provides is done in memory.', anchor: 'plan-evidence' },
  'KR-P003': { name: 'UnindexedLookup', description: 'A $lookup whose joined field has no index.', anchor: 'plan-evidence' },
  'KR-S001': { name: 'OperatorInjection', description: 'One call site sent a field both as a value and as an operator object: the signature of operator injection.', anchor: 'security-s' },
  'KR-S002': { name: 'ServerSideJavaScript', description: 'A query runs JavaScript on the server ($where, $function, $accumulator, mapReduce).', anchor: 'security-s' },
  'KR-P006': { name: 'UnboundedRead', description: 'A find without a limit returned more documents than the threshold.', anchor: 'queries-p' },
};

/**
 * `src/a.ts:12 ← src/b.ts:5` → `{ uri: 'src/a.ts', line: 12 }`: the first frame inside `root` and outside
 * `node_modules`. An absolute path is made relative to `root`. A chain can start in a library the call-site filter
 * kept (a workspace package resolved to its real path, say); its later frames are still the application's.
 */
function location(callSite: string | undefined, root: string): { uri: string; line: number } | undefined {
  for (const frame of callSite?.split(' ← ') ?? []) {
    const m = /^(.*):(\d+)$/.exec(frame);
    if (!m) continue;
    let file = m[1]!;
    if (isAbsolute(file)) {
      file = relative(root, file);
      if (file.startsWith('..') || isAbsolute(file)) continue;
    }
    file = file.split(sep).join('/');
    if (file.split('/').includes('node_modules')) continue;
    return { uri: file, line: Number(m[2]) };
  }
  return undefined;
}

/**
 * SARIF 2.1.0, for GitHub code scanning. Code scanning shows only results with a location, so a finding whose call site
 * is outside `root` (default: the working directory) is in the file but not displayed there.
 */
export function formatSarif(findings: readonly CiFinding[], options: { version?: string; root?: string } = {}): string {
  const root = options.root ?? process.cwd();
  const ids = [...new Set(findings.map((f) => f.rule))].sort();
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'krepis',
          version: options.version ?? packageVersion(),
          informationUri: RULES_URL,
          rules: ids.map((id) => ({
            id,
            name: RULE_INFO[id].name,
            shortDescription: { text: RULE_INFO[id].description },
            fullDescription: { text: RULE_INFO[id].description },
            help: { text: `${RULE_INFO[id].description} See ${RULES_URL}#${RULE_INFO[id].anchor}` },
            helpUri: `${RULES_URL}#${RULE_INFO[id].anchor}`,
            defaultConfiguration: { level: 'warning' },
          })),
        },
      },
      results: findings.map((f) => {
        const loc = location(f.callSite, root);
        return {
          ruleId: f.rule,
          level: 'warning',
          message: { text: `${f.title}.\n\n${f.text}` },
          partialFingerprints: { krepisKey: f.key },
          ...(f.state ? { baselineState: f.state === 'new' ? 'new' : 'unchanged' } : {}),
          ...(loc ? { locations: [{ physicalLocation: { artifactLocation: { uri: loc.uri, uriBaseId: '%SRCROOT%' }, region: { startLine: loc.line } } }] } : {}),
        };
      }),
    }],
  };
  return JSON.stringify(sarif, null, 2);
}
