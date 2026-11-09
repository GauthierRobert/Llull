/** CSV report of the compatibility items (PHY-13 FR-COR-19, VC-COR-16: 12 columns). */

import { isRecord } from '@lib/isRecord';
import type { CompatibilityItem } from './items';

const REPORT_COLUMNS = [
  'key',
  'status',
  'code',
  'a',
  'b',
  'materials',
  'surfaceSystems',
  'rule',
  'grade',
  'delta',
  'remedies',
  'acceptance',
] as const;

/** One CSV cell: quoted when needed, and a leading = + - @ (spreadsheet formula) is neutralised with an apostrophe. */
const cell = (value: unknown): string => {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const partsOf = (item: CompatibilityItem): Array<Record<string, unknown>> => {
  const parts = item.inputs['parts'];
  return Array.isArray(parts) ? parts.filter(isRecord) : [];
};

/** The report as CSV text (header + one row per item, LF line ends). */
export function reportCsv(items: readonly CompatibilityItem[]): string {
  const rows = items.map((item) => {
    const parts = partsOf(item);
    return [
      item.key,
      item.status,
      [item.code, ...item.warnings.filter((warning) => warning !== 'COR_SCREENING_RULE_ONLY')].join(';'),
      item.ids[0],
      item.ids[1],
      parts.map((part) => part['material'] ?? '').join(' | '),
      parts.map((part) => part['surfaceSystem'] ?? '').join(' | '),
      item.ruleId,
      item.ruleGrade,
      item.inputs['differenceV'] ?? '',
      item.remedies.map((remedy) => remedy.id).join(' | '),
      item.acceptance === undefined ? '' : `${item.acceptance.decision} by ${item.acceptance.signer}`,
    ]
      .map(cell)
      .join(',');
  });
  return [REPORT_COLUMNS.join(','), ...rows].join('\n') + '\n';
}
