/**
 * Plant 04 PID-FU2: the rating of a P&ID nozzle (text attribute `rating`) against the 03 EQP nozzle record, P3D_CLASS_MISMATCH at the nozzle.
 * Scene: SC-RTE-01 as in pid3dNozzles.test.ts (V-101/N1 and P-101/N2 are CL150 records).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { PidNozzle, PidValue } from '@aec/plant/pid/model';
import { getPid, withPid as withPidModel } from '@aec/plant/pid/state';
import { data } from '../../../helpers/commandAssertions';
import { byTag, ofKind } from './authoringFixtures';
import { CLEAN_INLINE, routedWithValves, withPid } from './pid3dM7b';

interface Answer {
  items: Array<{ code: string; item: string; values: Record<string, unknown> }>;
  skipped: Array<{ code: string; reason: string }>;
}
const check = (doc: CadDocument): Answer => data<Answer>(doc, 'check_pid_3d', {});
const clean = (): CadDocument => withPid(routedWithValves(), { pipingClass: 'CS150', inline: CLEAN_INLINE });

const rated = (doc: CadDocument, equipmentTag: string, subTag: string, rating: unknown): CadDocument => {
  const equipment = byTag(doc, equipmentTag);
  const nozzle = ofKind(doc, 'nozzle').find((n) => n.equipmentId === equipment.id && n.subTag === subTag) as PidNozzle;
  const pid = getPid(doc);
  const attributes: Record<string, PidValue> = rating === undefined ? {} : { rating: rating as PidValue };
  return withPidModel(doc, { ...pid, items: { ...pid.items, [nozzle.id]: { ...nozzle, attributes } } });
};
const text = (value: string): object => ({ kind: 'text', value });

describe('P&ID nozzle rating against the 3D nozzle record', () => {
  it('no rating attribute: no comparison and no skip; the same rating spelled CL150 / Class 150 / 150# / "cl 150" is a match', () => {
    expect(check(clean()).items).toEqual([]);
    for (const spelling of ['CL150', 'Class 150', '150#', 'cl 150', '150 lb'])
      expect(check(rated(clean(), 'V-101', 'N1', text(spelling))).items, spelling).toEqual([]);
  });

  it('a different rating is P3D_CLASS_MISMATCH at the nozzle with both values (V-101/N1: P&ID CL300, 3D CL150); PN16 against CL150 differs too', () => {
    const answer = check(rated(clean(), 'V-101', 'N1', text('CL300')));
    expect(answer.items.map((f) => [f.code, f.item])).toEqual([['P3D_CLASS_MISMATCH', 'V-101/N1']]);
    expect(answer.items[0]?.values).toEqual({ pidRating: 'CL300', modelRating: 'CL150' });
    expect(check(rated(clean(), 'P-101', 'N2', text('PN 16'))).items.map((f) => f.item)).toEqual(['P-101/N2']);
  });

  it('a numeric rating attribute is not text and is not compared; the document is unchanged by the check', () => {
    const doc = rated(clean(), 'V-101', 'N1', { kind: 'quantity', value: 300, unit: 'lb' });
    expect(check(doc).items).toEqual([]);
    const result = execute(doc, 'check_pid_3d', {});
    expect(result.document).toBe(doc);
  });
});
