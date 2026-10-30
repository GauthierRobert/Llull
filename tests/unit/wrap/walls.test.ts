/**
 * 03 WRP M5 (VC-WRP-25 / 26) on the fake exact kernel: emboss_on_face / deboss with walls along a pull direction and a draft: the recipe the command builds (footprint prism x face-offset
 * layer, drafted walls), the data it reports and every refusal by code. The fake's boolean volumes are bookkeeping; the exact volumes are proved on the native kernel in
 * server/tests/nativeWrapWalls.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument, MeshSolidEntity, ShapeRecipe } from '@core/model/types';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { box, cylinder, emptyDoc, make, sphere, useFakeKernel } from './support';
import { fakeWrapKernel } from '../../helpers/fakeWrapKernel';
import { setGeometryKernel } from '@core/geometry/kernel';

const TOP = { faceNear: [0, 0, 5] };
const topPlacement = { anchor: { chart: [0, 0], on: [0, 0, 5] } };

const rectangleOn = (doc: CadDocument, width: number, height: number, z: number): { doc: CadDocument; id: string } =>
  make(doc, 'draw_rectangle', { width, height, position: [-width / 2, -height / 2, z] });
const recipeOf = (doc: CadDocument, id: string): ShapeRecipe => (doc.entities[id] as MeshSolidEntity).brep as ShapeRecipe;
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;

describe('emboss_on_face with walls along a pull (fake kernel)', () => {
  useFakeKernel({ pullWalls: true });

  const onBox = (extra: Record<string, unknown> = {}, mode = 'emboss'): ReturnType<typeof execute> => {
    const solid = box();
    const sketch = rectangleOn(solid.doc, 20, 10, 5);
    return execute(sketch.doc, 'emboss_on_face', {
      id: solid.id,
      face: TOP,
      profileIds: [sketch.id],
      mode,
      depth: 2,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: topPlacement,
      ...extra,
    });
  };

  it('VC-WRP-25 recipe: emboss = source + (prism of the footprint x (offset - source)), the footprint a 4-vertex rectangle; the plane closed form A d is reported', () => {
    const done = onBox();
    expect(done.rejected, done.summary).toBeUndefined();
    const info = data(done);
    expect(info).toMatchObject({
      walls: 'pull',
      pullDirection: [0, 0, 1],
      draftDeg: 0,
      footprintSize: 4,
      draftedWalls: 0,
      faceKind: 'plane',
    });
    expect(info['expectedVolumeDelta']).toBeCloseTo(400, 9);
    expect(info['volumeDelta'] as number).toBeGreaterThan(0);
    const recipe = recipeOf(done.document, done.affected[0] as string);
    expect(recipe).toMatchObject({ op: 'boolean', boolean: 'union' });
    const text = JSON.stringify(recipe);
    expect(text).toContain('"kind":"moveFaces"');
    expect(text).toContain('"boolean":"intersect"');
    expect(text).toContain('"op":"place"');
    expect(done.summary).toContain('emboss of 1 profile');
  });

  it('deboss subtracts the prism x (source - offset), the offset going inward', () => {
    const done = onBox({}, 'deboss');
    expect(done.rejected, done.summary).toBeUndefined();
    expect(data(done)['volumeDelta'] as number).toBeLessThan(0);
    const recipe = recipeOf(done.document, done.affected[0] as string);
    expect(recipe).toMatchObject({ op: 'boolean', boolean: 'subtract' });
    expect(JSON.stringify(recipe)).toContain('"distance":-2');
  });

  it('a draft tilts the 4 walls of the footprint prism about the plane through the anchor (a faceOp draft node on the prism); the closed form is not claimed', () => {
    const done = onBox({ draftDeg: 10 });
    expect(done.rejected, done.summary).toBeUndefined();
    expect(data(done)).toMatchObject({ draftDeg: 10, draftedWalls: 4, expectedVolumeDelta: null });
    const drafts: Array<{ kind: string; angle: number; pull: number[]; neutral: { origin: number[]; normal: number[] }; faces: number[] }> =
      [];
    JSON.parse(JSON.stringify(recipeOf(done.document, done.affected[0] as string)), (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'draft') drafts.push(value as never);
      return value;
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.angle).toBeCloseTo((10 * Math.PI) / 180, 12);
    expect(drafts[0]?.pull).toEqual([0, 0, 1]);
    expect(drafts[0]?.neutral.normal).toEqual([0, 0, 1]);
    expect(drafts[0]?.neutral.origin[2]).toBeCloseTo(5, 9);
    expect(drafts[0]?.faces).toHaveLength(4);
    const deboss = onBox({ draftDeg: 10 }, 'deboss');
    expect(deboss.rejected, deboss.summary).toBeUndefined();
    // the deboss feature extends into the material: its prism narrows along -z
    expect(JSON.stringify(recipeOf(deboss.document, deboss.affected[0] as string))).toContain('"pull":[0,0,-1]');
  });

  it('a pull of either sign, a non-unit pull and an oblique pull all work on a plane (the relief extends along the outward side)', () => {
    for (const pullDirection of [
      [0, 0, -3],
      [0, 0, 2],
      [1, 0, 1],
    ])
      expect(onBox({ pullDirection }).rejected, String(pullDirection)).toBeUndefined();
  });

  it('works on a cylinder, a cone and a sphere face too, with the offset layer of that face', () => {
    const cyl = cylinder();
    const sketch = make(cyl.doc, 'draw_rectangle', { width: 30, height: 10, position: [-15, -5, 0] });
    const done = execute(sketch.doc, 'emboss_on_face', {
      id: cyl.id,
      face: { faceNear: [20, 0, 0] },
      profileIds: [sketch.id],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [1, 0, 0],
      placement: { anchor: { chart: [0, 0], on: [20, 0, 0] } },
    });
    expect(done.rejected, done.summary).toBeUndefined();
    expect(data(done)['expectedVolumeDelta']).toBeNull();
    expect(data(done)['regionArea']).toBeCloseTo(300, 9);
    const ball = sphere();
    const disc = make(ball.doc, 'draw_arc', { radius: 5, center: [0, 0] });
    const capped = execute(disc.doc, 'emboss_on_face', {
      id: ball.id,
      face: { faceNear: [0, 0, 25] },
      profileIds: [disc.id],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
    });
    expect(capped.rejected, capped.summary).toBeUndefined();
    expect(data(capped)['footprintSize'] as number).toBeGreaterThan(8);
  });

  it('text with a hole keeps the hole as a subtracted prism: more footprint vertices than the outline alone', () => {
    const solid = box();
    const text = make(solid.doc, 'add_text', { content: 'O', position: [0, 0, 5], height: 8, font: 'Fira Sans', anchor: 'center' });
    const done = execute(text.doc, 'emboss_on_face', {
      id: solid.id,
      face: TOP,
      profileIds: [text.id],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: topPlacement,
    });
    expect(done.rejected, done.summary).toBeUndefined();
    expect(data(done)['footprintSize'] as number).toBeGreaterThan(10);
    expect(
      JSON.stringify(recipeOf(done.document, done.affected[0] as string)).match(/"boolean":"subtract"/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('a drafted letter with a hole: the outline prism narrows along the axis and the hole prism widens (opposite pulls)', () => {
    const solid = box();
    const text = make(solid.doc, 'add_text', { content: 'O', position: [0, 0, 5], height: 8, font: 'Fira Sans', anchor: 'center' });
    const done = execute(text.doc, 'emboss_on_face', {
      id: solid.id,
      face: TOP,
      profileIds: [text.id],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      draftDeg: 3,
      placement: topPlacement,
    });
    expect(done.rejected, done.summary).toBeUndefined();
    expect(data(done)['draftedWalls']).toBe(8);
    const text2 = JSON.stringify(recipeOf(done.document, done.affected[0] as string));
    expect(text2).toContain('"pull":[0,0,1]');
    expect(text2).toContain('"pull":[0,0,-1]');
  });

  it('is pure', () => {
    const solid = box();
    const sketch = rectangleOn(solid.doc, 20, 10, 5);
    const params = {
      id: solid.id,
      face: TOP,
      profileIds: [sketch.id],
      mode: 'emboss',
      depth: 2,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: topPlacement,
    };
    expectPure(sketch.doc, () => execute(sketch.doc, 'emboss_on_face', params));
  });

  it('refuses by code: a pull along the face, a pull folding over the region, a draft that closes the profile (naming the largest draft), a torus, and invalid combinations', () => {
    const cyl = cylinder();
    const sketch = make(cyl.doc, 'draw_rectangle', { width: 30, height: 10, position: [-15, -5, 0] });
    const params = {
      id: cyl.id,
      face: { faceNear: [20, 0, 0] },
      profileIds: [sketch.id],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [1, 0, 0],
      placement: { anchor: { chart: [0, 0], on: [20, 0, 0] } },
    };
    const along = expectRefusal(
      sketch.doc,
      'emboss_on_face',
      { ...params, pullDirection: [0, 0, 1] },
      'WRP_PULL_PARALLEL',
      'pullDirection',
    );
    expect(along.summary).toContain('degrees from the face');
    const wide = make(cyl.doc, 'draw_rectangle', { width: 70, height: 10, position: [-35, -5, 0] });
    const folded = expectRefusal(wide.doc, 'emboss_on_face', { ...params, profileIds: [wide.id] }, 'WRP_PULL_PARALLEL');
    expect(folded.summary).toContain('folds over');
    const solid = box();
    const flat = rectangleOn(solid.doc, 20, 10, 5);
    const closes = expectRefusal(
      flat.doc,
      'emboss_on_face',
      {
        id: solid.id,
        face: TOP,
        profileIds: [flat.id],
        mode: 'emboss',
        depth: 20,
        walls: 'pull',
        pullDirection: [0, 0, 1],
        draftDeg: 20,
        placement: topPlacement,
      },
      'WRP_DRAFT_CLOSES',
      'draftDeg',
    );
    expect(closes.summary).toContain('largest draft');
    const limit = (closes.data as { maxDraftDeg: number }).maxDraftDeg;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(20);
    const ring = make(emptyDoc(), 'add_torus', { ringRadius: 30, tubeRadius: 8 });
    const tiny = make(ring.doc, 'draw_rectangle', { width: 2, height: 2, position: [-1, -1, 0] });
    expectRefusal(
      tiny.doc,
      'emboss_on_face',
      {
        id: ring.id,
        face: { faceNear: [38, 0, 0] },
        profileIds: [tiny.id],
        mode: 'emboss',
        depth: 1,
        walls: 'pull',
        pullDirection: [1, 0, 0],
        placement: { method: 'parametric', anchor: { chart: [0, 0], on: [38, 0, 0] } },
      },
      'WRP_PARAM_INVALID',
    );
    expectRefusal(sketch.doc, 'emboss_on_face', { ...params, pullDirection: undefined }, 'WRP_PARAM_INVALID', 'pullDirection');
    expectRefusal(sketch.doc, 'emboss_on_face', { ...params, pullDirection: [0, 0, 0] }, 'WRP_PARAM_INVALID', 'pullDirection');
    expectRefusal(sketch.doc, 'emboss_on_face', { ...params, mode: 'scribe', depth: undefined }, 'WRP_PARAM_INVALID', 'walls');
    expectRefusal(sketch.doc, 'emboss_on_face', { ...params, walls: undefined, draftDeg: 5 }, 'WRP_PARAM_INVALID', 'draftDeg');
    expectRefusal(
      sketch.doc,
      'emboss_on_face',
      { ...params, walls: undefined, pullDirection: [1, 0, 0] },
      'WRP_PARAM_INVALID',
      'pullDirection',
    );
    expectRefusal(sketch.doc, 'emboss_on_face', { ...params, draftDeg: 50 }, 'WRP_PARAM_INVALID', 'draftDeg');
  });
});

describe('walls pull when the kernel cannot build the relief', () => {
  it('a draft without planar walls and a kernel that refuses the boolean are named', () => {
    setGeometryKernel(fakeWrapKernel({ pullWalls: false }));
    try {
      const solid = box();
      const sketch = rectangleOn(solid.doc, 20, 10, 5);
      const params = {
        id: solid.id,
        face: TOP,
        profileIds: [sketch.id],
        mode: 'emboss',
        depth: 2,
        walls: 'pull',
        pullDirection: [0, 0, 1],
        draftDeg: 10,
        placement: topPlacement,
      };
      const noWalls = execute(sketch.doc, 'emboss_on_face', params);
      expect(noWalls.error?.code).toBe('WRP_KERNEL_BUILD_FAILED');
      expect(noWalls.summary).toContain('no planar walls');
      setGeometryKernel(fakeWrapKernel({ pullWalls: true, refuseBoolean: true }));
      const refused = execute(sketch.doc, 'emboss_on_face', { ...params, draftDeg: undefined });
      expect(refused.error?.code).toBe('WRP_KERNEL_BUILD_FAILED');
      const unbuilt = execute(sketch.doc, 'emboss_on_face', params);
      expect(unbuilt.error?.code).toBe('WRP_KERNEL_BUILD_FAILED');
      expect(unbuilt.summary).toContain('could not');
    } finally {
      setGeometryKernel(null);
    }
  });
});

describe('pull walls: thin strokes, footprint fit, limits and check_wrap (fake kernel)', () => {
  useFakeKernel({ pullWalls: true });

  const onTop = (doc: CadDocument, id: string, profileId: string, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
    execute(doc, 'emboss_on_face', {
      id,
      face: TOP,
      profileIds: [profileId],
      mode: 'emboss',
      depth: 5,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      placement: topPlacement,
      ...extra,
    });

  it('WRP_DRAFT_CLOSES is the thinnest place, not the bounding box: a 20 x 1 bar turned 45 degrees (box side 14.8) closes at 10 degrees, and reports the largest draft', () => {
    const solid = box();
    const c = Math.SQRT1_2;
    const corner = (x: number, y: number): [number, number] => [c * (x - y), c * (x + y)];
    const bar = make(solid.doc, 'draw_polyline', {
      points: [corner(-10, -0.5), corner(10, -0.5), corner(10, 0.5), corner(-10, 0.5)],
      closed: true,
    });
    const closes = expectRefusal(
      bar.doc,
      'emboss_on_face',
      {
        id: solid.id,
        face: TOP,
        profileIds: [bar.id],
        mode: 'emboss',
        depth: 5,
        walls: 'pull',
        pullDirection: [0, 0, 1],
        draftDeg: 10,
        placement: topPlacement,
      },
      'WRP_DRAFT_CLOSES',
      'draftDeg',
    );
    const info = closes.data as { maxDraftDeg: number; thinnestPlace: number };
    expect(info.thinnestPlace).toBeCloseTo(1, 6);
    expect(info.maxDraftDeg).toBeGreaterThan(0);
    expect(info.maxDraftDeg).toBeLessThan(10);
    const fits = onTop(bar.doc, solid.id, bar.id, { draftDeg: info.maxDraftDeg * 0.9 });
    expect(fits.rejected, fits.summary).toBeUndefined();
  });

  it('a drafted "O" closes by the thickness of its stroke (the hole prism widens while the outline narrows)', () => {
    const solid = box();
    const text = make(solid.doc, 'add_text', { content: 'O', position: [0, 0, 5], height: 8, font: 'Fira Sans', anchor: 'center' });
    const closes = expectRefusal(
      text.doc,
      'emboss_on_face',
      {
        id: solid.id,
        face: TOP,
        profileIds: [text.id],
        mode: 'emboss',
        depth: 3,
        walls: 'pull',
        pullDirection: [0, 0, 1],
        draftDeg: 20,
        placement: topPlacement,
      },
      'WRP_DRAFT_CLOSES',
      'draftDeg',
    );
    expect((closes.data as { thinnestPlace: number }).thinnestPlace).toBeLessThan(1.5);
    expect(onTop(text.doc, solid.id, text.id, { depth: 1, draftDeg: 3 }).rejected).toBeUndefined();
  });

  it('reports the fit of the footprint: a circle is fitted within fitTolerance (exact false, deviation above 0), a rectangle is exact; a draft reports the base growth, an oblique pull the shift', () => {
    const solid = box();
    const disk = make(solid.doc, 'draw_arc', { center: [0, 0], radius: 6 });
    const tolerance = 1e-4;
    const round = onTop(disk.doc, solid.id, disk.id, { depth: 2, fitTolerance: tolerance });
    expect(round.rejected, round.summary).toBeUndefined();
    expect(data(round)['exact']).toBe(false);
    expect(data(round)['footprintDeviation'] as number).toBeGreaterThan(0);
    expect(data(round)['footprintDeviation'] as number).toBeLessThanOrEqual(tolerance);
    const rect = rectangleOn(solid.doc, 20, 10, 5);
    const straight = onTop(rect.doc, solid.id, rect.id, { depth: 2 });
    expect(data(straight)['exact']).toBe(true);
    expect(data(straight)['footprintDeviation']).toBe(0);
    expect(data(straight)['obliqueShift']).toBeCloseTo(0, 9);
    const drafted = onTop(rect.doc, solid.id, rect.id, { depth: 2, draftDeg: 5, pullDirection: [1, 0, 3] });
    expect(drafted.rejected, drafted.summary).toBeUndefined();
    expect(data(drafted)['draftBaseGrowth'] as number).toBeGreaterThan(0);
    expect(data(drafted)['obliqueShift'] as number).toBeCloseTo(2 * (1 / 3), 6);
  });

  it('refuses a footprint of more than 4000 segments by name, and a loop that projects to nothing', () => {
    const solid = box();
    const points = Array.from({ length: 4100 }, (_, k): [number, number] => [
      5 * Math.cos((k * 2 * Math.PI) / 4100),
      5 * Math.sin((k * 2 * Math.PI) / 4100),
    ]);
    const ring = make(solid.doc, 'draw_polyline', { points, closed: true });
    const many = expectRefusal(
      ring.doc,
      'emboss_on_face',
      {
        id: solid.id,
        face: TOP,
        profileIds: [ring.id],
        mode: 'emboss',
        depth: 1,
        walls: 'pull',
        pullDirection: [0, 0, 1],
        placement: topPlacement,
      },
      'WRP_PARAM_INVALID',
      'profileIds',
    );
    expect(many.summary).toContain('4000');
    const sliver = make(solid.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [8, 0],
        [4, 0],
      ],
      closed: true,
    });
    const flat = execute(sliver.doc, 'emboss_on_face', {
      id: solid.id,
      face: TOP,
      profileIds: [sliver.id],
      mode: 'emboss',
      depth: 1,
      walls: 'pull',
      pullDirection: [0, 0, 1],
      draftDeg: 2,
      placement: topPlacement,
    });
    expect(flat.rejected).toBe(true);
  });

  it('check_wrap counts a pull relief (it has no emboss node): the volume is not claimed (WRP_CHECK_VOLUME_SKIPPED warn), the direction is checked, and a result whose volume moved the wrong way fails', () => {
    const solid = box();
    const rect = rectangleOn(solid.doc, 20, 10, 5);
    const done = onTop(rect.doc, solid.id, rect.id, { depth: 2 });
    const id = done.affected[0] as string;
    for (const ids of [undefined, [id]]) {
      const checked = execute(done.document, 'check_wrap', { ids, maxLengthStrain: 0.02 });
      expect(checked.rejected, checked.summary).toBeUndefined();
      const report = checked.data as {
        status: string;
        checked: { ids: number; volumesSkipped: number; reliefsWithoutClosedForm: number };
        findings: Array<{ code: string; severity: string; ids: string[] }>;
      };
      expect(report.checked).toMatchObject({ ids: 1, volumesSkipped: 1, reliefsWithoutClosedForm: 1 });
      expect(report.findings).toContainEqual(expect.objectContaining({ code: 'WRP_CHECK_VOLUME_SKIPPED', severity: 'warn', ids: [id] }));
      expect(report.status).toBe('warn');
    }
    const wrongWay = {
      ...done.document,
      featureHistory: done.document.featureHistory.map((step) =>
        step.name === 'emboss_on_face' ? { ...step, params: { ...(step.params as Record<string, unknown>), mode: 'deboss' } } : step,
      ),
    };
    const bad = execute(wrongWay, 'check_wrap', { ids: [id], maxLengthStrain: 0.02 });
    expect((bad.data as { status: string }).status).toBe('fail');
    expect((bad.data as { findings: Array<{ code: string }> }).findings.map((f) => f.code)).toContain('WRP_CHECK_VOLUME_MISMATCH');
    expect(JSON.stringify(wrongWay)).not.toBe(JSON.stringify(done.document));
  });
});
