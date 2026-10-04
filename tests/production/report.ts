import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ScenarioReport } from './contract';

/**
 * @layer tests/production
 *
 * Writes graded reports to .cache/production/reports/<driver>/<scenario>.json and regenerates
 * SUMMARY.md across every driver — the "can an engineering office use llull?" page.
 */

/** Repo root: the nearest ancestor of the working directory holding tests/production/contract.ts (server runs from server/). */
function repoRoot(from: string = process.cwd()): string {
  if (existsSync(path.join(from, 'tests', 'production', 'contract.ts'))) return from;
  const parent = path.dirname(from);
  return parent === from ? process.cwd() : repoRoot(parent);
}

export const REPORT_ROOT = path.join(repoRoot(), '.cache', 'production', 'reports');

export function writeReport(report: ScenarioReport, extra: Record<string, unknown> = {}): string {
  const dir = path.join(REPORT_ROOT, report.driver);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.scenario}.json`);
  writeFileSync(file, JSON.stringify({ ...report, ...extra }, null, 2));
  writeSummary();
  return file;
}

/** Store a deliverable the driver produced (downloaded file, agent transcript…) next to the report. */
export function writeArtifact(
  driver: string,
  scenario: string,
  name: string,
  text: string,
): string {
  const dir = path.join(REPORT_ROOT, driver, scenario);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

function readReports(): ScenarioReport[] {
  if (!existsSync(REPORT_ROOT)) return [];
  return readdirSync(REPORT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) =>
      readdirSync(path.join(REPORT_ROOT, dir.name))
        .filter((name) => name.endsWith('.json'))
        .map(
          (name) =>
            JSON.parse(
              readFileSync(path.join(REPORT_ROOT, dir.name, name), 'utf8'),
            ) as ScenarioReport,
        ),
    );
}

export function formatReport(report: ScenarioReport): string {
  const lines = [
    `### ${report.title} — ${report.driver}: ${report.passed}/${report.total}`,
    '',
    '| | criterion | area | result |',
    '| - | --------- | ---- | ------ |',
    ...report.checks.map(
      (check) =>
        `| ${check.pass ? '✅' : check.known ? '⚠️' : '❌'} | ${check.id} | ${check.area} | ${check.detail.replace(/\|/g, '\\|')} |`,
    ),
  ];
  if (report.regressions.length > 0)
    lines.push('', `**Regressions:** ${report.regressions.join(', ')}`);
  if (report.fixed.length > 0)
    lines.push('', `**Fixed (remove from knownIssues):** ${report.fixed.join(', ')}`);
  return lines.join('\n');
}

function writeSummary(): void {
  const reports = readReports().sort((a, b) =>
    `${a.scenario}${a.driver}`.localeCompare(`${b.scenario}${b.driver}`),
  );
  const text = [
    '# Production scenarios — summary',
    '',
    '✅ pass · ⚠️ known gap (ratcheted) · ❌ regression',
    '',
    ...reports.map(formatReport).flatMap((block) => [block, '']),
  ].join('\n');
  writeFileSync(path.join(REPORT_ROOT, 'SUMMARY.md'), text);
}
