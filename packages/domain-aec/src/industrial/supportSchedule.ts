/**
 * Pipe support schedule: one row per support with its pipe, line, type, steel it bears on, position
 * and hanger rod length.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import { getBuilding } from '../model';
import { round } from '../numeric';

export function supportSchedule(doc: CadDocument): {
  columns: string[];
  rows: Array<Array<string | number>>;
} {
  const building = getBuilding(doc);
  const rows = building.elementOrder.flatMap((id) => {
    const support = building.elements[id];
    if (support?.category !== 'pipeSupport') return [];
    const pipe = building.elements[support.pipeId];
    const member = support.memberId === null ? undefined : building.elements[support.memberId];
    const level = building.levels[support.levelId];
    return [
      [
        support.mark,
        pipe?.category === 'pipe' ? (pipe.line ?? '') : '',
        pipe?.mark ?? support.pipeId,
        support.type,
        member?.category === 'member' ? member.mark : '',
        round(support.position[0], 1),
        round(support.position[1], 1),
        round((level?.elevation ?? 0) + support.position[2], 1),
        support.type === 'hanger' ? round(support.rodLength, 1) : '',
        level?.name ?? support.levelId,
        member?.category === 'member' ? 'attached' : 'UNATTACHED',
      ],
    ];
  });
  return {
    columns: [
      'Mark',
      'Line',
      'Pipe',
      'Type',
      'Bears on',
      'x',
      'y',
      'z',
      `Rod length (${doc.units})`,
      'Level',
      'Status',
    ],
    rows,
  };
}
