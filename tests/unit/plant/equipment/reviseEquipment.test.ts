/**
 * Plant 03 EQP-FU: update_equipment_parameters revises parametric exchangers, tanks and pumps in place (id, tag, nozzle marks, port ids kept; every
 * nozzle re-validated; connected routes stretched). Reference values are hand calculations of the validation pack (API 650 5.6.3 one-foot method,
 * ISO 2858 envelope placement, SC-EQP-03 exchanger frame).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import type { ExchangerTemplate, PumpTemplate, TankTemplate } from '@aec/plant/equipment/plantData';
import type { PipeRun } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document } from '../piping/rteFixtures';
import { bemDocument, bemParams, drumDocument, mmDocument, pumpDocument, tankDocument, tankParams } from './equipmentFixtures';

const equipmentOf = (doc: CadDocument, tag: string): EquipmentElement => {
  const found = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === tag);
  if (found?.category !== 'equipment') throw new Error(`no equipment ${tag}`);
  return found;
};
const templateOf = <T>(doc: CadDocument, tag: string): T => equipmentOf(doc, tag).plant?.template as T;

interface Report {
  changed: string[];
  movedPorts: Array<{ id: string; from: number[]; to: number[]; distance: number }>;
  portIds: string[];
  kind: string;
  defaulted: string[];
}

describe('update_equipment_parameters: exchangers', () => {
  const doc = bemDocument();

  it('lengthening the tubes by 1000 keeps the id, tag, marks and ports and moves every port 500 along X (origin = middle of the overall length)', () => {
    const before = equipmentOf(doc, 'E-301');
    const result = ok(doc, 'update_equipment_parameters', { equipment: 'E-301', exchanger: { tubes: { length: 5877 } } });
    const report = result.data as unknown as Report;
    const after = equipmentOf(result.document, 'E-301');
    expect(result.affected).toContain(before.id);
    expect(after.id).toBe(before.id);
    expect(report.kind).toBe('exchanger');
    expect(report.changed).toEqual(['tubes']);
    expect(report.portIds).toEqual(['E-301:S1', 'E-301:S2', 'E-301:T1', 'E-301:T2']);
    expect(report.movedPorts).toHaveLength(4);
    for (const port of report.movedPorts) {
      expect(port.distance).toBeCloseTo(500, 9);
      expect((port.to[0] as number) - (port.from[0] as number)).toBeCloseTo(-500, 9);
    }
    expect(after.plant?.nozzles.map((nozzle) => nozzle.mark)).toEqual(['S1', 'S2', 'T1', 'T2']);
    expect(after.plant?.nozzles).toEqual(before.plant?.nozzles);
    expect(after.size[0] - before.size[0]).toBeCloseTo(1000, 9);
    expect(after.weight).toBeGreaterThan(before.weight);
    expect(result.document.order).toEqual(doc.order);
    expect(Object.keys(result.document.entities).sort()).toEqual(Object.keys(doc.entities).sort());
  });

  it('a larger shell keeps the flange faces of the shell and channel nozzles in place (projection is axis-to-face)', () => {
    const result = ok(doc, 'update_equipment_parameters', { equipment: 'E-301', exchanger: { shellInsideDiameter: 700 } });
    const report = result.data as unknown as Report;
    expect(report.changed).toEqual(['shellInsideDiameter']);
    expect(report.movedPorts).toEqual([]);
    expect(templateOf<ExchangerTemplate>(result.document, 'E-301').shellInsideDiameter).toBe(700);
  });

  it('keeps what the patch did not touch: the support, the design data, the BWG wall provenance and the named defaults', () => {
    const withBwg = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      tubes: { outsideDiameter: 19.05, bwg: 14, count: 300, length: 4877 },
    });
    const old = templateOf<ExchangerTemplate>(withBwg, 'E-301');
    expect(old.tubes.wallUnverified).toBe(true);
    const next = templateOf<ExchangerTemplate>(
      apply(withBwg, 'update_equipment_parameters', { equipment: 'E-301', exchanger: { tubes: { count: 250 } } }),
      'E-301',
    );
    expect(next.tubes).toEqual({ ...old.tubes, count: 250 });
    expect(next.support).toEqual(old.support);
    expect(next.design).toEqual(old.design);
    expect(next.defaulted).toEqual(expect.arrayContaining(['tubes.passes', 'tubes.pitch', 'tubes.layoutAngleDeg']));
  });

  it('a patch that sets a defaulted field removes it from the defaulted list; design sides merge field by field', () => {
    const withBwg = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      tubes: { outsideDiameter: 19.05, bwg: 14, count: 300, length: 4877 },
    });
    const next = apply(withBwg, 'update_equipment_parameters', {
      equipment: 'E-301',
      exchanger: { tubes: { passes: 4 }, design: { shellSide: { temperatureC: 150 } } },
    });
    const template = templateOf<ExchangerTemplate>(next, 'E-301');
    expect(template.defaulted).not.toContain('tubes.passes');
    expect(template.defaulted).toContain('tubes.pitch');
    expect(template.design?.shellSide).toEqual({ pressure: { value: 1, unit: 'MPa' }, temperatureC: 150 });
    expect(template.design?.tubeSide).toEqual(templateOf<ExchangerTemplate>(withBwg, 'E-301').design?.tubeSide);
  });

  it('BEM -> BEU drops the rear channel (a U rear has none); nozzles that still fit stay', () => {
    const next = apply(doc, 'update_equipment_parameters', { equipment: 'E-301', exchanger: { temaType: 'BEU' } });
    const template = templateOf<ExchangerTemplate>(next, 'E-301');
    expect(template.temaType).toBe('BEU');
    expect(template.rearChannel).toBeUndefined();
    expect(template.tema.fixedTubesheet).toBe(false);
    expect(equipmentOf(next, 'E-301').plant?.nozzles).toHaveLength(4);
  });

  it('common fields (name, location, rotation) work on an exchanger and report the rotation', () => {
    const result = ok(doc, 'update_equipment_parameters', {
      equipment: 'E-301',
      set: { name: 'Cooler', location: [100, 8000], planRotationDeg: 90 },
    });
    expect((result.data as unknown as Report).changed).toEqual(['name', 'location', 'planRotationDeg']);
    expect(equipmentOf(result.document, 'E-301').name).toBe('Cooler');
  });

  it.each([
    ['tubes that cannot fit the shell', { tubes: { count: 5000 } }, 'EQP_PARAM_INVALID', 'exchanger.tubes.count'],
    [
      'a nozzle left outside the shell (S2 at station 4377, shell 3777)',
      { tubes: { length: 4277 } },
      'EQP_NOZZLE_OFF_BODY',
      'nozzles.S2.location.station',
    ],
    ['a TEMA letter that is not modelled', { temaType: 'BKM' }, 'EQP_TEMA_UNSUPPORTED', 'exchanger.temaType.1'],
    ['a flange face inside the new wall', { shellInsideDiameter: 1300 }, 'EQP_NOZZLE_PROJECTION_TOO_SHORT', 'nozzles.S1.projection'],
    ['a wall and a BWG gauge together', { tubes: { bwg: 14, wallThickness: 2 } }, 'EQP_PARAM_INVALID', 'exchanger.tubes.bwg'],
    ['a thickness below the allowance', { corrosionAllowance: 9 }, 'EQP_PARAM_INVALID', 'exchanger.shellThickness'],
  ])('refuses %s with its code, path and an unchanged document', (_name, exchanger, code, path) => {
    const result = expectRefusal(doc, 'update_equipment_parameters', { equipment: 'E-301', exchanger }, code, path);
    expect(result.document).toBe(doc);
  });

  it('refuses a pump patch on an exchanger and a vessel field in set; an identical value is a no-op', () => {
    expectRefusal(doc, 'update_equipment_parameters', { equipment: 'E-301', pump: { weightKg: 5 } }, 'EQP_PARAM_INVALID', 'pump');
    expectRefusal(
      doc,
      'update_equipment_parameters',
      { equipment: 'E-301', set: { insideDiameter: 700 } },
      'EQP_PARAM_INVALID',
      'set.insideDiameter',
    );
    const same = execute(doc, 'update_equipment_parameters', { equipment: 'E-301', exchanger: { shellInsideDiameter: 600 } });
    expect(same.document).toBe(doc);
    expect(same.affected).toEqual([]);
    expect(same.summary).toContain('nothing changed');
  });

  it('is pure: the input document is not modified', () => {
    const snapshot = JSON.stringify(doc);
    execute(doc, 'update_equipment_parameters', { equipment: 'E-301', exchanger: { tubes: { length: 5877 } } });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('update_equipment_parameters: tanks', () => {
  const doc = tankDocument();
  const withNozzle = apply(doc, 'add_nozzle', {
    equipment: 'T-401',
    mark: 'N1',
    dn: 300,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'shell', elevation: 1000, orientationDeg: 0 },
    projection: 10600,
  });

  it('a 24 m diameter re-derives the one-foot thickness of course 1: 4.9 x 24 x (12 - 0.3) x 1 / 160 + 1.5 = 10.0995 mm (not an input, still one_foot)', () => {
    const result = ok(doc, 'update_equipment_parameters', { equipment: 'T-401', tank: { diameter: 24000 } });
    const template = templateOf<TankTemplate>(result.document, 'T-401');
    expect(template.thicknessSource).toBe('one_foot');
    expect(template.courseThicknesses[0]).toBeCloseTo((4.9 * 24 * 11.7) / 160 + 1.5, 10);
    expect(template.courseThicknesses[0]).toBeCloseTo(10.0995, 10);
    expect(template.defaulted).toContain('courseThicknesses');
    expect((result.data as unknown as Report).changed).toEqual(expect.arrayContaining(['diameter', 'courseThicknesses']));
    expect(equipmentOf(result.document, 'T-401').id).toBe(equipmentOf(doc, 'T-401').id);
    expect(equipmentOf(result.document, 'T-401').size[0]).toBeGreaterThan(equipmentOf(doc, 'T-401').size[0]);
  });

  it('a corrosion allowance of 3 mm gives 4.9 x 20 x 11.7 / 160 + 3 = 10.16625 mm', () => {
    const next = apply(doc, 'update_equipment_parameters', { equipment: 'T-401', tank: { design: { corrosionAllowance: 3 } } });
    expect(templateOf<TankTemplate>(next, 'T-401').courseThicknesses[0]).toBeCloseTo(10.16625, 10);
    expect(templateOf<TankTemplate>(next, 'T-401').design.designLiquidLevel).toBe(12000);
  });

  it('given thicknesses are kept when the roof changes; a shell nozzle keeps its face (projection from the axis) while the shell grows', () => {
    const given = apply(mmDocument(), 'add_storage_tank', { ...tankParams, courseThicknesses: [12, 12, 10, 10, 8, 8] });
    const next = apply(given, 'update_equipment_parameters', { equipment: 'T-401', tank: { roof: { type: 'flat' } } });
    expect(templateOf<TankTemplate>(next, 'T-401').courseThicknesses).toEqual([12, 12, 10, 10, 8, 8]);
    expect(templateOf<TankTemplate>(next, 'T-401').thicknessSource).toBe('user');
    expect(templateOf<TankTemplate>(next, 'T-401').roof.type).toBe('flat');
    const grown = ok(withNozzle, 'update_equipment_parameters', { equipment: 'T-401', tank: { diameter: 21000 } });
    expect((grown.data as unknown as Report).movedPorts).toEqual([]);
    expect((grown.data as unknown as Report).portIds).toEqual(['T-401:N1']);
  });

  it.each([
    ['a nozzle whose face would sit inside the wall', { diameter: 22000 }, 'EQP_NOZZLE_PROJECTION_TOO_SHORT', 'nozzles.N1.projection'],
    ['courses that no longer add up', { shellHeight: 13000 }, 'EQP_COURSES_MISMATCH', 'tank.courses'],
    [
      'a design level above the shell',
      { shellHeight: 10000, courses: [2000, 2000, 2000, 2000, 2000] },
      'EQP_PARAM_INVALID',
      'tank.design.designLiquidLevel',
    ],
    ['a new course count with kept user thicknesses', { courses: [6000, 6000] }, 'EQP_PARAM_INVALID', 'tank.courseThicknesses'],
  ])('refuses %s', (_name, tank, code, path) => {
    const given = apply(withNozzle, 'update_equipment_parameters', {
      equipment: 'T-401',
      tank: { courseThicknesses: [10, 10, 10, 10, 10, 10] },
    });
    const result = expectRefusal(given, 'update_equipment_parameters', { equipment: 'T-401', tank }, code, path);
    expect(result.document).toBe(given);
  });

  it('refuses a vessel field in set and a tank patch on a pump', () => {
    expectRefusal(
      doc,
      'update_equipment_parameters',
      { equipment: 'T-401', set: { shellThickness: 9 } },
      'EQP_PARAM_INVALID',
      'set.shellThickness',
    );
    expectRefusal(
      pumpDocument(),
      'update_equipment_parameters',
      { equipment: 'P-101', tank: { diameter: 1 } },
      'EQP_PARAM_INVALID',
      'tank',
    );
  });
});

describe('update_equipment_parameters: pumps', () => {
  const doc = pumpDocument();

  it('a 1000 mm motor (600 before) re-derives the default baseplate and moves SUC and DIS 200 along -X; ids and marks stay', () => {
    const result = ok(doc, 'update_equipment_parameters', { equipment: 'P-101', pump: { driver: { length: 1000 } } });
    const report = result.data as unknown as Report;
    // machine -100 .. 500 + 100 + 1000, default baseplate +/- 100: centre (-200 + 1700) / 2 = 750 against 550 before
    expect(report.movedPorts.map((port) => port.id).sort()).toEqual(['P-101:DIS', 'P-101:SUC']);
    for (const port of report.movedPorts) expect((port.to[0] as number) - (port.from[0] as number)).toBeCloseTo(-200, 9);
    expect(report.portIds).toEqual(['P-101:SUC', 'P-101:DIS']);
    const template = templateOf<PumpTemplate>(result.document, 'P-101');
    expect(template.baseplate.length).toBe(1900);
    expect(template.defaulted).toContain('baseplate');
    expect(template.weightKg).toBe(310);
    expect(equipmentOf(result.document, 'P-101').size[0]).toBe(1900);
  });

  it('a new size re-places the nozzles and swaps DN and hardware; a removed driver (null) leaves the machine alone', () => {
    const next = apply(doc, 'update_equipment_parameters', { equipment: 'P-101', pump: { size: '80-50-200' } });
    const nozzles = equipmentOf(next, 'P-101').plant?.nozzles ?? [];
    expect(nozzles.map((nozzle) => [nozzle.mark, nozzle.dn])).toEqual([
      ['SUC', 80],
      ['DIS', 50],
    ]);
    expect(templateOf<PumpTemplate>(next, 'P-101').size).toBe('80-50-200');
    const bare = apply(doc, 'update_equipment_parameters', { equipment: 'P-101', pump: { driver: null } });
    expect(templateOf<PumpTemplate>(bare, 'P-101').driver).toBeUndefined();
  });

  it('keeps an extra free nozzle and re-validates it; a custom envelope keeps its source grade', () => {
    const custom = apply(mmDocument(), 'add_pump', {
      tag: 'P-9',
      location: [0, 0],
      standard: 'custom',
      rating: 'CL300',
      envelope: { a: 120, f: 450, h1: 200, h2: 250, suctionDn: 100, dischargeDn: 80, source: 'vendor drawing 7' },
      baseplate: { length: 1200, width: 500, height: 120 },
    });
    const withVent = apply(custom, 'add_nozzle', {
      equipment: 'P-9',
      mark: 'V1',
      dn: 25,
      rating: 'CL300',
      facing: 'RF',
      location: { on: 'free', position: [0, 0, 600], direction: [0, 0, 1] },
      projection: 100,
    });
    const next = apply(withVent, 'update_equipment_parameters', { equipment: 'P-9', pump: { envelope: { h2: 300 } } });
    expect(equipmentOf(next, 'P-9').plant?.nozzles.map((nozzle) => nozzle.mark)).toEqual(['SUC', 'DIS', 'V1']);
    expect(templateOf<PumpTemplate>(next, 'P-9').envelope).toMatchObject({ h2: 300, grade: 'A', source: 'vendor drawing 7' });
  });

  it.each([
    ['a size not in the table', { size: '125-100-315' }, 'EQP_PUMP_SIZE_UNKNOWN', 'pump.size'],
    ['size and envelope together', { size: '50-32-160', envelope: { a: 100 } }, 'EQP_PARAM_INVALID', 'pump.envelope'],
    ['an unknown rating', { rating: 'CL1234' }, 'EQP_RATING_UNKNOWN', 'pump.rating'],
    ['a new driver without all three sizes', { driver: { length: 1 } }, 'EQP_PARAM_INVALID', 'pump.driver'],
  ])('refuses %s', (_name, pump, code, path) => {
    const base = path === 'pump.driver' ? apply(doc, 'update_equipment_parameters', { equipment: 'P-101', pump: { driver: null } }) : doc;
    const result = expectRefusal(base, 'update_equipment_parameters', { equipment: 'P-101', pump }, code, path);
    expect(result.document).toBe(base);
  });

  it('is pure and a legacy block is still EQP_NOT_PARAMETRIC', () => {
    const snapshot = JSON.stringify(doc);
    execute(doc, 'update_equipment_parameters', { equipment: 'P-101', pump: { driver: { length: 1000 } } });
    expect(JSON.stringify(doc)).toBe(snapshot);
    const block = apply(mmDocument(), 'add_equipment', {
      name: 'Skid',
      mark: 'K-1',
      location: [0, 0],
      size: [1000, 1000, 1000],
      weight: 10,
    });
    expectRefusal(block, 'update_equipment_parameters', { equipment: 'K-1', set: { name: 'x' } }, 'EQP_NOT_PARAMETRIC', 'equipment');
    expectRefusal(
      drumDocument(),
      'update_equipment_parameters',
      { equipment: 'D-201', tank: { diameter: 1 } },
      'EQP_PARAM_INVALID',
      'tank',
    );
    expect(data<Report>(doc, 'update_equipment_parameters', { equipment: 'P-101', pump: { weightKg: 400 } }).changed).toEqual(['weightKg']);
  });
});

describe('update_equipment_parameters: connected routes are stretched like for a moved vessel', () => {
  /** Custom pump P-101 (DIS at (0, 0, 1000) facing +Z, DN100 CL150) routed to the vessel V-101 inlet. */
  function scene(): { doc: CadDocument; runId: string } {
    let base = cs150Document();
    base = apply(base, 'add_pump', {
      tag: 'P-101',
      location: [0, 0],
      standard: 'custom',
      rating: 'CL150',
      envelope: { a: 400, f: 400, h1: 450, h2: 450, suctionDn: 100, dischargeDn: 100, source: 'test' },
      baseplate: { length: 1000, width: 500, height: 100 },
    });
    base = apply(base, 'add_vessel', {
      tag: 'V-101',
      orientation: 'vertical',
      location: [7000, 3000],
      insideDiameter: 1600,
      tangentLength: 4000,
      heads: { top: { type: 'ellipsoidal', ratio: 2 }, bottom: { type: 'ellipsoidal', ratio: 2 } },
      shellThickness: 10,
      headThickness: 10,
      corrosionAllowance: 3,
      support: { type: 'skirt', height: 1000, thickness: 10 },
    });
    base = apply(base, 'add_nozzle', {
      equipment: 'V-101',
      mark: 'N1',
      dn: 100,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'shell', elevation: 3000, orientationDeg: 270 },
      projection: 1000,
    });
    const withLine = apply(base, 'create_pipeline', {
      service: 'P',
      sequence: '1001',
      spec: 'CS150',
      dn: 100,
      from: 'P-101:DIS',
      to: 'V-101:N1',
    });
    const lineId = withLine.plant?.piping?.lineOrder.at(-1) as string;
    const params = {
      lineId,
      from: { portId: 'P-101:DIS' },
      to: { portId: 'V-101:N1' },
      legs: [
        { direction: '+Z', length: 1500 },
        { direction: '+Y', length: 3000 },
        { direction: '+X', length: 3000 },
        { direction: '+Z', length: 1500 },
      ],
    };
    const routed = ok(withLine, 'route_pipe', params);
    return { doc: routed.document, runId: (routed.data as { runId: string }).runId };
  }

  it('widening the pump frame by 200 moves DIS 100 along -X; the run follows and its start stays on the port', () => {
    const s = scene();
    const result = ok(s.doc, 'update_equipment_parameters', { equipment: 'P-101', pump: { envelope: { f: 600 } } });
    const report = result.data as unknown as Report & { connectedPipes: string[] };
    expect(report.movedPorts.map((port) => [port.id, port.distance])).toEqual(
      expect.arrayContaining([['P-101:DIS', expect.closeTo(100, 9)]]),
    );
    expect(result.summary).toContain('re-routed 1 run(s) by orthogonal stretch');
    const run = result.document.plant?.piping?.runs[s.runId] as PipeRun;
    expect(run.start.point).toEqual([-100, 0, 1000]);
    expect(run.end.point).toEqual((s.doc.plant?.piping?.runs[s.runId] as PipeRun).end.point);
  });
});
