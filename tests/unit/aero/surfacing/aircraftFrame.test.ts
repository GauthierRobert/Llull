import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { entityBounds } from '@core/geometry/bounds';
import { runPlan } from '../../../golden/runPlan';
import type { GoldenAction } from '../../../golden/plans';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';

const empty = createEmptyDocument();
const identity = { datum: [0, 0, 0], fsAxis: [1, 0, 0], blAxis: [0, 1, 0], wlAxis: [0, 0, 1], units: 'mm' };
const cylinderStations = [
  { fs: 0, section: { type: 'circle', radius: 2, wl: 0 } },
  { fs: 5, section: { type: 'circle', radius: 2, wl: 0 } },
  { fs: 10, section: { type: 'circle', radius: 2, wl: 0 } },
];
const sectionData = (doc: CadDocument, bodyId: string, fs: number): Record<string, unknown> =>
  execute(doc, 'fuselage_section_at', { bodyId, fs }).data as Record<string, unknown>;

describe('set_aircraft_frame', () => {
  it('stores the frame, survives save / load and is a no-entity change', () => {
    const result = execute(empty, 'set_aircraft_frame', { ...identity, datum: [1, 2, 3] });
    expect(result.affected).toEqual([]);
    expect(result.document.aero?.frame?.datum).toEqual([1, 2, 3]);
    const loaded = deserializeDocument(serializeDocument(result.document));
    expect(loaded.aero?.frame).toEqual(result.document.aero?.frame);
  });

  it('refuses axes that are not unit, perpendicular and right-handed, and a unit that differs from the document', () => {
    const refused = (patch: Record<string, unknown>, code: string): void =>
      expectNoOp(execute(empty, 'set_aircraft_frame', { ...identity, ...patch }), empty, code);
    refused({ fsAxis: [2, 0, 0] }, 'AERO_FRAME_NOT_ORTHONORMAL');
    refused({ blAxis: [1, 0, 0] }, 'AERO_FRAME_NOT_ORTHONORMAL');
    refused({ wlAxis: [0, 0, -1] }, 'AERO_FRAME_NOT_ORTHONORMAL');
    refused({ units: 'm' }, 'AERO_PARAM_INVALID');
    refused({ datum: [Number.POSITIVE_INFINITY, 0, 0] }, 'invalid params');
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'set_aircraft_frame', identity));
  });

  it('maps loft_fuselage stations through the frame and fuselage_section_at reads them back in that frame', () => {
    const plain = execute(empty, 'loft_fuselage', { stations: cylinderStations });
    // FS along +y, BL along +z, WL along +x (cyclic, right-handed), datum shifted
    const framed = execute(empty, 'set_aircraft_frame', {
      datum: [100, 0, 0],
      fsAxis: [0, 1, 0],
      blAxis: [0, 0, 1],
      wlAxis: [1, 0, 0],
      units: 'mm',
    });
    const lofted = execute(framed.document, 'loft_fuselage', { stations: cylinderStations });
    const box = entityBounds(lofted.document.entities[lofted.affected[0]!]!);
    expect(box.min[1]).toBeCloseTo(0, 6);
    expect(box.max[1]).toBeCloseTo(10, 6);
    expect(box.min[0]).toBeCloseTo(98, 6);
    expect(box.max[0]).toBeCloseTo(102, 6);
    const [a, b] = [sectionData(plain.document, plain.affected[0]!, 4), sectionData(lofted.document, lofted.affected[0]!, 4)];
    for (const key of ['area', 'perimeter', 'halfBreadth', 'crownWl', 'keelWl']) expect(b[key]).toBeCloseTo(a[key] as number, 6);
  });
});

describe('fuselage_section_at', () => {
  const body = execute(empty, 'loft_fuselage', { stations: cylinderStations });
  const id = body.affected[0]!;

  it('measures a circular section on the exact skin (area and perimeter of radius 2, between stations too)', () => {
    for (const fs of [0, 3.3, 5, 10]) {
      const data = sectionData(body.document, id, fs) as {
        area: number;
        perimeter: number;
        halfBreadth: number;
        crownWl: number;
        keelWl: number;
      };
      expect(data.area).toBeCloseTo(4 * Math.PI, 3);
      expect(data.perimeter).toBeCloseTo(4 * Math.PI, 3);
      expect(data.halfBreadth).toBeCloseTo(2, 6);
      expect(data.crownWl).toBeCloseTo(2, 6);
      expect(data.keelWl).toBeCloseTo(-2, 6);
    }
    const result = execute(body.document, 'fuselage_section_at', { bodyId: id, fs: 5 });
    expect(result.affected).toEqual([]);
    expect((result.data as { curve: { degree: number; poles: number[][] } }).curve.poles.length).toBeGreaterThan(20);
    expect(result.summary).toContain('fuselage_section_at');
  });

  it('reports a zero area and no curve at an apex station', () => {
    const cone = execute(empty, 'loft_fuselage', {
      stations: [
        { fs: 0, section: { type: 'point', wl: 0 } },
        { fs: 4, section: { type: 'circle', radius: 1, wl: 0 } },
      ],
      degreeV: 1,
    });
    const tip = sectionData(cone.document, cone.affected[0]!, 0) as { area: number; curve: unknown };
    expect([tip.area, tip.curve]).toEqual([0, null]);
    expect((sectionData(cone.document, cone.affected[0]!, 2) as { area: number }).area).toBeCloseTo(Math.PI / 4, 3);
  });

  it('refuses an unknown body and an fs outside the body, leaving the document alone', () => {
    expectNoOp(execute(body.document, 'fuselage_section_at', { bodyId: 'nope', fs: 1 }), body.document, 'AERO_BODY_NOT_FOUND');
    expectNoOp(execute(body.document, 'fuselage_section_at', { bodyId: id, fs: 11 }), body.document, 'AERO_FS_OUT_OF_RANGE');
    expectPure(body.document, () => execute(body.document, 'fuselage_section_at', { bodyId: id, fs: 2 }));
  });
});

describe('target_sears_haack_conic_fuselage.json (VC-SRF-13)', () => {
  it('runs: set_aircraft_frame then the 19-station conic body (its closing mass_properties targets a sheet and is refused)', () => {
    const plan = JSON.parse(
      readFileSync(
        join(process.cwd(), 'docs/aerospace/02-advanced-surfacing/validation/plans/target_sears_haack_conic_fuselage.json'),
        'utf8',
      ),
    ) as GoldenAction[];
    expect(runPlan(plan).failedSteps).toHaveLength(1);
    const outcome = runPlan(plan.filter((action) => action.command !== 'mass_properties'));
    expect(outcome.failedSteps).toEqual([]);
    expect(outcome.document.aero?.frame?.fsAxis).toEqual([1, 0, 0]);
    const [id] = Object.keys(outcome.document.aero?.bodies ?? {});
    expect(id).toBeDefined();
    const mid = execute(outcome.document, 'fuselage_section_at', { bodyId: id, fs: 5 }).data as { area: number };
    expect(mid.area).toBeCloseTo(Math.PI * 0.5 ** 2, 3);
  });
});

describe('frame stored on the body', () => {
  it('a section is cut in the frame of the loft: setting another frame afterwards changes nothing', () => {
    const lofted = execute(empty, 'loft_fuselage', { stations: cylinderStations });
    const id = lofted.affected[0]!;
    const before = sectionData(lofted.document, id, 4);
    const moved = execute(lofted.document, 'set_aircraft_frame', {
      datum: [7, 0, 0],
      fsAxis: [0, 1, 0],
      blAxis: [0, 0, 1],
      wlAxis: [1, 0, 0],
      units: 'mm',
    });
    expect(sectionData(moved.document, id, 4)).toEqual(before);
    expect(moved.document.aero!.bodies![id]!.frame?.fsAxis).toEqual([1, 0, 0]);
  });

  it('rejects a stored body frame that is not orthonormal on load', () => {
    const lofted = execute(empty, 'loft_fuselage', { stations: cylinderStations });
    const id = lofted.affected[0]!;
    const json = JSON.parse(serializeDocument(lofted.document)) as {
      document: { aero: { bodies: Record<string, { frame: { fsAxis: number[] } }> } };
    };
    json.document.aero.bodies[id]!.frame.fsAxis = [2, 0, 0];
    expect(() => deserializeDocument(JSON.stringify(json))).toThrow();
  });
});
