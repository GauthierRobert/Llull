/**
 * Live OpenCascade: the remaining 07 FTR features. add_rib against the analytic prism (VC-FTR-33), counterdrill / up-to extents / pocket islands
 * with exact closed forms, and recognised holes turned into add_hole steps that rebuild the imported volume (VC-FTR-32).
 */

import { describe, expect, it, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { HolePlanData } from '@core/commands/features/holesFromRecognition';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { pocketRemovedVolume } from '@lib/holeMath';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
afterAll(() => setGeometryKernel(null));

const PACK = path.resolve(__dirname, '../../docs/aerospace/07-sheet-metal-machined-features/validation/data');
const ctxOf = (kernel: GeometryKernel): ExecutionContext => ({ ...defaultContext(), kernel });
const REL = 1e-6;
const rel = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

function volumeOf(kernel: GeometryKernel, doc: CadDocument, id: string): number {
  const shape = kernel.evaluate(recipeOf(doc.entities[id] as Entity));
  expect(shape).not.toBeNull();
  return kernel.topology(shape!)?.volume ?? Number.NaN;
}

const idOf = (result: { affected: readonly string[] }): string => result.affected[0] as string;

function block(size: [number, number, number], position: [number, number, number] = [0, 0, 0]): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_box', { size, position, anchor: 'min' });
  return { doc: result.document, id: idOf(result) };
}

describe('add_rib on the live OCC kernel (VC-FTR-33)', () => {
  const addRib = (
    kernel: GeometryKernel,
    stock: { doc: CadDocument; id: string },
    params: Record<string, unknown>,
  ): ReturnType<typeof execute> =>
    execute(
      stock.doc,
      'add_rib',
      { target: stock.id, plane: { origin: [0, 0, 10], normal: [0, 0, 1] }, thickness: 3, height: 20, symmetric: true, ...params },
      ctxOf(kernel),
    );

  it('a 3 mm x 20 mm rib on a 100 x 60 x 10 plate has the volume of the analytic prism (rel 1e-6)', () => {
    const stock = block([100, 60, 10]);
    const result = addRib(kernels.occt, stock, {
      path: [
        [10, 30],
        [90, 30],
      ],
    });
    expect(result.error).toBeUndefined();
    const volume = volumeOf(kernels.occt, result.document, idOf(result));
    expect(rel(volume, 60000 + 3 * 80 * 20)).toBeLessThan(REL);
    const ocp = JSON.parse(readFileSync(path.join(PACK, 'expected_rib_ocp.json'), 'utf8')) as { prism_fuse_volume_mm3: number };
    expect(rel(volume, ocp.prism_fuse_volume_mm3)).toBeLessThan(REL);
    expect(result.document.order).toHaveLength(1);
  }, 120_000);

  it('a mitred L-shaped rib, a one-sided rib and a rib up to a face above match their closed forms', () => {
    const stock = block([100, 60, 10]);
    const bend = addRib(kernels.occt, stock, {
      path: [
        [10, 10],
        [50, 10],
        [50, 40],
      ],
    });
    expect(rel(volumeOf(kernels.occt, bend.document, idOf(bend)), 60000 + 3 * 70 * 20)).toBeLessThan(REL);
    const sided = addRib(kernels.occt, stock, {
      path: [
        [10, 10],
        [50, 10],
        [50, 40],
      ],
      symmetric: false,
      height: 5,
    });
    expect(rel(volumeOf(kernels.occt, sided.document, idOf(sided)), 60000 + 5 * 3 * 67)).toBeLessThan(REL);
    const pocket = execute(
      stock.doc,
      'add_pocket',
      {
        target: stock.id,
        face: { near: [50, 30, 10] },
        outline: { kind: 'rectangle', center: [50, 30], size: [60, 40] },
        depth: 4,
        cornerRadius: 0,
        floorFillet: 0,
      },
      ctxOf(kernels.occt),
    );
    const upTo = execute(
      pocket.document,
      'add_rib',
      {
        target: idOf(pocket),
        plane: { origin: [0, 0, 6], normal: [0, 0, 1] },
        path: [
          [30, 30],
          [70, 30],
        ],
        thickness: 2,
        upToFace: { near: [5, 5, 10] },
      },
      ctxOf(kernels.occt),
    );
    expect(upTo.error).toBeUndefined();
    const before = volumeOf(kernels.occt, pocket.document, idOf(pocket));
    expect(rel(volumeOf(kernels.occt, upTo.document, idOf(upTo)), before + 2 * 40 * 4)).toBeLessThan(REL);
  }, 180_000);

  it('refuses a rib that overhangs the supporting face', () => {
    const stock = block([100, 60, 10]);
    const refused = addRib(kernels.occt, stock, {
      path: [
        [10, 30],
        [120, 30],
      ],
    });
    expect(refused.document).toBe(stock.doc);
    expect(refused.error?.code).toBe('FTR_RIB_PATH_NOT_SUPPORTED');
  }, 120_000);
});

describe('hole and pocket options on the live OCC kernel', () => {
  const ctx = (): ExecutionContext => ctxOf(kernels.occt);

  it('counterdrill removes bore + counterbore + cone exactly', () => {
    const stock = block([100, 60, 10]);
    const result = execute(
      stock.doc,
      'add_hole',
      {
        target: stock.id,
        face: { near: [50, 30, 10] },
        pointsFrame: 'world_xy',
        points: [[50, 30]],
        hole: { kind: 'counterdrill', diameter: 4, cboreDiameter: 8, cboreDepth: 4, cskDiameter: 10, cskAngle: 90 },
        extent: { kind: 'through_all' },
      },
      ctx(),
    );
    expect(result.error).toBeUndefined();
    const removed = Math.PI * 4 * 10 + Math.PI * 12 * 4 + (Math.PI / 3) * 61 - Math.PI * 16;
    expect(rel(60000 - volumeOf(kernels.occt, result.document, idOf(result)), removed)).toBeLessThan(1e-9);
  }, 120_000);

  it('up_to_next and up_to_face on a hollow block cut exactly the first wall', () => {
    const outer = block([100, 60, 30]);
    const inner = execute(outer.doc, 'add_box', { size: [80, 40, 20], position: [10, 10, 5], anchor: 'min' }, ctx());
    const hollow = execute(inner.document, 'boolean', { op: 'subtract', a: outer.id, b: idOf(inner) }, ctx());
    const stock = idOf(hollow);
    const before = volumeOf(kernels.occt, hollow.document, stock);
    const hole = (extent: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(
        hollow.document,
        'add_hole',
        {
          target: stock,
          face: { near: [50, 30, 30] },
          pointsFrame: 'world_xy',
          points: [[50, 30]],
          hole: { kind: 'simple', diameter: 6 },
          extent,
        },
        ctx(),
      );
    const next = hole({ kind: 'up_to_next' });
    expect(rel(before - volumeOf(kernels.occt, next.document, idOf(next)), Math.PI * 9 * 5)).toBeLessThan(1e-9);
    const face = hole({ kind: 'up_to_face', face: { near: [50, 30, 5] } });
    expect(rel(before - volumeOf(kernels.occt, face.document, idOf(face)), Math.PI * 9 * 5)).toBeLessThan(1e-9);
  }, 180_000);

  it('pocket islands with a floor fillet and an open pocket are exact', () => {
    const stock = block([100, 60, 10]);
    const pocket = (params: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(
        stock.doc,
        'add_pocket',
        {
          target: stock.id,
          face: { near: [50, 30, 10] },
          outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] },
          depth: 5,
          cornerRadius: 4,
          floorFillet: 0,
          ...params,
        },
        ctx(),
      );
    const island = [
      [42, 24],
      [58, 24],
      [58, 36],
      [42, 36],
    ];
    const posts = pocket({ islands: [island] });
    expect(posts.error).toBeUndefined();
    const roundedArea = (w: number, l: number): number => w * l - (4 - Math.PI) * 16;
    expect(rel(60000 - volumeOf(kernels.occt, posts.document, idOf(posts)), (roundedArea(40, 20) - roundedArea(16, 12)) * 5)).toBeLessThan(
      1e-9,
    );
    const filleted = pocket({ islands: [island], floorFillet: 1.5 });
    expect(filleted.error).toBeUndefined();
    const plain = pocket({ floorFillet: 0 });
    expect(rel(60000 - volumeOf(kernels.occt, plain.document, idOf(plain)), pocketRemovedVolume(40, 20, 5, 4, 0).value)).toBeLessThan(REL);
    const open = pocket({ outline: { kind: 'rectangle', center: [95, 30], size: [20, 20] }, cornerRadius: 0, open: true, depth: 4 });
    expect(rel(60000 - volumeOf(kernels.occt, open.document, idOf(open)), 15 * 20 * 4)).toBeLessThan(1e-9);
  }, 180_000);
});

describe('VC-FTR-32: recognised holes rebuilt with add_hole steps', () => {
  const importPart = (file: string): { doc: CadDocument; id: string } => {
    const text = readFileSync(path.join(PACK, file), 'utf8');
    const imported = execute(createEmptyDocument(), 'import_step_exact', { text, fileName: file }, ctxOf(kernels.occt));
    expect(imported.error).toBeUndefined();
    return { doc: imported.document, id: idOf(imported) };
  };

  it('machined plate: box + the pocket + the recognised holes gives the imported volume (rel 1e-6)', () => {
    const part = importPart('ftr_machined_plate.step');
    const target = volumeOf(kernels.occt, part.doc, part.id);
    const stock = execute(part.doc, 'add_box', { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' }, ctxOf(kernels.occt));
    const pocketed = execute(
      stock.document,
      'add_pocket',
      {
        target: idOf(stock),
        face: { near: [50, 30, 10] },
        outline: { kind: 'rectangle', center: [50, 45], size: [40, 12] },
        depth: 4,
        cornerRadius: 3,
        floorFillet: 0,
      },
      ctxOf(kernels.occt),
    );
    const plan = execute(pocketed.document, 'holes_from_recognition', { id: part.id, stock: idOf(pocketed) }, ctxOf(kernels.occt));
    expect(plan.error).toBeUndefined();
    const data = plan.data as HolePlanData;
    expect(data.holes).toBe(7);
    const built = execute(pocketed.document, 'build_project', { actions: data.actions }, ctxOf(kernels.occt));
    expect(built.error).toBeUndefined();
    const result = built.document.order.filter((id) => id !== part.id);
    expect(result).toHaveLength(1);
    const error = rel(volumeOf(kernels.occt, built.document, result[0] as string), target);
    console.warn(`VC-FTR-32 machined plate: relative volume error ${error}`);
    expect(error).toBeLessThan(REL);
  }, 300_000);

  it('NIST CTC-01: its 10 recognised holes refilled into the part and re-cut give the imported volume (rel 1e-6)', () => {
    const part = importPart('nist_ctc_01_asme1_ap242.stp');
    const target = volumeOf(kernels.occt, part.doc, part.id);
    const plan = execute(part.doc, 'holes_from_recognition', { id: part.id, stock: 'STOCK' }, ctxOf(kernels.occt));
    expect(plan.error).toBeUndefined();
    const data = plan.data as HolePlanData;
    expect(data.holes).toBe(10);
    expect(data.ambiguous).toEqual([]);
    const found = execute(part.doc, 'recognize_features', { id: part.id, kinds: ['hole'] }, ctxOf(kernels.occt)).data as {
      holes: Array<{ axisPoint: number[]; axis: number[]; diameter: number; depth?: number; drillPointAngleDeg?: number }>;
    };
    const mesh = kernels.occt.tessellate(kernels.occt.evaluate(recipeOf(part.doc.entities[part.id] as Entity))!)!;
    const reachAlong = (axisPoint: number[], axis: number[]): number => {
      let reach = 0;
      for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
        reach = Math.max(
          reach,
          [0, 1, 2].reduce((sum, k) => sum + ((mesh.positions[i + k] as number) - (axisPoint[k] as number)) * (axis[k] as number), 0),
        );
      }
      return reach;
    };
    let doc = part.doc;
    let stock = part.id;
    for (const hole of found.holes) {
      const depth = hole.depth ?? reachAlong(hole.axisPoint, hole.axis);
      const outward = hole.axis.map((component) => -component);
      const deep = hole.axisPoint.map((component, k) => component + (hole.axis[k] as number) * depth);
      const middle = hole.axisPoint.map((component, k) => component + ((hole.axis[k] as number) * depth) / 2);
      const radius = hole.diameter / 2;
      const filler = execute(doc, 'add_cylinder', { radius, height: depth, position: middle, axis: outward }, ctxOf(kernels.occt));
      let tool = idOf(filler);
      doc = filler.document;
      if (hole.drillPointAngleDeg !== undefined) {
        const tip = radius / Math.tan((hole.drillPointAngleDeg * Math.PI) / 360);
        const cone = execute(doc, 'add_cone', { radius, height: tip, position: deep, axis: hole.axis }, ctxOf(kernels.occt));
        const joined = execute(cone.document, 'boolean', { op: 'union', a: tool, b: idOf(cone) }, ctxOf(kernels.occt));
        expect(joined.error).toBeUndefined();
        tool = idOf(joined);
        doc = joined.document;
      }
      const filled = execute(doc, 'boolean', { op: 'union', a: stock, b: tool }, ctxOf(kernels.occt));
      expect(filled.error).toBeUndefined();
      doc = filled.document;
      stock = idOf(filled);
    }
    const [first, ...rest] = data.actions;
    const actions = [{ ...first, params: { ...first?.params, target: stock } }, ...rest];
    const built = execute(doc, 'build_project', { actions }, ctxOf(kernels.occt));
    expect(built.error).toBeUndefined();
    expect(built.document.order).toHaveLength(1);
    const error = rel(volumeOf(kernels.occt, built.document, built.document.order[0] as string), target);
    console.warn(`VC-FTR-32 CTC-01: relative volume error ${error}`);
    expect(error).toBeLessThan(REL);
  }, 900_000);
});
