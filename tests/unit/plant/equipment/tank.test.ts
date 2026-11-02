/**
 * Plant 03 EQP M4: `add_storage_tank`, the `equipment` form of `tank_shell_thickness`, tank volumes, masses, nozzles and the tank rows of `check_equipment`
 * (VC-EQP-08 / 17; SC-EQP-04 also runs through the plan runner). Reference numbers are the one-foot closed forms re-derived here, none comes from llull.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { RevolutionEntity } from '@core/model/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { mmDocument, tankDocument, tankParams } from './equipmentFixtures';

const equipmentOf = (doc: CadDocument, tag = 'T-401'): EquipmentElement => {
  const found = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === tag);
  if (found?.category !== 'equipment') throw new Error(`no equipment ${tag}`);
  return found;
};
const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);
/** API 650 one-foot design thickness, mm: 4.9 D (H - 0.3) G / S_d + CA (D m, H m, S MPa). */
const design = (diameterM: number, headM: number, sg: number, stress: number, allowance: number): number =>
  (4.9 * diameterM * (headM - 0.3) * sg) / stress + allowance;

describe('add_storage_tank: SC-EQP-04 (D 20 m, six 2 m courses, A36M, CA 1.5)', () => {
  const doc = tankDocument();
  const element = equipmentOf(doc);
  const template = element.plant?.template;

  it('derives the course thicknesses from the one-foot method and says so (named default, source)', () => {
    const result = ok(mmDocument(), 'add_storage_tank', tankParams);
    const report = result.data as {
      courses: Array<{ course: number; height: number; bottom: number; thicknessMm: number }>;
      thicknessSource: string;
      defaulted: string[];
    };
    expect(report.thicknessSource).toBe('one_foot');
    expect(report.defaulted).toEqual(expect.arrayContaining(['courseThicknesses', 'roof.thickness', 'bottom.thickness']));
    const expected = [12, 10, 8].map((head) => design(20, head, 1, 160, 1.5));
    expect(expected[0]).toBeCloseTo(8.66625, 12);
    report.courses.slice(0, 3).forEach((course, index) => expect(rel(course.thicknessMm, expected[index] as number)).toBeLessThan(1e-12));
    expect(report.courses.slice(3).map((course) => course.thicknessMm)).toEqual([6, 6, 6]);
    expect(report.courses.map((course) => course.bottom)).toEqual([0, 2000, 4000, 6000, 8000, 10000]);
    expect(template).toMatchObject({
      kind: 'tank',
      thicknessSource: 'one_foot',
      roof: { type: 'cone', thickness: 5 },
      bottom: { thickness: 6 },
    });
  });

  it('creates the bottom, one ring per course and the roof, tagged to the element, and an element that passes the building validation', () => {
    const parts = Object.keys(doc.entities).map((id) => id.split(':')[1]);
    expect(parts).toEqual(['bottom', 'course-1', 'course-2', 'course-3', 'course-4', 'course-5', 'course-6', 'roof']);
    const course1 = doc.entities[`${element.id}:course-1`] as RevolutionEntity;
    expect(Math.max(...course1.profile.map((point) => point[0]))).toBeCloseTo(10000 + 8.66625, 9);
    expect(Math.min(...course1.profile.map((point) => point[1]))).toBeCloseTo(6, 9);
    const roof = doc.entities[`${element.id}:roof`] as RevolutionEntity;
    const apex = Math.max(...roof.profile.map((point) => point[1]));
    expect(apex).toBeCloseTo(6 + 12000 + 10006 / 12, 9);
  });

  it('derives the legacy fields: vertical vessel of the eave diameter and the roof apex, weight = empty + liquid at the design level', () => {
    expect(element.shape).toBe('vertical_vessel');
    expect(element.size[0]).toBeCloseTo(2 * 10006, 9);
    expect(element.size[2]).toBeCloseTo(6 + 12000 + 10006 / 12, 9);
    const weights = data<{ body: { emptyKg: number; operatingKg: number; testKg: number } }>(doc, 'equipment_weights', {
      equipment: 'T-401',
    });
    expect(element.weight).toBe(weights.body.operatingKg);
    expect(rel(weights.body.operatingKg, weights.body.emptyKg + Math.PI * 100 * 12 * 1000)).toBeLessThan(1e-12);
    expect(rel(weights.body.testKg, weights.body.emptyKg + Math.PI * 100 * 12 * 1000)).toBeLessThan(1e-12);
  });

  it('is pure and replays to the same ids', () => {
    const before = mmDocument();
    const snapshot = JSON.stringify(before);
    execute(before, 'add_storage_tank', tankParams);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(Object.keys(apply(mmDocument(), 'add_storage_tank', tankParams).entities)).toEqual(Object.keys(doc.entities));
  });
});

describe('add_storage_tank: thicknesses, roofs and refusals', () => {
  const given = { ...tankParams, courseThicknesses: [10, 9, 8, 7, 6, 6] };

  it('given thicknesses are used as they are (source user) and are not reported as defaults', () => {
    const report = data<{ thicknessSource: string; defaulted: string[]; courses: Array<{ thicknessMm: number }> }>(
      mmDocument(),
      'add_storage_tank',
      given,
    );
    expect(report.thicknessSource).toBe('user');
    expect(report.defaulted).not.toContain('courseThicknesses');
    expect(report.courses.map((course) => course.thicknessMm)).toEqual([10, 9, 8, 7, 6, 6]);
  });

  it('all-minimum courses are reported as minimum', () => {
    const low = {
      ...tankParams,
      diameter: 5000,
      shellHeight: 4000,
      courses: [2000, 2000],
      design: { ...tankParams.design, designLiquidLevel: 1000 },
    };
    expect(data<{ thicknessSource: string }>(mmDocument(), 'add_storage_tank', low).thicknessSource).toBe('minimum');
  });

  it('a dome roof rises R - sqrt(R^2 - eave^2); a flat roof is a plate on top; the legacy height follows', () => {
    const dome = apply(mmDocument(), 'add_storage_tank', { ...given, roof: { type: 'dome', radius: 20000, thickness: 6 } });
    const eave = 10006;
    expect(equipmentOf(dome).size[2]).toBeCloseTo(6 + 12000 + 20000 - Math.sqrt(20000 ** 2 - eave ** 2), 6);
    const flat = apply(mmDocument(), 'add_storage_tank', { ...given, roof: { type: 'flat' } });
    expect(equipmentOf(flat).size[2]).toBeCloseTo(6 + 12000, 9);
    const roof = flat.entities[`${equipmentOf(flat).id}:roof`] as RevolutionEntity;
    expect(Math.max(...roof.profile.map((point) => point[1]))).toBeCloseTo(6 + 12000 + 5, 9);
  });

  it.each([
    ['EQP_COURSES_MISMATCH', { courses: [2000, 2000] }, 'courses'],
    ['EQP_PARAM_INVALID', { design: { ...tankParams.design, designLiquidLevel: 13000 } }, 'design.designLiquidLevel'],
    ['EQP_PARAM_INVALID', { courseThicknesses: [10, 9] }, 'courseThicknesses'],
    ['EQP_PARAM_INVALID', { courseThicknesses: [10, 9, 8, 7, 1, 6] }, 'courseThicknesses.4'],
    ['EQP_PARAM_INVALID', { roof: { type: 'cone' } }, 'roof.slopeRatio'],
    ['EQP_PARAM_INVALID', { roof: { type: 'cone', slopeRatio: '1:0' } }, 'roof.slopeRatio'],
    ['EQP_PARAM_INVALID', { roof: { type: 'cone', slopeRatio: 2 } }, 'roof.slopeRatio'],
    ['EQP_PARAM_INVALID', { roof: { type: 'dome' } }, 'roof.radius'],
    ['EQP_PARAM_INVALID', { roof: { type: 'dome', radius: 10000 } }, 'roof.radius'],
    ['EQP_API650_ONE_FOOT_LIMIT', { diameter: 61000 }, 'diameter'],
    ['EQP_MATERIAL_NOT_IN_TABLE', { design: { ...tankParams.design, material: 'S355' } }, 'design.material'],
    ['EQP_PARAM_INVALID', { location: [1] }, 'location'],
    ['EQP_PARAM_INVALID', { tag: 'T:1' }, 'tag'],
  ])('%s %j', (code, change, at) => {
    const { courseThicknesses: _ignored, ...base } = given;
    const params = code === 'EQP_PARAM_INVALID' && at.startsWith('courseThicknesses') ? { ...given, ...change } : { ...base, ...change };
    expectRefusal(mmDocument(), 'add_storage_tank', params, code, at);
  });

  it('a tank above 60 m or outside Table 5-2a is built when the thicknesses are given (and the check warns instead of passing)', () => {
    const big = apply(mmDocument(), 'add_storage_tank', { ...given, diameter: 61000 });
    const issues = data<{ issues: Array<{ code: string; severity: string; paths: string[] }> }>(big, 'check_equipment', {}).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'EQP_API650_ONE_FOOT_LIMIT', severity: 'warning', paths: ['diameter'] }));
    const steel = apply(mmDocument(), 'add_storage_tank', { ...given, design: { ...tankParams.design, material: 'S355' } });
    expect(data<{ issues: Array<{ code: string }> }>(steel, 'check_equipment', {}).issues.map((issue) => issue.code)).toContain(
      'EQP_MATERIAL_NOT_IN_TABLE',
    );
    const withStress = apply(mmDocument(), 'add_storage_tank', {
      ...tankParams,
      design: { ...tankParams.design, material: 'S355', allowableStress: { design: 180, test: 200, source: 'EN 14015 table' } },
    });
    const first = (withStress.building?.elements['equipment-1'] as EquipmentElement).plant?.template;
    expect(first?.kind === 'tank' && first.courseThicknesses[0]).toBeCloseTo(design(20, 12, 1, 180, 1.5), 9);
  });

  it('a duplicate tag is EQP_TAG_DUPLICATE', () => {
    expectRefusal(tankDocument(), 'add_storage_tank', tankParams, 'EQP_TAG_DUPLICATE', 'tag');
  });
});

describe('tank_shell_thickness: the equipment form', () => {
  const doc = tankDocument();
  const inline = {
    diameter: 20000,
    shellHeight: 12000,
    courses: tankParams.courses,
    designLiquidLevel: 12000,
    specificGravity: 1,
    material: 'A36M',
    corrosionAllowance: 1.5,
  };

  it('gives the same courses as the inline form, names the equipment, and overrideDiameterM replaces the diameter for the query only', () => {
    const stored = data<{ courses: unknown[]; equipment: string; elementId: string }>(doc, 'tank_shell_thickness', {
      equipment: 'T-401',
      method: 'one_foot',
    });
    const typed = data<{ courses: unknown[] }>(mmDocument(), 'tank_shell_thickness', inline);
    expect(stored.courses).toEqual(typed.courses);
    expect(stored).toMatchObject({ equipment: 'T-401', elementId: 'equipment-1' });
    const smaller = data<{ courses: Array<{ designThicknessMm: number }>; overrideDiameterM: number }>(doc, 'tank_shell_thickness', {
      equipment: 'T-401',
      overrideDiameterM: 10,
    });
    expect(smaller.overrideDiameterM).toBe(10);
    expect(rel(smaller.courses[0]?.designThicknessMm ?? 0, design(10, 12, 1, 160, 1.5))).toBeLessThan(1e-12);
    expect(equipmentOf(doc).plant?.template).toMatchObject({ diameter: 20000 });
  });

  it('overrideDiameterM 65 is EQP_API650_ONE_FOOT_LIMIT (SC-EQP-04 step 5); the unit of the override is metres whatever the document unit', () => {
    expectRefusal(doc, 'tank_shell_thickness', { equipment: 'T-401', overrideDiameterM: 65 }, 'EQP_API650_ONE_FOOT_LIMIT', 'diameter');
  });

  it('in a metre document the stored dimensions are metres, the override is still metres and the thickness is still millimetres', () => {
    const metres = apply(apply(createEmptyDocument(), 'set_units', { units: 'm' }), 'add_storage_tank', {
      ...tankParams,
      location: [30, 0],
      diameter: 20,
      shellHeight: 12,
      courses: [2, 2, 2, 2, 2, 2],
      design: { ...tankParams.design, designLiquidLevel: 12, corrosionAllowance: 0.0015 },
    });
    const report = data<{ courses: Array<{ designThicknessMm: number }> }>(metres, 'tank_shell_thickness', {
      equipment: 'T-401',
      overrideDiameterM: 10,
    });
    expect(rel(report.courses[0]?.designThicknessMm ?? 0, design(10, 12, 1, 160, 1.5))).toBeLessThan(1e-12);
    expectRefusal(metres, 'tank_shell_thickness', { equipment: 'T-401', overrideDiameterM: 65 }, 'EQP_API650_ONE_FOOT_LIMIT', 'diameter');
    const stored = equipmentOf(metres).plant?.template;
    expect(stored?.kind === 'tank' && stored.courseThicknesses[0]).toBeCloseTo(design(20, 12, 1, 160, 1.5) / 1000, 12);
  });

  it.each([
    ['EQP_NOT_FOUND', { equipment: 'X-1' }, 'equipment'],
    ['EQP_PARAM_INVALID', { equipment: 'T-401', diameter: 5000 }, 'diameter'],
    ['EQP_PARAM_INVALID', { equipment: 'T-401', allowableStress: { design: 1, test: 1 } }, 'allowableStress'],
    ['EQP_PARAM_INVALID', { overrideDiameterM: 10 }, 'overrideDiameterM'],
    ['EQP_PARAM_INVALID', { diameter: 20000 }, 'shellHeight'],
  ])('%s %j', (code, params, at) => {
    expectRefusal(doc, 'tank_shell_thickness', params, code, at);
  });

  it('refuses equipment that is not a tank', () => {
    const block = apply(mmDocument(), 'add_equipment', { name: 'Skid', mark: 'S-1', location: [0, 0], size: [1000, 1000, 1000] });
    expectRefusal(block, 'tank_shell_thickness', { equipment: 'S-1' }, 'EQP_NOT_PARAMETRIC', 'equipment');
  });
});

describe('vessel_volume on a tank', () => {
  const doc = tankDocument();

  it('levels from the shell base: V = pi/4 D^2 h, percent of the shell, the design level as operating with its mass', () => {
    const report = data<{
      totalVolumeM3: number;
      levels: Array<{ liquidVolumeM3: number; percent: number }>;
      operating: { liquidVolumeM3: number; liquidMassKg: number };
    }>(doc, 'vessel_volume', { equipment: 'T-401', levels: [6000, 12000] });
    expect(rel(report.totalVolumeM3, Math.PI * 100 * 12)).toBeLessThan(1e-12);
    expect(rel(report.levels[0]?.liquidVolumeM3 ?? 0, Math.PI * 100 * 6)).toBeLessThan(1e-12);
    expect(report.levels[0]?.percent).toBeCloseTo(50, 9);
    expect(report.operating.liquidVolumeM3).toBeCloseTo(report.totalVolumeM3, 9);
    expect(report.operating.liquidMassKg).toBeCloseTo(report.totalVolumeM3 * 1000, 6);
  });

  it('refuses a level above the shell (path levels.<i>), side, and inline geometry next to equipment', () => {
    expectRefusal(doc, 'vessel_volume', { equipment: 'T-401', levels: [100, 12001] }, 'EQP_LEVEL_OUT_OF_RANGE', 'levels.1');
    expectRefusal(doc, 'vessel_volume', { equipment: 'T-401', side: 'shell' }, 'EQP_PARAM_INVALID', 'side');
    expectRefusal(doc, 'vessel_volume', { equipment: 'T-401', insideDiameter: 100 }, 'EQP_PARAM_INVALID', 'insideDiameter');
  });
});

describe('tank masses', () => {
  const doc = tankDocument();
  const report = data<{ breakdown: Array<{ part: string; kg: number }>; body: { emptyKg: number }; defaulted: string[] }>(
    doc,
    'equipment_weights',
    { equipment: 'T-401' },
  );
  const part = (name: string): number => report.breakdown.find((row) => row.part === name)?.kg ?? Number.NaN;

  it('courses, bottom and roof plate match the closed forms (thin plate: area x thickness)', () => {
    const t1 = design(20, 12, 1, 160, 1.5);
    expect(rel(part('course 1'), Math.PI * ((10000 + t1) ** 2 - 10000 ** 2) * 2000 * 7850e-9)).toBeLessThan(1e-12);
    expect(rel(part('course 4'), Math.PI * (10006 ** 2 - 10000 ** 2) * 2000 * 7850e-9)).toBeLessThan(1e-12);
    expect(rel(part('bottom'), Math.PI * 10006 ** 2 * 6 * 7850e-9)).toBeLessThan(1e-12);
    const slant = Math.hypot(10006, 10006 / 12);
    expect(rel(part('roof'), Math.PI * 10006 * slant * 5 * 7850e-9)).toBeLessThan(1e-12);
    expect(report.defaulted.join(' ')).toContain('one-foot');
  });

  it('nozzle masses use the wall of the course at the nozzle elevation', () => {
    const nozzled = apply(doc, 'add_nozzle', {
      equipment: 'T-401',
      mark: 'N1',
      dn: 200,
      rating: 'CL150',
      location: { on: 'shell', elevation: 500, orientationDeg: 90 },
      projection: 10500,
    });
    const weights = data<{ nozzles: { kg: number } }>(nozzled, 'equipment_weights', { equipment: 'T-401', include: ['nozzles'] });
    expect(weights.nozzles.kg).toBeGreaterThan(10);
    expect(weights.nozzles.kg).toBeLessThan(200);
  });
});

describe('tank nozzles', () => {
  const doc = tankDocument();
  const nozzle = { equipment: 'T-401', mark: 'N1', dn: 200, rating: 'CL150', projection: 10500 };

  it('a shell nozzle is placed from the tank axis at elevation above the shell base, clockwise from north', () => {
    const next = apply(doc, 'add_nozzle', { ...nozzle, location: { on: 'shell', elevation: 500, orientationDeg: 90 } });
    const port = data<{ ports: Record<string, { position: number[]; direction: number[] }> }>(next, 'equipment_ports', {
      equipment: 'T-401',
    }).ports['T-401:N1'];
    expect(port?.position[0]).toBeCloseTo(30000 + 10500, 6);
    expect(port?.position[1]).toBeCloseTo(0, 6);
    expect(port?.position[2]).toBeCloseTo(6 + 500, 6);
    expect(port?.direction).toEqual([1, 0, 0]);
  });

  it('a roof nozzle is a free location; head and channel locations and bad elevations are refused', () => {
    const roof = apply(doc, 'add_nozzle', {
      equipment: 'T-401',
      mark: 'R1',
      dn: 100,
      rating: 'CL150',
      location: { on: 'free', position: [0, 0, 13000], direction: [0, 0, 1] },
      projection: 300,
    });
    expect(roof.entities['equipment-1:nozzle-R1']?.kind).toBe('revolution');
    expectRefusal(
      doc,
      'add_nozzle',
      { ...nozzle, location: { on: 'head', head: 'top', radialOffset: 0 } },
      'EQP_PARAM_INVALID',
      'location.on',
    );
    expectRefusal(
      doc,
      'add_nozzle',
      { ...nozzle, location: { on: 'shell', station: 100, orientationDeg: 0 } },
      'EQP_PARAM_INVALID',
      'location.on',
    );
    expectRefusal(
      doc,
      'add_nozzle',
      { ...nozzle, location: { on: 'shell', elevation: 12001, orientationDeg: 0 } },
      'EQP_NOZZLE_OFF_BODY',
      'location.elevation',
    );
    expectRefusal(
      doc,
      'add_nozzle',
      { ...nozzle, projection: 10000, location: { on: 'shell', elevation: 100, orientationDeg: 0 } },
      'EQP_NOZZLE_PROJECTION_TOO_SHORT',
      'projection',
    );
  });
});

describe('check_equipment on a tank', () => {
  type Check = {
    status: string;
    reviewRequired: boolean;
    issues: Array<{ code: string; severity: string; paths: string[]; message: string }>;
  };

  it('derived thicknesses are not an input: warn EQP_DESIGN_DATA_MISSING and the unverified minimum row, never a pass (SC-EQP-04 step 4)', () => {
    const report = data<Check & { checked: Array<{ notChecked: string[] }> }>(tankDocument(), 'check_equipment', { equipment: ['T-401'] });
    expect(report.status).toBe('warn');
    expect(report.reviewRequired).toBe(true);
    expect(report.issues.map((issue) => [issue.code, issue.severity, issue.paths[0]])).toEqual([
      ['EQP_DESIGN_DATA_MISSING', 'warning', 'courseThicknesses'],
      ['EQP_TABLE_UNVERIFIED', 'warning', 'courses'],
    ]);
    expect(report.checked[0]?.notChecked.length).toBeGreaterThan(2);
  });

  it('user thicknesses at or above the governing ones pass with only the table warning; one below fails EQP_SHELL_UNDER_THICKNESS at its course', () => {
    const adequate = apply(mmDocument(), 'add_storage_tank', { ...tankParams, courseThicknesses: [8.66625, 7.44125, 6.21625, 6, 6, 6] });
    expect(data<Check>(adequate, 'check_equipment', {}).issues.map((issue) => issue.code)).toEqual(['EQP_TABLE_UNVERIFIED']);
    const thin = apply(mmDocument(), 'add_storage_tank', { ...tankParams, courseThicknesses: [8.6, 7.44125, 6.21625, 5.9, 6, 6] });
    const report = data<Check>(thin, 'check_equipment', {});
    const fails = report.issues.filter((issue) => issue.severity === 'fail');
    expect(fails.map((issue) => [issue.code, issue.paths[0]])).toEqual([
      ['EQP_SHELL_UNDER_THICKNESS', 'courseThicknesses.0'],
      ['EQP_SHELL_UNDER_THICKNESS', 'courseThicknesses.3'],
    ]);
    expect(report.status).toBe('fail');
    expect(fails[0]?.message).toContain('8.66625');
  });

  it('an unsourced S_d / S_t is flagged at design.allowableStress.source', () => {
    const doc = apply(mmDocument(), 'add_storage_tank', {
      ...tankParams,
      design: { ...tankParams.design, allowableStress: { design: 160, test: 171 } },
    });
    expect(data<Check>(doc, 'check_equipment', {}).issues.map((issue) => `${issue.code}@${issue.paths[0]}`)).toContain(
      'EQP_VALUE_UNSOURCED@design.allowableStress.source',
    );
  });
});

describe('tanks and the generic equipment commands', () => {
  it('update_equipment_parameters refuses a tank with a coded reason; the plant record survives a save / load round trip', async () => {
    const doc = tankDocument();
    const result = expectRefusal(
      doc,
      'update_equipment_parameters',
      { equipment: 'T-401', set: { name: 'x' } },
      'EQP_NOT_PARAMETRIC',
      'equipment',
    );
    expect(result.summary).toContain('parametric tank');
    const { deserializeDocument, serializeDocument } = await import('@core/commands/persistence/serialization');
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(equipmentOf(loaded).plant).toEqual(equipmentOf(doc).plant);
    expect(Object.keys(loaded.entities)).toEqual(Object.keys(doc.entities));
  });
});
