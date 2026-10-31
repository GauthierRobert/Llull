/** `pid_report kind=line_list`: one row per line (plant 04 PID §5.7). */

import type { PidModel, PidSegment } from '../model';
import { itemsOf } from './counts';
import { attributeText, endLabel, sheetNumber, sortedRows, type Entry, type ListResult } from './lookup';

export const LINE_LIST_COLUMNS = [
  'lineNumber',
  'sheet',
  'dn',
  'pipingClass',
  'fluidCode',
  'from',
  'to',
  'segments',
  'insulation',
  'inlineTags',
] as const;

const INSULATION = ['InsulationTypeAssignmentClass', 'InsulationType'];

/** `segments` counts the stored segments of the line (an inline item splits one drawn segment in two); from / to are the first segment's start and the last one's end; inlineTags the tags of the inline items along the line. */
export function lineList(pid: PidModel, sheetId?: string): ListResult {
  const entries: Entry[] = [];
  for (const line of itemsOf(pid, sheetId)) {
    if (line.kind !== 'line') continue;
    const segments = line.segmentIds.flatMap((id): PidSegment[] => {
      const segment = pid.items[id];
      return segment?.kind === 'segment' ? [segment] : [];
    });
    const first = segments[0];
    const last = segments[segments.length - 1];
    const tags = segments.flatMap((segment) => {
      const end = segment.to;
      const inline = end.type === 'inline' ? pid.items[end.itemId] : undefined;
      return inline?.tag === undefined ? [] : [inline.tag];
    });
    const insulation = [line, ...segments].map((item) => attributeText(item, INSULATION)).find((text) => text !== '') ?? '';
    entries.push({
      id: line.id,
      row: {
        lineNumber: line.lineNumber ?? '',
        sheet: sheetNumber(pid, line),
        dn: line.dn ?? first?.dn ?? '',
        pipingClass: line.pipingClass ?? first?.pipingClass ?? '',
        fluidCode: line.fluidCode ?? '',
        from: first === undefined ? '' : endLabel(pid, first.from),
        to: last === undefined ? '' : endLabel(pid, last.to),
        segments: segments.length,
        insulation,
        inlineTags: tags.join(' '),
      },
    });
  }
  return { columns: LINE_LIST_COLUMNS, rows: sortedRows(entries, 'lineNumber') };
}
