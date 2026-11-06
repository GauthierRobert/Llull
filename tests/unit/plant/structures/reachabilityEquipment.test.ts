/**
 * STA-FU: `check_reachability` `targetsFrom: ['nozzles', 'manways']` (03 EQP). SC-STA-07 plant (vessel block D 3000, half-round platform radii 1650..2650 at +6000,
 * caged ladder from grade); nozzles on the block are `free` (face position given in the equipment frame).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const BAND = { min: 0, max: 1800, source: 'project rule (owner supplied)' };
const PACK = {
  equipmentId: 'equipment-1',
  elevation: 6000,
  startAngleDeg: 0,
  sweepDeg: 180,
  gap: 150,
  width: 1000,
  railing: { edges: ['outer', 'ends'], height: 1100 },
};
const LADDER = { base: [2150, -250, 0], facing: [0, 1], attachTo: 'assembly-1', exit: 'through', fallProtection: 'cage' };

function nozzle(mark: string, position: [number, number, number], service?: string): Record<string, unknown> {
  return {
    equipment: 'C-101',
    mark,
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    projection: 200,
    ...(service === undefined ? {} : { service }),
    location: { on: 'free', position, direction: [1, 0, 0] },
  };
}

function plant(withLadder = true): CadDocument {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
  doc = apply(doc, 'add_equipment', {
    name: 'Column',
    mark: 'C-101',
    location: [0, 0],
    size: [3000, 3000, 18000],
    shape: 'vertical_vessel',
  });
  doc = apply(doc, 'add_circular_access_platform', PACK);
  if (withLadder) doc = apply(doc, 'add_ladder', LADDER);
  return doc;
}

interface Answer {
  verdict: string;
  targets: Array<{
    tag: string;
    ok: boolean;
    surfaceId: string | null;
    heightAboveSurfaceMm: number | null;
    findings: Array<{ code: string }>;
  }>;
}
const reach = (doc: CadDocument, targetsFrom: string[]): Answer =>
  data<Answer>(doc, 'check_reachability', { targetsFrom, operatingHeightMm: BAND, maxHorizontalReachMm: 600 });

describe('check_reachability targetsFrom nozzles / manways', () => {
  const doc = [nozzle('N1', [1500, 0, 6900]), nozzle('M1', [1500, 500, 6900], 'Manway 24in'), nozzle('N2', [1500, -500, 9000])].reduce(
    (acc, params) => apply(acc, 'add_nozzle', params),
    plant(),
  );
  const port = (mark: string): number[] => {
    const ports = data<{ ports: Record<string, { position: number[] }> }>(doc, 'equipment_ports', { equipment: 'C-101' }).ports;
    return ports[`C-101:${mark}`]?.position ?? [];
  };

  it('nozzles: every non-manway nozzle is a target at its flange face, judged from the platform; the manway is left to "manways"', () => {
    const answer = reach(doc, ['nozzles']);
    expect(answer.targets.map((item) => item.tag)).toEqual(['C-101:N1', 'C-101:N2']);
    const [n1, n2] = answer.targets;
    expect(n1).toMatchObject({ ok: true, surfaceId: 'assembly-1', findings: [] });
    expect(n1?.heightAboveSurfaceMm).toBeCloseTo((port('N1')[2] ?? 0) - 6000, 6);
    // N2 is above the band max (1800): STA_OPERATING_HEIGHT, a fail
    expect(n2?.findings.map((finding) => finding.code)).toEqual(['STA_OPERATING_HEIGHT']);
    expect(answer.verdict).toBe('fail');
  });

  it('manways: only the nozzle whose service names a manway, kind manway', () => {
    const answer = reach(doc, ['manways']);
    expect(answer.targets.map((item) => item.tag)).toEqual(['C-101:M1']);
    expect(answer.targets[0]?.ok).toBe(true);
    expect(answer.verdict).toBe('pass');
  });

  it('both sources together, explicit targets first, valves absent: three targets; a tag clash with an explicit target is refused', () => {
    const both = reach(doc, ['nozzles', 'manways']);
    expect(both.targets.map((item) => item.tag).sort()).toEqual(['C-101:M1', 'C-101:N1', 'C-101:N2']);
    expectRefusal(
      doc,
      'check_reachability',
      {
        targetsFrom: ['manways'],
        targets: [{ tag: 'C-101:M1', kind: 'x', point: [0, 0, 0] }],
        operatingHeightMm: BAND,
        maxHorizontalReachMm: 600,
      },
      'STA_TARGET_DUPLICATE',
      'targets',
    );
  });

  it('without the ladder the platform has no route: STA_ACCESS_NO_EGRESS on the nozzle', () => {
    let lonely = plant(false);
    lonely = apply(lonely, 'add_nozzle', nozzle('N1', [1500, 0, 6900]));
    expect(reach(lonely, ['nozzles']).targets[0]?.findings.map((finding) => finding.code)).toContain('STA_ACCESS_NO_EGRESS');
  });

  it('equipment without nozzles gives no target (nothing judged, 0 targets); in metres the points are converted', () => {
    expect(reach(plant(), ['nozzles']).targets).toEqual([]);
    let metres = apply(createEmptyDocument(), 'set_units', { units: 'm' });
    metres = apply(metres, 'add_level', { name: 'Grade', elevation: 0, height: 6 });
    metres = apply(metres, 'add_equipment', {
      name: 'Column',
      mark: 'C-101',
      location: [0, 0],
      size: [3, 3, 18],
      shape: 'vertical_vessel',
    });
    metres = apply(metres, 'add_nozzle', { ...nozzle('N1', [1.5, 0, 1]), projection: 0.2 });
    const answer = data<Answer & { targets: Array<{ heightAboveSurfaceMm: number | null }> }>(metres, 'check_reachability', {
      targetsFrom: ['nozzles'],
      operatingHeightMm: BAND,
      maxHorizontalReachMm: 100000,
    });
    expect(answer.targets[0]?.heightAboveSurfaceMm).toBeCloseTo(1000, 3);
  });

  it('is read-only and pure', () => {
    expectPure(doc, () =>
      execute(doc, 'check_reachability', { targetsFrom: ['nozzles'], operatingHeightMm: BAND, maxHorizontalReachMm: 600 }),
    );
  });
});

describe('which nozzles are manways', () => {
  it('the word manway / manways, any case; not inside a longer word, not after "non-"', () => {
    const services: Array<[string, boolean]> = [
      ['Manway 24in', true],
      ['MANWAYS', true],
      ['access manway', true],
      ['manwayish', false],
      ['non-manway drain', false],
      ['non manway', false],
      ['inlet', false],
    ];
    let model = plant();
    services.forEach(([service], index) => {
      model = apply(model, 'add_nozzle', nozzle(`S${index}`, [1500, index * 100, 6900], service));
    });
    const manways = reach(model, ['manways']).targets.map((item) => item.tag);
    const expected = services.flatMap(([, isManway], index) => (isManway ? [`C-101:S${index}`] : []));
    expect(manways).toEqual(expected);
    expect(reach(model, ['nozzles']).targets).toHaveLength(services.length - expected.length);
  });
});
