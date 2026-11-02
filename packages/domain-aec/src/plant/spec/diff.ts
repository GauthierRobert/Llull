/**
 * Difference between two revisions of a pipe spec (plant 01 PSC M4): header members, components by id (added, removed, changed member by member),
 * branch-table cells and insulation rows, computed on the canonical file form so the order of keys never matters.
 * @invariant pure; diff(a, a) is empty; added and removed are disjoint; every list is sorted
 */

import { canonicalJson } from '@lib/canonicalJson';
import { specToFile } from './file';
import type { PipeSpec } from './types';

type Json = Record<string, unknown>;

export interface FieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

export interface SpecDiff {
  readonly header: readonly FieldChange[];
  readonly status: { readonly from: string; readonly to: string } | null;
  readonly components: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: ReadonlyArray<{ readonly id: string; readonly fields: readonly FieldChange[] }>;
  };
  readonly branchCells: ReadonlyArray<{
    readonly header: string;
    readonly branch: string;
    readonly from: string | null;
    readonly to: string | null;
  }>;
  readonly insulation: { readonly added: readonly unknown[]; readonly removed: readonly unknown[] };
  readonly changes: number;
}

/** Members that are not header content: handled separately or identity of the revision. */
const NOT_HEADER: ReadonlySet<string> = new Set([
  'format',
  'schemaVersion',
  'id',
  'revision',
  'status',
  'approval',
  'components',
  'branchTable',
  'insulation',
]);

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function fieldChanges(from: Json, to: Json, skip: ReadonlySet<string> = new Set()): FieldChange[] {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])]
    .filter((field) => !skip.has(field) && !same(from[field], to[field]))
    .sort(compareText)
    .map((field) => ({ field, from: from[field] ?? null, to: to[field] ?? null }));
}

const componentsOf = (file: Json): Map<string, Json> =>
  new Map(((file['components'] as Json[] | undefined) ?? []).map((component) => [String(component['id']), component]));

function cellsOf(file: Json): Map<string, string> {
  const cells = ((file['branchTable'] as Json | undefined)?.['cells'] ?? {}) as Record<string, Record<string, string>>;
  return new Map(
    Object.entries(cells).flatMap(([header, row]) => Object.entries(row).map(([branch, fitting]) => [`${header}\u0000${branch}`, fitting])),
  );
}

function rowDifference(from: readonly unknown[], to: readonly unknown[]): { added: unknown[]; removed: unknown[] } {
  const fromKeys = new Set(from.map((row) => canonicalJson(row)));
  const toKeys = new Set(to.map((row) => canonicalJson(row)));
  return { added: to.filter((row) => !fromKeys.has(canonicalJson(row))), removed: from.filter((row) => !toKeys.has(canonicalJson(row))) };
}

/** What changed from revision `from` to revision `to` of a spec. */
export function diffSpecs(from: PipeSpec, to: PipeSpec): SpecDiff {
  const a = specToFile(from);
  const b = specToFile(to);
  const before = componentsOf(a);
  const after = componentsOf(b);
  const added = [...after.keys()].filter((id) => !before.has(id)).sort(compareText);
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort(compareText);
  const changed = [...after.keys()]
    .filter((id) => before.has(id))
    .sort(compareText)
    .flatMap((id) => {
      const fields = fieldChanges(before.get(id) as Json, after.get(id) as Json);
      return fields.length === 0 ? [] : [{ id, fields }];
    });
  const cellsBefore = cellsOf(a);
  const cellsAfter = cellsOf(b);
  const branchCells = [...new Set([...cellsBefore.keys(), ...cellsAfter.keys()])]
    .filter((key) => cellsBefore.get(key) !== cellsAfter.get(key))
    .sort(compareText)
    .map((key) => {
      const [header = '', branch = ''] = key.split('\u0000');
      return { header, branch, from: cellsBefore.get(key) ?? null, to: cellsAfter.get(key) ?? null };
    });
  const header = fieldChanges(a, b, NOT_HEADER);
  const insulation = rowDifference((a['insulation'] as unknown[] | undefined) ?? [], (b['insulation'] as unknown[] | undefined) ?? []);
  const status = from.status === to.status ? null : { from: from.status, to: to.status };
  return {
    header,
    status,
    components: { added, removed, changed },
    branchCells,
    insulation,
    changes:
      header.length +
      (status === null ? 0 : 1) +
      added.length +
      removed.length +
      changed.length +
      branchCells.length +
      insulation.added.length +
      insulation.removed.length,
  };
}
