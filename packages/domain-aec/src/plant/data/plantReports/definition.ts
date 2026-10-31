/** A saved report definition applied to a built report (plant 08 DAT §3 `ReportDefinition`, FR-DAT-27): computed columns, filter, sort, column selection. Pure. */

import { compileExpression, expressionSyntaxError, extractReferences } from '@lib/expression';
import type { ComputedColumn, PlantValue, ReportDefinition } from '../model';
import { naturalCompare } from '../naturalSort';
import { columnOf, type ReportColumn, type ReportOutcome, type ReportRow, type ReportTable } from './types';

const fail = (code: string, message: string, path: string): ReportOutcome => ({ ok: false, code, message, path });

/** Why a computed column cannot be saved with `columnNames` available, or null. */
export function computedProblem(computed: ComputedColumn, columnNames: ReadonlySet<string>): { code: string; message: string } | null {
  const syntax = expressionSyntaxError(computed.expression);
  if (syntax !== null) return { code: 'DAT_PARAM_INVALID', message: `computed column ${computed.name}: ${syntax}` };
  for (const reference of extractReferences(computed.expression))
    if (!columnNames.has(reference) && reference !== 'pi' && reference !== 'tau')
      return {
        code: 'DAT_COLUMN_UNKNOWN',
        message: `computed column ${computed.name} reads "${reference}", which is no column (${[...columnNames].join(', ')})`,
      };
  return null;
}

const compare = (a: PlantValue | undefined, b: PlantValue | undefined): number => {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return naturalCompare(String(a), String(b));
};

/**
 * `table` with the definition applied: computed columns (value null where an operand is missing or the result is not finite), filter (column equals value),
 * sort (stable, natural for text), then the column selection. totals are kept only when no filter is set.
 */
export function applyDefinition(table: ReportTable, definition: ReportDefinition): ReportOutcome {
  const computed = definition.computed ?? [];
  const known = new Set([...table.columns.map((column) => column.name), ...computed.map((column) => column.name)]);
  for (const entry of computed) {
    if (table.columns.some((column) => column.name === entry.name))
      return fail('DAT_PARAM_INVALID', `computed column ${entry.name} has the name of a report column`, 'computed');
    const problem = computedProblem(entry, new Set(table.columns.map((column) => column.name)));
    if (problem !== null) return fail(problem.code, problem.message, 'computed');
  }
  const unknown = (names: readonly string[], path: string): ReportOutcome | null => {
    const missing = names.find((name) => !known.has(name.replace(/^-/, '')));
    return missing === undefined
      ? null
      : fail('DAT_COLUMN_UNKNOWN', `${path} names "${missing}", which ${definition.kind} has no column (${[...known].join(', ')})`, path);
  };
  const refused =
    unknown(definition.columns ?? [], 'columns') ??
    unknown(definition.sort ?? [], 'sort') ??
    unknown(Object.keys(definition.filter ?? {}), 'filter');
  if (refused !== null) return refused;
  const compiled = computed.map((entry) => ({ entry, evaluate: compileExpression(entry.expression) }));
  let rows: ReportRow[] = table.rows.map((row) => {
    if (compiled.length === 0) return row;
    const env: Record<string, number> = {};
    for (const [name, value] of Object.entries(row)) if (typeof value === 'number' && Number.isFinite(value)) env[name] = value;
    const extra: Record<string, PlantValue> = {};
    for (const { entry, evaluate } of compiled) {
      const result = evaluate(env);
      extra[entry.name] = result.ok ? result.value : null;
    }
    return { ...row, ...extra };
  });
  for (const [name, wanted] of Object.entries(definition.filter ?? {})) rows = rows.filter((row) => (row[name] ?? null) === wanted);
  const order = definition.sort ?? [];
  if (order.length > 0)
    rows = rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        for (const entry of order) {
          const descending = entry.startsWith('-');
          const name = descending ? entry.slice(1) : entry;
          const delta = compare(a.row[name], b.row[name]);
          if (delta !== 0) return descending ? -delta : delta;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.row);
  const computedColumns: ReportColumn[] = computed.map((entry) => columnOf(entry.name, entry.displayName, 'real', entry.unit, 'derived'));
  const all = [...table.columns, ...computedColumns];
  const columns =
    definition.columns === undefined ? all : definition.columns.map((name) => all.find((column) => column.name === name) as ReportColumn);
  const names = columns.map((column) => column.name);
  return {
    ok: true,
    table: {
      ...table,
      columns,
      rows: rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name] ?? null]))),
      keyColumn: table.keyColumn !== null && names.includes(table.keyColumn) ? table.keyColumn : null,
      totals: Object.keys(definition.filter ?? {}).length === 0 ? table.totals : {},
    },
  };
}
