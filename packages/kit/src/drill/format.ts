import type { DrillReport, ScenarioResult } from './types.ts';

function findingSummary(r: ScenarioResult): string {
  const counts = new Map<string, number>();
  for (const { phase, finding } of r.findings) {
    if (phase === 'baseline') continue;
    const mechanism = finding.evidence['mechanism'];
    const fleet = finding.client === '*' ? ' fleet' : '';
    const key = `${finding.rule}${mechanism ? ` ${mechanism}` : ''}${fleet}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ') || '—';
}

const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);

export function formatDrillReport(report: DrillReport): string {
  const lines: string[] = [];
  const limiter = report.rateLimitPerSec > 0 ? `rate limit ${report.rateLimitPerSec}/s` : 'no rate limit';
  lines.push(`krepis drill — ${report.image}, ${report.tenants} tenants, ${limiter}`, '');
  const rows = report.scenarios.map((r) => [
    r.name,
    r.pass ? 'PASS' : 'FAIL',
    `${r.recovered}/${r.eligible}`,
    seconds(r.slowestRecoveryMs),
    `${r.phases.baseline.logins}/${r.phases.fault.logins}/${r.phases.recovery.logins}`,
    `${r.phases.baseline.failedLogins}/${r.phases.fault.failedLogins}/${r.phases.recovery.failedLogins}`,
    String(r.phases.fault.rejected + r.phases.recovery.rejected),
    findingSummary(r),
  ]);
  const head = ['scenario', 'verdict', 'recovered', 'slowest', 'logins b/f/r', 'failed b/f/r', 'refused', 'findings (fault + recovery)'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const fmt = (row: string[]) => `  ${row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')}`.trimEnd();
  lines.push(fmt(head));
  for (const row of rows) lines.push(fmt(row));
  const elections = report.scenarios.filter((r) => r.primary);
  if (elections.length) {
    lines.push('');
    for (const r of elections) lines.push(`  ${r.name} · primary ${r.primary!.before} → ${r.primary!.after}, writable ${seconds(r.primary!.electedAfterMs)} after the fault began`);
  }
  const late = report.scenarios.filter((r) => r.latecomers);
  if (late.length) {
    if (!elections.length) lines.push('');
    for (const r of late) {
      const all = Object.values(r.latecomers!.tenants);
      const failed = all.reduce((n, l) => n + l.failedBefore, 0);
      const firsts = all.map((l) => (l.firstOkMs === null ? 'never' : seconds(l.firstOkMs))).join(', ');
      lines.push(`  ${r.name} · latecomers arrived ${seconds(r.latecomers!.arrivedAtMs)} into the fault; first success after ${firsts}${failed ? ` (${failed} operations failed first)` : ''}`);
    }
  }
  const failing = report.scenarios.filter((r) => !r.pass);
  if (failing.length) {
    lines.push('');
    for (const r of failing) {
      for (const v of r.verdicts.filter((x) => !x.pass)) lines.push(`  ✗ ${r.name} · ${v.name}: ${v.detail}`);
    }
  }
  lines.push('', `${report.pass ? 'PASS' : 'FAIL'}: ${report.scenarios.length - failing.length}/${report.scenarios.length} scenarios in ${Math.round(report.durationMs / 1000)} s`);
  return lines.join('\n');
}
