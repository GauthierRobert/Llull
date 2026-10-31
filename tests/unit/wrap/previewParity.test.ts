/**
 * 03 WRP previews (spec §14.19) agree with the commands: the knurl lines are the grooves the recipes sweep (same phase and frame, also where the surface frame is turned), the refusals before the build are the
 * ones of add_knurl with model geometry too, and no preview path hands anything to the kernel.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { axisFrame } from '@core/commands/solids/shared';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { dot3 } from '@lib/vec3';
import type { MeshSolidEntity, ShapeRecipe, Vec3 } from '@core/model/types';
import { fakeWrapKernel, type FakeWrapOptions } from '../../helpers/fakeWrapKernel';
import { helicalDepthForLand, helicalGrooveArea } from '@core/commands/wrap/knurlHelix';
import { box, emptyDoc, make } from './support';

type Solid = Extract<ShapeRecipe, { op: 'solid' }>['entity'];
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;

/** The fake kernel with the surface frame of every cylinder face turned by `turnDeg` about its axis (its xDir is then not the x of the axis frame the grooves are built in). */
function turnedKernel(turnDeg: number, options: FakeWrapOptions = {}): GeometryKernel {
  const base = fakeWrapKernel(options);
  const query = base.faceQuery;
  if (query === undefined) throw new Error('fake kernel has no face query');
  const turn = (turnDeg * Math.PI) / 180;
  return {
    ...base,
    faceQuery: {
      ...query,
      faceGeometry: (shape: Parameters<typeof query.faceGeometry>[0], face: number) => {
        const geometry = query.faceGeometry(shape, face);
        if (geometry === null || geometry.surface.type !== 'cylinder') return geometry;
        return { ...geometry, surface: { ...geometry.surface, xDir: [Math.cos(turn), Math.sin(turn), 0] as Vec3 } };
      },
    },
  } as GeometryKernel;
}

const solidsOf = (recipe: ShapeRecipe): Solid[] => {
  if (recipe.op === 'solid') return [recipe.entity];
  if (recipe.op === 'boolean') return [...solidsOf(recipe.a), ...solidsOf(recipe.b)];
  if (recipe.op === 'place') return solidsOf(recipe.source);
  return [];
};
const toolOf = (doc: ReturnType<typeof emptyDoc>, id: string): ShapeRecipe =>
  ((doc.entities[id] as MeshSolidEntity).brep as Extract<ShapeRecipe, { op: 'boolean' }>).b;

afterEach(() => setGeometryKernel(null));

describe('preview_add_knurl draws the grooves the recipes sweep', () => {
  const rod = (): { doc: ReturnType<typeof emptyDoc>; id: string } => {
    const made = make(emptyDoc(), 'add_cylinder', { radius: 10, height: 40 });
    return { doc: made.doc, id: made.id };
  };
  const face = { faceNear: [10, 0, 0] };
  const frame = axisFrame([0, 0, 1], [0, 0, 0]);
  if (typeof frame === 'string') throw new Error(frame);
  /** Azimuth of a world point in the frame the recipes use. */
  const azimuthOf = (point: Vec3): number =>
    Math.atan2(dot3(point, frame.directionAt([0, 1, 0])), dot3(point, frame.directionAt([1, 0, 0])));
  const same = (a: number, b: number): boolean => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < 1e-9;

  it('on a cylinder whose surface frame is turned 37 degrees, preview line k starts at the azimuth of groove k of the straight recipe', () => {
    setGeometryKernel(turnedKernel(37));
    const { doc, id } = rod();
    const params = { id, face, pattern: 'straight', pitch: 1, model: 'geometry' };
    const cut = execute(doc, 'add_knurl', params);
    expect(cut.rejected, cut.summary).toBeUndefined();
    const grooves = solidsOf(toolOf(cut.document, cut.affected[0] as string));
    expect(grooves).toHaveLength(63);
    const lines = data(execute(doc, 'preview_add_knurl', params))['lines'] as Array<{ tooth: number; points: Vec3[] }>;
    expect(lines).toHaveLength(63);
    for (const line of lines) {
      const groove = grooves[line.tooth] as Solid;
      const start = groove.kind === 'extrusion' ? (groove.profile[0] as [number, number]) : [NaN, NaN];
      for (const point of line.points) expect(same(azimuthOf(point), Math.atan2(start[1] as number, start[0] as number))).toBe(true);
    }
  });

  it('on the same cylinder the helical grooves start where the sweeps start (startAngle at z0) and run the hand of the recipe: azimuth = startAngle +- 2 pi (z - z0) / lead', () => {
    setGeometryKernel(turnedKernel(37));
    const { doc, id } = rod();
    for (const hand of ['right', 'left'] as const) {
      const pitch = (Math.PI * 20) / 8;
      const depth = helicalDepthForLand(pitch, 90, 15, 0.1);
      const groove = helicalGrooveArea({ teeth: 8, radius: 10, depth, toothAngleDeg: 90, helixDeg: 15, hands: 1, left: false });
      setGeometryKernel(turnedKernel(37, { grooveVolume: 40 * groove }));
      const params = { id, face, pattern: 'diagonal', pitch, model: 'geometry', helixAngleDeg: 15, hand };
      const cut = execute(doc, 'add_knurl', params);
      expect(cut.rejected, cut.summary).toBeUndefined();
      const sweeps = solidsOf(toolOf(cut.document, cut.affected[0] as string));
      expect(sweeps).toHaveLength(8);
      const lines = data(execute(doc, 'preview_add_knurl', params))['lines'] as Array<{ tooth: number; hand: string; points: Vec3[] }>;
      expect(lines).toHaveLength(8);
      const lead = (2 * Math.PI * 10) / Math.tan(Math.PI / 12);
      for (const line of lines) {
        const sweep = sweeps[line.tooth] as Solid & { helix?: { startAngle: number } };
        const z0 = dot3(sweep.position, [0, 0, 1]);
        for (const point of line.points) {
          const expected =
            (sweep.helix as { startAngle: number }).startAngle + ((hand === 'left' ? -1 : 1) * 2 * Math.PI * (point[2] - z0)) / lead;
          expect(same(azimuthOf(point), expected)).toBe(true);
        }
      }
    }
  });
});

describe('preview_add_knurl refuses what add_knurl refuses before it builds, with model geometry too', () => {
  const rodOf = (): { doc: ReturnType<typeof emptyDoc>; id: string } => {
    const made = make(emptyDoc(), 'add_cylinder', { radius: 20, height: 40 });
    return { doc: made.doc, id: made.id };
  };
  const PITCH8 = (Math.PI * 40) / 8;
  const PITCH4 = (Math.PI * 40) / 4;

  it('tooth angle, depth, land, reach, too many grooves, a bore, a diamond hand and a shoulder end give the same code and path', () => {
    const { doc, id } = rodOf();
    const base = { id, face: { faceNear: [20, 0, 0] }, model: 'geometry' };
    const cases: Array<[FakeWrapOptions, Record<string, unknown>]> = [
      [{}, { ...base, pattern: 'straight', pitch: PITCH8, toothAngleDeg: 180 }],
      [{}, { ...base, pattern: 'straight', pitch: PITCH8, toothAngleDeg: 0 }],
      [{}, { ...base, pattern: 'straight', pitch: PITCH8, depth: -1 }],
      [{}, { ...base, pattern: 'straight', pitch: PITCH8, depth: 8 }],
      [{}, { ...base, pattern: 'straight', pitch: 40, depth: 11 }],
      [{}, { ...base, pattern: 'diagonal', pitch: PITCH8, toothAngleDeg: 180 }],
      [{}, { ...base, pattern: 'diagonal', pitch: PITCH8, depth: 8 }],
      [{}, { ...base, pattern: 'diagonal', pitch: 40, depth: 11 }],
      [{}, { ...base, pattern: 'diamond', pitch: PITCH4, hand: 'left' }],
      [{}, { ...base, pattern: 'diamond', pitch: (Math.PI * 40) / 30 }],
      [{}, { ...base, pattern: 'diagonal', pitch: PITCH8, helixAngleDeg: 89.99 }],
      [{ bore: true }, { ...base, pattern: 'straight', pitch: PITCH8 }],
      [{ bore: true }, { ...base, pattern: 'diagonal', pitch: PITCH8 }],
    ];
    for (const [options, params] of cases) {
      setGeometryKernel(fakeWrapKernel(options));
      const real = execute(doc, 'add_knurl', params);
      const preview = execute(doc, 'preview_add_knurl', params);
      expect(real.error?.code, JSON.stringify(params)).toBeDefined();
      expect(preview.error?.code, JSON.stringify(params)).toBe(real.error?.code);
      expect(preview.error?.paths).toEqual(real.error?.paths);
      expect(preview.document).toBe(doc);
    }
    setGeometryKernel(fakeWrapKernel({ stadium: true }));
    const ends = make(emptyDoc(), 'add_box', { size: [40, 20, 10] });
    const unsupported = { ...base, id: ends.id, face: { faceNear: [30, 0, 0] }, pattern: 'diagonal', pitch: (Math.PI * 20) / 8 };
    expect(execute(ends.doc, 'add_knurl', unsupported).error?.code).toBe('WRP_KNURL_GEOMETRY_UNSUPPORTED');
    expect(execute(ends.doc, 'preview_add_knurl', unsupported).error?.code).toBe('WRP_KNURL_GEOMETRY_UNSUPPORTED');
  });

  it('a valid modeled knurl answers with the depth, land and tooth angle the command uses', () => {
    setGeometryKernel(fakeWrapKernel());
    const { doc, id } = rodOf();
    const params = {
      id,
      face: { faceNear: [20, 0, 0] },
      pattern: 'straight',
      pitch: (Math.PI * 40) / 60,
      model: 'geometry',
      toothAngleDeg: 60,
    };
    const previewed = execute(doc, 'preview_add_knurl', params);
    expect(previewed.rejected, previewed.summary).toBeUndefined();
    const info = data(previewed) as { depth: number; land: number; toothAngleDeg: number };
    expect(info.toothAngleDeg).toBe(60);
    const cut = execute(doc, 'add_knurl', params).data as { depth: number; land: number };
    expect(info.depth).toBeCloseTo(cut.depth, 12);
    expect(info.land).toBeCloseTo(cut.land, 12);
  });
});

describe('no preview path hands anything to the kernel', () => {
  it('emboss, deboss, walls pull and walls pull with a draft, and the knurl previews (cosmetic and modeled) evaluate nothing; the draft is said to be built by the command', () => {
    const base = fakeWrapKernel({ pullWalls: true });
    let evaluations = 0;
    // opening the solid evaluates its own recipe (an authored solid); anything else handed to the kernel is a build
    setGeometryKernel({
      ...base,
      evaluate: (recipe: ShapeRecipe) => (recipe.op === 'solid' ? 0 : evaluations++, base.evaluate(recipe)),
    } as GeometryKernel);
    const solid = box();
    const sketch = make(solid.doc, 'draw_rectangle', { width: 20, height: 10, position: [-10, -5, 5] });
    const common = {
      id: solid.id,
      face: { faceNear: [0, 0, 5] },
      profileIds: [sketch.id],
      depth: 2,
      placement: { anchor: { chart: [0, 0], on: [0, 0, 5] } },
    };
    const results = [
      execute(sketch.doc, 'preview_emboss_on_face', { ...common, mode: 'emboss' }),
      execute(sketch.doc, 'preview_emboss_on_face', { ...common, mode: 'deboss' }),
      execute(sketch.doc, 'preview_emboss_on_face', { ...common, mode: 'emboss', walls: 'pull', pullDirection: [0, 0, 1] }),
      execute(sketch.doc, 'preview_emboss_on_face', { ...common, mode: 'emboss', walls: 'pull', pullDirection: [0, 0, 1], draftDeg: 5 }),
    ];
    for (const result of results) expect(result.rejected, result.summary).toBeUndefined();
    expect(evaluations).toBe(0);
    expect(data(results[3] as ReturnType<typeof execute>)['draftChecked']).toContain('built and checked by emboss_on_face');
    expect(data(results[2] as ReturnType<typeof execute>)['draftChecked']).toBeUndefined();
    const cylinder = make(emptyDoc(), 'add_cylinder', { radius: 10, height: 40 });
    for (const model of ['cosmetic', 'geometry']) {
      const knurl = execute(cylinder.doc, 'preview_add_knurl', {
        id: cylinder.id,
        face: { faceNear: [10, 0, 0] },
        pattern: 'straight',
        pitch: 1,
        model,
      });
      expect(knurl.rejected, knurl.summary).toBeUndefined();
    }
    expect(evaluations).toBe(0);
    // the command does build: the counter sees it
    execute(sketch.doc, 'emboss_on_face', { ...common, mode: 'emboss', walls: 'pull', pullDirection: [0, 0, 1], draftDeg: 5 });
    expect(evaluations).toBeGreaterThan(0);
  });
});
