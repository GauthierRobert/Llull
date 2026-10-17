/**
 * Live OpenCascade: holes, pockets and feature recognition (aerospace 07 FTR, step AERO-3). The machined plate of the 07 pack is built with
 * add_hole / add_pocket and compared with its analytic volume (VC-FTR-25), the existing-commands baseline (VC-FTR-26), pocket closed forms
 * with a floor fillet (VC-FTR-27), the parametric thickness (VC-FTR-30), and recognised again from the STEP file (VC-FTR-17, 20, 34).
 */

import { describe, expect, it, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { countersinkDepth, countersinkRemovedVolume, drillTipHeight, pocketRemovedVolume } from '@lib/holeMath';
import { createEmptyDocument, type CadDocument, type Entity, type MeshSolidEntity } from '@core/model/types';
import type { FtrCheckData } from '@core/model/manufacturing';
import type { RecognizeData } from '@core/commands/features/recognizeFeatures';
import type { HoleTableData } from '@core/commands/features/holeTable';
import { liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
afterAll(() => setGeometryKernel(null));

const PACK = path.resolve(__dirname, '../../docs/aerospace/07-sheet-metal-machined-features/validation');
const ctxOf = (kernel: GeometryKernel): ExecutionContext => ({ ...defaultContext(), kernel });
const REL = 1e-6;
const rel = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

/** Exact volume of a mesh entity's recipe. */
function volumeOf(kernel: GeometryKernel, doc: CadDocument, id: string): number {
  const shape = kernel.evaluate(recipeOf(doc.entities[id] as Entity));
  expect(shape).not.toBeNull();
  return kernel.topology(shape!)?.volume ?? Number.NaN;
}

const only = (doc: CadDocument): string => {
  expect(doc.order).toHaveLength(1);
  return doc.order[0] as string;
};

/** The draft plan `plans/draft_machined_plate.json`, with `=t` as the plate thickness (10 reproduces the pack's part). */
const plateActions = (): unknown[] => {
  const top = { near: [50, 30, '=t'] };
  return [
    { command: 'add_box', params: { size: [100, 60, '=t'], position: [0, 0, 0], anchor: 'min' }, as: 'plate' },
    {
      command: 'add_hole',
      params: {
        target: '$plate',
        face: top,
        points: [
          [10, 10],
          [90, 10],
          [10, 50],
          [90, 50],
        ],
        pointsFrame: 'world_xy',
        hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 },
        extent: { kind: 'through_all' },
      },
      as: 'csk',
    },
    {
      command: 'add_hole',
      params: {
        target: '$csk',
        face: top,
        points: [
          [30, 30],
          [70, 30],
        ],
        pointsFrame: 'world_xy',
        hole: { kind: 'counterbore', diameter: 5.5, cboreDiameter: 10, cboreDepth: 5.5 },
        extent: { kind: 'through_all' },
      },
      as: 'cb',
    },
    {
      command: 'add_pocket',
      params: {
        target: '$cb',
        face: top,
        outline: { kind: 'rectangle', center: [50, 45], size: [40, 12] },
        depth: 4,
        cornerRadius: 3,
        floorFillet: 0,
      },
      as: 'pocketed',
    },
    {
      command: 'add_hole',
      params: {
        target: '$pocketed',
        face: top,
        points: [[50, 15]],
        pointsFrame: 'world_xy',
        hole: { kind: 'simple', diameter: 6 },
        extent: { kind: 'blind', depth: 6, drillPointAngle: 118 },
      },
      as: 'part',
    },
  ];
};

function buildPlate(kernel: GeometryKernel, thickness = 10): CadDocument {
  const ctx = ctxOf(kernel);
  const withT = execute(createEmptyDocument(), 'set_parameter', { name: 't', expression: String(thickness) }, ctx).document;
  const built = execute(withT, 'build_project', { actions: plateActions() }, ctx);
  expect(built.error).toBeUndefined();
  return built.document;
}

/** Closed form of the removed volume for plate thickness `t` (generate_test_parts.py machined_plate). */
function removedVolume(t: number): number {
  const csk = Math.PI * 2.4 ** 2 * t + countersinkRemovedVolume(4.8, 9, 100).value;
  const cbore = Math.PI * 2.75 ** 2 * (t - 5.5) + Math.PI * 25 * 5.5;
  const pocket = pocketRemovedVolume(40, 12, 4, 3, 0).value;
  const blind = Math.PI * 9 * 6 + (Math.PI * 9 * drillTipHeight(6, 118).value) / 3;
  return 4 * csk + 2 * cbore + pocket + blind;
}

describe('add_hole / add_pocket on the live OCC kernel', () => {
  it('VC-FTR-25: the machined plate plan has the pack volume 55978.529153 and exact analytic volume', () => {
    const doc = buildPlate(kernels.occt);
    const volume = volumeOf(kernels.occt, doc, only(doc));
    expect(rel(volume, 55978.529153)).toBeLessThan(REL);
    expect(rel(volume, 60000 - removedVolume(10))).toBeLessThan(1e-9);
    const brep = (doc.entities[only(doc)] as MeshSolidEntity).brep;
    expect(brep).toMatchObject({ op: 'feature', feature: 'hole', extent: { kind: 'blind', depth: 6, drillPointAngle: 118 } });
  }, 120_000);

  it('VC-FTR-26: the baseline of today (cylinder + cone + 2 booleans) gives 59783.006014', () => {
    const actions = [
      { command: 'add_box', params: { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' }, as: 'plate' },
      { command: 'add_cylinder', params: { radius: 2.4, height: 12, position: [10, 10, 5] }, as: 'drill' },
      { command: 'boolean', params: { op: 'subtract', a: '$plate', b: '$drill' }, as: 'drilled' },
      {
        command: 'add_cone',
        params: { radius: 5.69175359259421, height: 4.77594834029776, position: [10, 10, 11], axis: [0, 0, -1] },
        as: 'csk',
      },
      { command: 'boolean', params: { op: 'subtract', a: '$drilled', b: '$csk' }, as: 'part' },
    ];
    const built = execute(createEmptyDocument(), 'build_project', { actions }, ctxOf(kernels.occt));
    expect(rel(volumeOf(kernels.occt, built.document, only(built.document)), 59783.006014)).toBeLessThan(REL);
  }, 120_000);

  it.each([
    ['PK-01', 0, 3931.327412287],
    ['PK-02', 1.5, 3877.71730193],
  ])(
    'VC-FTR-27 %s: a rounded pocket (floor fillet %d) removes the analytic volume',
    (_id, floorFillet, removed) => {
      const plate = execute(createEmptyDocument(), 'add_box', { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' });
      const cut = execute(
        plate.document,
        'add_pocket',
        {
          target: plate.affected[0],
          face: { near: [50, 30, 10] },
          outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] },
          depth: 5,
          cornerRadius: 4,
          floorFillet,
          toolDiameter: 8,
        },
        ctxOf(kernels.occt),
      );
      expect(cut.error).toBeUndefined();
      expect(rel(60000 - volumeOf(kernels.occt, cut.document, only(cut.document)), removed)).toBeLessThan(REL);
    },
    120_000,
  );

  it('VC-FTR-27 PK-03 / VC-FTR-37: a floor fillet above the corner radius is refused with its code', () => {
    const plate = execute(createEmptyDocument(), 'add_box', { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' });
    const refused = execute(
      plate.document,
      'add_pocket',
      {
        target: plate.affected[0],
        face: { near: [50, 30, 10] },
        outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] },
        depth: 5,
        cornerRadius: 1,
        floorFillet: 1.5,
      },
      ctxOf(kernels.occt),
    );
    expect(refused.document).toBe(plate.document);
    expect(refused.error).toMatchObject({ code: 'FTR_POCKET_FILLET_GT_CORNER', paths: ['floorFillet', 'cornerRadius'] });
  }, 120_000);

  it('VC-FTR-30: thickness 10 -> 12 keeps the holes through and gives the analytic volume', () => {
    const doc = buildPlate(kernels.occt);
    const regenerated = execute(doc, 'set_parameter', { name: 't', expression: '12' }, ctxOf(kernels.occt));
    expect(regenerated.error).toBeUndefined();
    const id = only(regenerated.document);
    expect(rel(volumeOf(kernels.occt, regenerated.document, id), 72000 - removedVolume(12))).toBeLessThan(1e-9);
    const table = execute(regenerated.document, 'hole_table', { id }, ctxOf(kernels.occt)).data as HoleTableData;
    expect(table.rows.filter((row) => row.through)).toHaveLength(6);
  }, 180_000);

  it('rejects a face that is not planar and a point on a face the pick missed (exact topology)', () => {
    const cylinder = execute(createEmptyDocument(), 'add_cylinder', { radius: 10, height: 20, position: [0, 0, 0] });
    const side = execute(
      cylinder.document,
      'add_hole',
      {
        target: cylinder.affected[0],
        face: { near: [10, 0, 0] },
        points: [[0, 0]],
        hole: { kind: 'simple', diameter: 2 },
        extent: { kind: 'through_all' },
      },
      ctxOf(kernels.occt),
    );
    expect(side.error?.code).toBe('FTR_FACE_NOT_PLANAR');
    const plate = execute(createEmptyDocument(), 'add_box', { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' });
    const hole = (points: number[][]): CommandResult =>
      execute(
        plate.document,
        'add_hole',
        {
          target: plate.affected[0],
          face: { near: [50, 30, 10] },
          pointsFrame: 'world_xy',
          points,
          hole: { kind: 'simple', diameter: 4 },
          extent: { kind: 'through_all' },
        },
        ctxOf(kernels.occt),
      );
    expect(hole([[500, 500]]).error?.code).toBe('FTR_HOLE_POINT_OUTSIDE_FACE');
    expect(hole([[50, 30]]).error).toBeUndefined();
  }, 120_000);
});

interface ExpectedPlate {
  cases: Array<{ vc: string; expected: { countersink: { centres_xy: number[][] } } }>;
}

describe('add_hole performance budget (07 TR §8)', () => {
  it('100 positions are cut by one compound tool in a few seconds, with the exact volume', () => {
    const plate = execute(createEmptyDocument(), 'add_box', { size: [200, 200, 10], position: [0, 0, 0], anchor: 'min' });
    const points = Array.from({ length: 100 }, (_, i) => [10 + (i % 10) * 20, 10 + Math.floor(i / 10) * 20]);
    const started = Date.now();
    const cut = execute(
      plate.document,
      'add_hole',
      {
        target: plate.affected[0],
        face: { near: [100, 100, 10] },
        pointsFrame: 'world_xy',
        points,
        hole: { kind: 'simple', diameter: 4 },
        extent: { kind: 'through_all' },
      },
      ctxOf(kernels.occt),
    );
    const volume = volumeOf(kernels.occt, cut.document, only(cut.document));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(rel(volume, 400000 - 100 * Math.PI * 4 * 10)).toBeLessThan(1e-9);
  }, 120_000);
});

describe('recognize_features on the live OCC kernel', () => {
  const expected = (JSON.parse(readFileSync(path.join(PACK, 'data/expected_feature_recognition.json'), 'utf8')) as ExpectedPlate).cases[0]!
    .expected;
  const around = (value: number | undefined, target: number, tol = 1e-4): void =>
    expect(Math.abs((value ?? Number.NaN) - target)).toBeLessThan(tol);

  const recognizePlate = (doc: CadDocument, id: string): RecognizeData =>
    execute(doc, 'recognize_features', { id }, ctxOf(kernels.occt)).data as RecognizeData;

  function expectMachinedPlate(found: RecognizeData): void {
    expect(found.counts).toMatchObject({ holes: 7, countersink: 4, counterbore: 2, blind: 1, pockets: 1 });
    expect(found.unclassified).toEqual([]);
    const csk = found.holes.filter((hole) => hole.subtype === 'countersink');
    expect(csk.map((hole) => [hole.axisPoint[0], hole.axisPoint[1]])).toEqual(
      expected.countersink.centres_xy.slice().sort((a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]!),
    );
    for (const hole of csk) {
      around(hole.diameter, 4.8);
      around(hole.cskDiameter, 9);
      around(hole.cskAngleDeg, 100, 1e-3);
      around(hole.cskDepth, countersinkDepth(4.8, 9, 100).value);
      expect(hole).toMatchObject({ through: true, axis: [0, 0, -1], confidence: 'exact' });
      around(hole.axisPoint[2], 10);
    }
    const cbores = found.holes.filter((hole) => hole.subtype === 'counterbore');
    expect(cbores.map((hole) => [hole.axisPoint[0], hole.axisPoint[1]])).toEqual([
      [30, 30],
      [70, 30],
    ]);
    for (const hole of cbores) {
      around(hole.diameter, 5.5);
      around(hole.cboreDiameter, 10);
      around(hole.cboreDepth, 5.5);
      expect(hole.through).toBe(true);
    }
    const [blind] = found.holes.filter((hole) => !hole.through);
    expect(blind).toMatchObject({ subtype: 'simple', axis: [0, 0, -1] });
    around(blind?.diameter, 6);
    around(blind?.depth, 6);
    around(blind?.drillPointAngleDeg, 118, 1e-3);
    expect([blind?.axisPoint[0], blind?.axisPoint[1]]).toEqual([50, 15]);
    const [pocket] = found.pockets;
    expect(pocket).toMatchObject({ open: false });
    around(pocket?.floorZ, 6);
    around(pocket?.depth, 4);
    around(pocket?.cornerRadius, 3);
    around(pocket?.floorFillet, 0);
    expect(found).toMatchObject({ reviewRequired: true, lengthUnit: 'mm' });
  }

  it('VC-FTR-17: the authored plate is recognised again, with no false positives', () => {
    const doc = buildPlate(kernels.occt);
    expectMachinedPlate(recognizePlate(doc, only(doc)));
  }, 120_000);

  it('VC-FTR-17: the STEP file (split periodic faces) gives the same 7 holes and 1 pocket', () => {
    const text = readFileSync(path.join(PACK, 'data/ftr_machined_plate.step'), 'utf8');
    const imported = execute(
      createEmptyDocument(),
      'import_step_exact',
      { text, fileName: 'ftr_machined_plate.step' },
      ctxOf(kernels.occt),
    );
    expect(imported.error).toBeUndefined();
    const id = imported.affected[0] as string;
    expect(rel(volumeOf(kernels.occt, imported.document, id), 55978.529153)).toBeLessThan(REL);
    expectMachinedPlate(recognizePlate(imported.document, id));
  }, 180_000);

  it('VC-FTR-34: hole_table of the imported plate has 7 sorted rows; check_machining measures the land by ray cast', () => {
    const text = readFileSync(path.join(PACK, 'data/ftr_machined_plate.step'), 'utf8');
    const imported = execute(createEmptyDocument(), 'import_step_exact', { text }, ctxOf(kernels.occt));
    const id = imported.affected[0] as string;
    const table = execute(imported.document, 'hole_table', { id }, ctxOf(kernels.occt)).data as HoleTableData;
    expect(table.rows).toHaveLength(7);
    const ys = table.rows.map((row) => row.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(table.rows.map((row) => row.label)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']);
    const check = execute(imported.document, 'check_machining', { id }, ctxOf(kernels.occt)).data as FtrCheckData;
    expect(check.findings.some((finding) => finding.code === 'FTR_CSK_KNIFE_EDGE')).toBe(false);
    expect(check.rulesSkipped.map((entry) => entry.rule)).toContain('minLand');
  }, 180_000);

  it('VC-FTR-20: NIST CTC-01 has 2 blind holes of diameter 20 with a 118 degree point (4 half cones merged to 2)', () => {
    const text = readFileSync(path.join(PACK, 'data/nist_ctc_01_asme1_ap242.stp'), 'utf8');
    const imported = execute(createEmptyDocument(), 'import_step_exact', { text, fileName: 'ctc01.stp' }, ctxOf(kernels.occt));
    expect(imported.error).toBeUndefined();
    const id = imported.affected[0] as string;
    const found = recognizePlate(imported.document, id);
    const drilled = found.holes.filter((hole) => hole.drillPointAngleDeg !== undefined);
    expect(drilled).toHaveLength(2);
    for (const hole of drilled) {
      around(hole.diameter, 20);
      around(hole.drillPointAngleDeg, 118, 1e-3);
      expect(hole.through).toBe(false);
    }
    const merged = found.holes.flatMap((hole) => hole.faceIndices);
    expect(new Set(merged).size).toBe(merged.length);
  }, 300_000);

  it('refuses a mesh-only kernel and a missing id with FTR codes', () => {
    const plate = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const manifold = execute(plate.document, 'recognize_features', { id: plate.affected[0] }, ctxOf(kernels.manifold));
    expect(manifold.error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
    const missing = execute(plate.document, 'recognize_features', { id: 'nope' }, ctxOf(kernels.occt));
    expect(missing.error?.code).toBe('FTR_PART_NOT_FOUND');
  }, 120_000);
});
