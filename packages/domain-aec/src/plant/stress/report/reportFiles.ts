/**
 * HTML and CSV forms of a pipe stress report (07 PST M4). HTML: one self-contained page, every dynamic text escaped. CSV: RFC 4180, text cells pass the spreadsheet formula guard.
 * @invariant pure; byte-deterministic (fixed row order, fixed number formatting); numbers in CSV are never guarded
 */

import { csvLines, type CsvCell } from '@lib/csv';
import { escapeXml } from '@lib/escapeXml';
import { guardRows } from '../../catalog/csvGuard';
import type { ReportData } from './reportData';

export const CSV_TABLES = ['stations', 'cases', 'supports', 'findings'] as const;
export type CsvTable = (typeof CSV_TABLES)[number];

const num = (value: number, digits: number): string => (Number.isFinite(value) ? value.toFixed(digits) : String(value));
const verdict = (pass: boolean | null): string => (pass === null ? 'n/a' : pass ? 'PASS' : 'FAIL');

const COLUMNS: Readonly<Record<CsvTable, readonly string[]>> = {
  stations: ['case', 'pipeId', 'element', 'node', 'xMm', 'stressMPa', 'allowableMPa', 'ratio', 'result', 'rule'],
  cases: ['case', 'type', 'governingNode', 'governingRatio', 'result', 'rule'],
  supports: ['case', 'node', 'supportIds', 'Fx_N', 'Fy_N', 'Fz_N', 'Mx_Nmm', 'My_Nmm', 'Mz_Nmm'],
  findings: ['code', 'severity', 'ids', 'message', 'remediation'],
};

function rowsOf(data: ReportData, table: CsvTable): CsvCell[][] {
  switch (table) {
    case 'stations':
      return data.stations.map((s) => [
        s.case,
        s.pipeId,
        s.element,
        s.node,
        s.xMm,
        s.stressMPa,
        s.allowableMPa,
        s.ratio,
        verdict(s.pass),
        s.rule,
      ]);
    case 'cases':
      return data.cases.map((c) => [
        c.name,
        c.type,
        c.governing?.nodeId ?? null,
        c.governing?.ratio ?? null,
        verdict(c.pass),
        c.governing?.rule ?? null,
      ]);
    case 'supports':
      return data.supportLoads.map((l) => [l.case, l.nodeId, l.supportIds.join(' '), ...l.forceN, ...l.momentNmm]);
    case 'findings':
      return data.findings.map((f) => [f.code, f.severity, f.ids.join(' '), f.message, f.remediation]);
  }
}

/** One table of the report as RFC 4180 text (newline-terminated). */
export function reportCsv(data: ReportData, table: CsvTable): string {
  return `${csvLines(COLUMNS[table], guardRows(rowsOf(data, table)))}\n`;
}

type HtmlCell = CsvCell;

const cell = (text: HtmlCell, tag: 'td' | 'th'): string => `<${tag}>${escapeXml(text === null ? '' : String(text))}</${tag}>`;
const tableOf = (columns: readonly string[], rows: ReadonlyArray<ReadonlyArray<HtmlCell>>, failColumn?: number): string =>
  `<table><thead><tr>${columns.map((c) => cell(c, 'th')).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr${failColumn !== undefined && row[failColumn] === 'FAIL' ? ' class="fail"' : ''}>${row.map((c) => cell(c, 'td')).join('')}</tr>`,
    )
    .join('')}</tbody></table>`;

const STYLE =
  'body{font-family:sans-serif;margin:24px;color:#1a1a2e}table{border-collapse:collapse;margin:8px 0 20px}th,td{border:1px solid #bbb;padding:3px 8px;text-align:left;font-size:13px}' +
  'th{background:#eee}tr.fail td{background:#fde2e0}.warn{color:#8a5a00}';

/** The whole report as one self-contained HTML page. */
export function reportHtml(data: ReportData): string {
  const approvedBy = data.approval.signer === null ? '' : ` by ${escapeXml(data.approval.signer)} at ${escapeXml(data.approval.at ?? '')}`;
  const unverified = [...data.unverified.map((f) => `${f.code}: ${f.message}`), ...data.defaulted.map((d) => `defaulted: ${d}`)];
  const sections: string[] = [
    `<h1>Pipe stress report: ${escapeXml(data.name)} (${escapeXml(data.modelId)})</h1>`,
    `<p>Code <b>${escapeXml(data.code)}</b>, edition <b>${escapeXml(data.edition)}</b>; status <b>${escapeXml(data.status)}</b>; ` +
      `results record <b>${escapeXml(data.record.status)}</b>; approval <b>${escapeXml(data.approval.status)}</b>${approvedBy}.</p>`,
    '<p class="warn">Review required: this analysis supports an engineer review and is not a release by itself.</p>',
    `<p>Pipes: ${escapeXml(data.pipes.join(', '))}. Solver ${escapeXml(data.solverVersion)}. Input hash ${escapeXml(data.inputHash)}; result hash ${escapeXml(data.resultHash)}.</p>`,
    '<h2>Load cases: governing ratio</h2>',
    tableOf(COLUMNS.cases, rowsOf(data, 'cases'), 4),
    '<h2>Findings</h2>',
    data.findings.length === 0 ? '<p>None.</p>' : tableOf(COLUMNS.findings, rowsOf(data, 'findings')),
    '<h2>Unverified and defaulted inputs</h2>',
    unverified.length === 0 ? '<p>None.</p>' : `<ul>${unverified.map((line) => `<li>${escapeXml(line)}</li>`).join('')}</ul>`,
    '<h2>Support loads (N, N.mm)</h2>',
    data.supportLoads.length === 0
      ? '<p>No supports or anchors.</p>'
      : tableOf(
          COLUMNS.supports,
          data.supportLoads.map((l) => [
            l.case,
            l.nodeId,
            l.supportIds.join(' '),
            ...l.forceN.map((v) => num(v, 1)),
            ...l.momentNmm.map((v) => num(v, 0)),
          ]),
        ),
    '<h2>Stations</h2>',
    tableOf(
      COLUMNS.stations,
      data.stations.map((s) => [
        s.case,
        s.pipeId,
        s.element,
        s.node,
        num(s.xMm, 1),
        num(s.stressMPa, 2),
        num(s.allowableMPa, 2),
        num(s.ratio, 3),
        verdict(s.pass),
        s.rule,
      ]),
      8,
    ),
  ];
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Pipe stress report ${escapeXml(data.modelId)}</title><style>${STYLE}</style></head><body>\n${sections.join('\n')}\n</body></html>\n`;
}
