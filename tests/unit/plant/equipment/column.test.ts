import { describe, expect, it } from 'vitest';
import type { CadDocument, RevolutionEntity } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { mmDocument, separatorParams } from './equipmentFixtures';

interface ColumnData {
  elementId: string;
  trays: Array<{ index: number; elevation: number }>;
  clips: Array<{ elevation: number; fromDeg: number; toDeg: number; depth: number; height: number }>;
  bottomTangentLine: number;
}

const without = (source: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
const verticalParams = without(separatorParams, 'orientation');
const column = {
  ...verticalParams,
  tag: 'C-301',
  insideDiameter: 2000,
  tangentLength: 15000,
  trays: { count: 20, spacing: 600, firstElevation: 1500, type: 'sieve' },
};
const equipmentOf = (doc: CadDocument): EquipmentElement =>
  Object.values(doc.building?.elements ?? {}).find(
    (element): element is EquipmentElement => element.category === 'equipment',
  ) as EquipmentElement;

describe('add_process_column (VC-EQP-21)', () => {
  it('records the tray stack: elevation_i = firstElevation + (i - 1) x spacing above the bottom tangent line', () => {
    const result = ok(mmDocument(), 'add_process_column', column);
    const report = result.data as ColumnData;
    expect(report.trays).toHaveLength(20);
    expect(report.trays[0]).toEqual({ index: 1, elevation: 1500 });
    expect(report.trays[19]).toEqual({ index: 20, elevation: 12900 });
    expect(report.bottomTangentLine).toBe(2000);
    const element = equipmentOf(result.document);
    expect(element.mark).toBe('C-301');
    expect(element.plant?.template.kind === 'vessel' && element.plant.template.trays).toEqual({
      count: 20,
      spacing: 600,
      firstElevation: 1500,
      type: 'sieve',
    });
    expect(element.shape).toBe('vertical_vessel');
  });

  it('is ONE step in the feature history: it composes add_vessel through execute without a second recorded step', () => {
    const result = ok(mmDocument(), 'add_process_column', column);
    expect(result.document.featureHistory.map((step) => step.name)).toEqual(['set_units', 'add_process_column']);
  });

  it('30 trays do not fit: EQP_TRAYS_DONT_FIT at trays.count and nothing is created', () => {
    const refusal = expectRefusal(
      mmDocument(),
      'add_process_column',
      { ...column, trays: { ...column.trays, count: 30 } },
      'EQP_TRAYS_DONT_FIT',
      'trays.count',
    );
    expect(refusal.summary).toContain('18900');
  });

  it('records platform clips as partial rings on the shell, angles stored north_cw whatever the convention', () => {
    const clips = [
      { elevation: 3000, fromDeg: 0, toDeg: 90 },
      { elevation: 9000, fromDeg: 180, toDeg: 270, depth: 150, height: 120 },
    ];
    const north = ok(mmDocument(), 'add_process_column', { ...column, platformClips: clips });
    const report = north.data as ColumnData;
    expect(report.clips[0]).toEqual({ elevation: 3000, fromDeg: 0, toDeg: 90, depth: 100, height: 100 });
    expect(report.clips[1]).toEqual({ elevation: 9000, fromDeg: 180, toDeg: 270, depth: 150, height: 120 });
    const element = equipmentOf(north.document);
    const ring = north.document.entities[`${element.id}:clip-1`] as RevolutionEntity;
    expect(ring.kind).toBe('revolution');
    expect(ring.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(ring.position[2]).toBe(2000 + 3000);
    const east = data<ColumnData>(mmDocument(), 'add_process_column', {
      ...column,
      angleConvention: 'east_ccw',
      platformClips: [{ elevation: 3000, fromDeg: 0, toDeg: 90 }],
    });
    expect(east.clips[0]).toMatchObject({ fromDeg: 0, toDeg: 90 });
    const wrapped = data<ColumnData>(mmDocument(), 'add_process_column', {
      ...column,
      platformClips: [{ elevation: 3000, fromDeg: 300, toDeg: 60 }],
    });
    expect(wrapped.clips[0]).toMatchObject({ fromDeg: 300, toDeg: 60 });
  });

  it('refuses a clip above the shell and an empty arc; passes add_vessel refusals through with their code', () => {
    expectRefusal(
      mmDocument(),
      'add_process_column',
      { ...column, platformClips: [{ elevation: 20000, fromDeg: 0, toDeg: 90 }] },
      'EQP_PARAM_INVALID',
      'platformClips.0.elevation',
    );
    expectRefusal(
      mmDocument(),
      'add_process_column',
      { ...column, platformClips: [{ elevation: 100, fromDeg: 45, toDeg: 45 }] },
      'EQP_PARAM_INVALID',
      'platformClips.0.toDeg',
    );
    const first = apply(mmDocument(), 'add_process_column', column);
    const duplicate = expectRefusal(first, 'add_process_column', column, 'EQP_TAG_DUPLICATE', 'tag');
    expect(duplicate.summary).toMatch(/^add_process_column: /);
    expectRefusal(mmDocument(), 'add_process_column', { ...column, shellThickness: 2 }, 'EQP_PARAM_INVALID', 'shellThickness');
  });

  it('a column without trays or clips is a plain vertical vessel', () => {
    const plain = without(column, 'trays');
    const result = ok(mmDocument(), 'add_process_column', plain);
    expect((result.data as ColumnData).trays).toEqual([]);
  });

  it('trays still have to fit after a revision of the tangent length', () => {
    const doc = apply(mmDocument(), 'add_process_column', column);
    expectRefusal(
      doc,
      'update_equipment_parameters',
      { equipment: 'C-301', set: { tangentLength: 10000 } },
      'EQP_TRAYS_DONT_FIT',
      'set.tangentLength',
    );
  });
});
