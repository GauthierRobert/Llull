/**
 * Tables printed on a final isometric (plant 05 ISO §6.2, TR-ISO-10): bill of material, cut list, weld list, spool list. They are the same rows the queries return
 * (`bomRows`, `cutPieces`, the numbering plan, the spool plan), as text cells. The cut list needs a stored weld gap (no silent default): without one the table is
 * left out and `ISO_GAP_UNDEFINED` is reported as a warning. Pure.
 */

import { distance3 } from '@lib/vec3';
import type { LineAnalysis } from '../analysis';
import { bomRows } from '../bom';
import { isoIssue } from '../codes';
import { cutPieces } from '../cutList';
import type { IsoIssue } from '../model';
import { mmText } from './isoDimensions';

export const TABLE_NAMES = ['bom', 'cut_list', 'weld_list', 'spool_list'] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export interface IsoTable {
  readonly name: TableName;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

const TITLES: Readonly<Record<TableName, string>> = {
  bom: 'BILL OF MATERIAL',
  cut_list: 'CUT LIST',
  weld_list: 'WELD LIST',
  spool_list: 'SPOOL LIST',
};

/** The part of the line a sheet prints: component indices; `partial` = the sheet is one of several of the same spools (pieces and pipe length on the sheet, not whole-spool metrics). */
export interface TableScope {
  readonly indices: ReadonlySet<number>;
  readonly partial: boolean;
}

export function isoTables(
  analysis: LineAnalysis,
  wanted: readonly TableName[],
  scope?: TableScope,
): { tables: IsoTable[]; warnings: IsoIssue[] } {
  const inside = (index: number): boolean => scope === undefined || scope.indices.has(index);
  const componentsOfLine = analysis.read.network.components;
  const idsInside = new Set(componentsOfLine.flatMap((component, index) => (inside(index) ? [component.id] : [])));
  const tables: IsoTable[] = [];
  const warnings: IsoIssue[] = [];
  const rules = analysis.fabrication.rules;
  for (const name of TABLE_NAMES.filter((candidate) => wanted.includes(candidate))) {
    const make = (columns: string[], rows: string[][]): void => {
      tables.push({ name, title: TITLES[name], columns, rows });
    };
    if (name === 'bom') {
      const result = bomRows(analysis.read.network.components, inside);
      make(
        ['ITEM', 'QTY', 'UNIT', 'DESCRIPTION'],
        result.rows.map((row) => [
          row.itemCode,
          String(row.quantity),
          row.unit,
          `${row.description ?? row.type}${row.unverified === true ? ' (UNVERIFIED)' : ''}`,
        ]),
      );
    } else if (name === 'cut_list') {
      const gap = rules?.weldGapMm;
      const fieldFit = [...analysis.classes.values()].some((kind) => kind === 'field_fit');
      if (gap === undefined || (fieldFit && rules?.fieldFitAllowanceMm === undefined)) {
        warnings.push(
          isoIssue(
            'ISO_GAP_UNDEFINED',
            'warning',
            'the cut list table is left out: no stored weld gap (or field-fit allowance); set_fabrication_rules first',
            [analysis.lineId],
          ),
        );
        continue;
      }
      const pieces = cutPieces(analysis, gap.value, rules?.fieldFitAllowanceMm?.value ?? 0);
      make(
        ['PIECE', 'BORE', 'CENTRELINE', 'CUT'],
        pieces
          .filter((piece) => idsInside.has(piece.componentId))
          .map((piece) => [piece.piece, String(piece.boreMm), mmText(piece.centrelineLengthMm), mmText(piece.cutLengthMm)]),
      );
    } else if (name === 'weld_list') {
      const names = analysis.spools.spools.map((spool) => spool.name);
      make(
        ['WELD', 'KIND', 'SPOOL', 'BORE', 'AT (X Y Z)'],
        analysis.numbering.entries
          .filter((entry) => entry.joint.members.some(inside))
          .map((entry) => [
            entry.record.number,
            entry.record.kind.toUpperCase(),
            names[analysis.spools.spoolOf.get(entry.joint.members[0] ?? -1) ?? -1] ?? '-',
            String(entry.record.joint.boreMm),
            entry.record.joint.xyz.map(mmText).join(' '),
          ]),
      );
    } else {
      const listed = analysis.spools.spools.filter((spool) => spool.memberIndices.some(inside));
      if (scope?.partial === true)
        make(
          ['SPOOL', 'PIECES ON SHEET', 'PIPE LENGTH ON SHEET'],
          listed.map((spool) => {
            const onSheet = spool.memberIndices.filter((index) => inside(index) && componentsOfLine[index]?.type === 'PIPE');
            const length = onSheet.reduce((sum, index) => {
              const [start, end] = componentsOfLine[index]?.ends ?? [];
              return start === undefined || end === undefined ? sum : sum + distance3(start.xyz, end.xyz);
            }, 0);
            return [spool.name, String(onSheet.length), mmText(length)];
          }),
        );
      else
        make(
          ['SPOOL', 'PIECES', 'LENGTH', 'WEIGHT KG'],
          listed.map((spool) => [
            spool.name,
            String(spool.pieces),
            mmText(spool.lengthMm),
            `${mmText(spool.weightKg)}${spool.weightComplete ? '' : '+'}`,
          ]),
        );
    }
  }
  return { tables, warnings };
}
