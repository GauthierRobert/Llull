// Findings list model (FR-FPR-51): flatten the checks to rows, then filter by type/severity/reviewer status, sort by severity or value,
// and group by part. Pure.

import { severityOf } from './checklist';
import type { FindingGroup, FindingSort } from './reviewStore';
import type { CheckItem, CheckName, CheckResult, CheckStatus, DispositionStatus } from './reviewTypes';

export interface Finding {
  readonly check: CheckName;
  readonly item: CheckItem;
  /** inputsHash of the check the item belongs to (sent with a disposition). */
  readonly inputsHash: string;
}

export interface FindingFilters {
  readonly check: CheckName | 'all';
  readonly severity: CheckStatus | 'all';
  readonly reviewer: DispositionStatus | 'all';
}

export interface FindingGroupModel {
  /** Part id, or '' for the single ungrouped list. */
  readonly part: string;
  readonly findings: readonly Finding[];
}

export function flattenFindings(checks: readonly CheckResult[]): Finding[] {
  return checks.flatMap((result) => result.items.map((item) => ({ check: result.check, item, inputsHash: result.inputsHash })));
}

export const reviewerStatusOf = (item: CheckItem): DispositionStatus => item.disposition?.status ?? 'not_reviewed';

const primaryValue = (item: CheckItem): number => Math.abs(Object.values(item.values)[0] ?? 0);

export function filterFindings(findings: readonly Finding[], filters: FindingFilters): Finding[] {
  return findings.filter(
    ({ check, item }) =>
      (filters.check === 'all' || filters.check === check) &&
      (filters.severity === 'all' || filters.severity === item.status) &&
      (filters.reviewer === 'all' || filters.reviewer === reviewerStatusOf(item)),
  );
}

export function sortFindings(findings: readonly Finding[], sort: FindingSort): Finding[] {
  const compare =
    sort === 'value'
      ? (a: Finding, b: Finding): number => primaryValue(b.item) - primaryValue(a.item)
      : (a: Finding, b: Finding): number => severityOf(b.item.status) - severityOf(a.item.status);
  return [...findings].sort((a, b) => compare(a, b) || a.item.findingKey.localeCompare(b.item.findingKey));
}

/** One group per part (a finding on several parts is listed under each); ids sorted so the order is stable. */
export function groupFindings(findings: readonly Finding[], group: FindingGroup): FindingGroupModel[] {
  if (group === 'none') return [{ part: '', findings }];
  const byPart = new Map<string, Finding[]>();
  for (const finding of findings) {
    for (const part of finding.item.ids.length === 0 ? ['(no part)'] : finding.item.ids) {
      byPart.set(part, [...(byPart.get(part) ?? []), finding]);
    }
  }
  return [...byPart.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([part, grouped]) => ({ part, findings: grouped }));
}

/** The check and item behind a finding key (Explain drawer target). */
export function findFinding(checks: readonly CheckResult[], findingKey: string): { result: CheckResult; item: CheckItem } | undefined {
  for (const result of checks) {
    const item = result.items.find((candidate) => candidate.findingKey === findingKey);
    if (item !== undefined) return { result, item };
  }
  return undefined;
}
