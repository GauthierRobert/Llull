/**
 * DIR M6 on the native OCCT kernel (docs/design/04-direct-freeform-editing, validation pack): move_faces offset / translate / rotate and delete_faces
 * on real B-reps (VC-DIR-23, 24, 25), feature moves of holes and bosses, refusals with stable codes, regeneration by recorded face names.
 * Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

interface Step {
  readonly doc: CadDocument;
  readonly id: string;
  readonly result: ReturnType<typeof execute>;
}

describeNative('DIR M6: move_faces and delete_faces (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const run = (doc: CadDocument, command: string, params: Record<string, unknown>): Step => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const centroid = (doc: CadDocument, id: string): number[] =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { centroid: number[] }).centroid;
  const code = (step: Step): string | undefined => step.result.error?.code;
  const near = (actual: number, expected: number, rel = 1e-6): void =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.abs(expected));

  /** 20 x 20 x 10 plate with a radius-3 through hole (VC-DIR-23). */
  const plate = (): Step => {
    const box = run(createEmptyDocument(), 'add_box', { size: [20, 20, 10] });
    const pin = run(box.doc, 'add_cylinder', { radius: 3, height: 20 });
    return run(pin.doc, 'boolean', { op: 'subtract', a: box.id, b: pin.id });
  };

  it('offset +1 on the bore widens it to radius 4: 3717.25666118 -> 3497.34517543 (VC-DIR-23)', () => {
    const holed = plate();
    near(volume(holed.doc, holed.id), 3717.25666118);
    const bored = run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[3, 0, 0]], mode: 'offset', distance: 1 });
    near(volume(bored.doc, bored.id), 3497.34517543);
    const data = bored.result.data as { volumeBefore: number; volumeAfter: number; faces: number[] };
    near(data.volumeBefore, 3717.25666118);
    near(data.volumeAfter, 3497.34517543);
    expect(data.faces).toHaveLength(1);
    expect(bored.doc.featureHistory.at(-1)?.params).toMatchObject({ faceNames: [expect.any(String)] });
    const narrower = run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[3, 0, 0]], mode: 'offset', distance: -1 });
    near(volume(narrower.doc, narrower.id), 4000 - Math.PI * 4 * 10);
  });

  it('offset thickens a boss and a cap radially away from the axis (face 0 of a cylinder is its wall)', () => {
    const cylinder = run(createEmptyDocument(), 'add_cylinder', { radius: 3, height: 10 });
    const thicker = run(cylinder.doc, 'move_faces', { id: cylinder.id, faceIndices: [0], mode: 'offset', distance: 1 });
    near(volume(thicker.doc, thicker.id), Math.PI * 16 * 10);
    const taller = run(cylinder.doc, 'move_faces', { id: cylinder.id, faceIndices: [1], mode: 'offset', distance: 1 });
    near(volume(taller.doc, taller.id), Math.PI * 9 * 11);
    const sphere = run(createEmptyDocument(), 'add_sphere', { radius: 5 });
    const bigger = run(sphere.doc, 'move_faces', { id: sphere.id, faceIndices: [0], mode: 'offset', distance: 1 });
    near(volume(bigger.doc, bigger.id), (4 / 3) * Math.PI * 216, 2e-3);
  });

  it('offset of two ADJACENT faces closes the corner (11 x 11 x 10), not a notch', () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [0, 0, 5] });
    const moved = run(box.doc, 'move_faces', {
      id: box.id,
      facesNear: [
        [5, 0, 5],
        [0, 5, 5],
      ],
      mode: 'offset',
      distance: 1,
    });
    expect(moved.result.rejected, moved.result.summary).toBeUndefined();
    near(volume(moved.doc, moved.id), 11 * 11 * 10);
    const grown = run(box.doc, 'move_faces', {
      id: box.id,
      facesNear: [
        [5, 0, 5],
        [0, 5, 5],
        [0, 0, 10],
      ],
      mode: 'offset',
      distance: 1,
    });
    near(volume(grown.doc, grown.id), 11 * 11 * 11);
  });

  it('offset of the top face of a drafted block follows the tilted walls', () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [0, 0, 5] });
    const drafted = run(box.doc, 'draft_faces', { id: box.id, facesNear: [[5, 0, 5]], angle: 5 });
    const v0 = volume(drafted.doc, drafted.id);
    const k = (v0 - 1000) / 500;
    const taller = run(drafted.doc, 'move_faces', { id: drafted.id, facesNear: [[0, 0, 10]], mode: 'offset', distance: 2 });
    expect(taller.result.rejected, taller.result.summary).toBeUndefined();
    near(volume(taller.doc, taller.id), v0 + 200 + 220 * k);
  });

  it('translate the top face of a 10 cube by +2 -> 1200; rotate the +x face by 10 degrees -> 1088.16349035 (VC-DIR-24)', () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [0, 0, 5] });
    const taller = run(box.doc, 'move_faces', { id: box.id, facesNear: [[0, 0, 10]], mode: 'translate', vector: [0, 0, 2] });
    near(volume(taller.doc, taller.id), 1200);
    const slid = run(box.doc, 'move_faces', { id: box.id, facesNear: [[0, 0, 10]], mode: 'translate', vector: [1, 0, 2] });
    near(volume(slid.doc, slid.id), 1200);
    const leaning = run(box.doc, 'move_faces', {
      id: box.id,
      facesNear: [[5, 0, 5]],
      mode: 'rotate',
      axis: { origin: [5, 0, 0], direction: [0, 1, 0] },
      angleDeg: 10,
    });
    near(volume(leaning.doc, leaning.id), 1088.16349035);
    const other = run(box.doc, 'move_faces', {
      id: box.id,
      facesNear: [[5, 0, 5]],
      mode: 'rotate',
      axis: { origin: [5, 0, 0], direction: [0, 1, 0] },
      angleDeg: -10,
    });
    near(volume(other.doc, other.id), 1000 - 0.5 * 10 * 10 * Math.tan((10 * Math.PI) / 180) * 10 * 1 + 0);
  });

  it('moving a hole (a feature) keeps the volume and shifts the centroid; moving a boss too', () => {
    const holed = plate();
    const before = volume(holed.doc, holed.id);
    const moved = run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[3, 0, 0]], mode: 'translate', vector: [2, 0, 0] });
    expect(moved.result.rejected, moved.result.summary).toBeUndefined();
    near(volume(moved.doc, moved.id), before);
    near(centroid(moved.doc, moved.id)[0] as number, (-2 * Math.PI * 9 * 10) / before, 1e-4);
    const turned = run(holed.doc, 'move_faces', {
      id: holed.id,
      facesNear: [[3, 0, 0]],
      mode: 'rotate',
      axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
      angleDeg: 90,
    });
    near(volume(turned.doc, turned.id), before);
    const base = run(createEmptyDocument(), 'add_box', { size: [20, 20, 10] });
    const boss = run(base.doc, 'add_cylinder', { radius: 2, height: 6, position: [0, 0, 5] });
    const joined = run(boss.doc, 'boolean', { op: 'union', a: base.id, b: boss.id });
    const shifted = run(joined.doc, 'move_faces', {
      id: joined.id,
      facesNear: [
        [2, 0, 6.5],
        [0, 0, 8],
      ],
      mode: 'translate',
      vector: [4, 0, 0],
    });
    expect(shifted.result.rejected, shifted.result.summary).toBeUndefined();
    near(volume(shifted.doc, shifted.id), volume(joined.doc, joined.id), 1e-4);
  });

  it('a moved hole keeps the persistent name of its wall: a later step addresses it by that name, and the history replays', () => {
    const holed = plate();
    const namedWalls = (doc: CadDocument, id: string): string[] =>
      (run(doc, 'inspect_topology', { id }).result.data as { faces: Array<{ name: string; surface?: string }> }).faces
        .filter((face) => face.surface === 'cylinder')
        .map((face) => face.name);
    const before = namedWalls(holed.doc, holed.id);
    expect(before).toHaveLength(1);
    const moved = run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[3, 0, 0]], mode: 'translate', vector: [2, 0, 0] });
    expect(namedWalls(moved.doc, moved.id)).toEqual(before);
    const wider = run(moved.doc, 'move_faces', { id: moved.id, faceNames: before, mode: 'offset', distance: 1 });
    expect(wider.result.rejected, wider.result.summary).toBeUndefined();
    near(volume(wider.doc, wider.id), 4000 - Math.PI * 16 * 10);
    const replayed = execute(wider.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    near(volume(replayed.document, replayed.document.order.at(-1) as string), 4000 - Math.PI * 16 * 10);
  });

  it('delete_faces removes a fillet (997.853981634 -> 1000, VC-DIR-25) and fills a hole', () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [0, 0, 5] });
    const rounded = run(box.doc, 'fillet_edge', { id: box.id, edgesNear: [[5, 0, 10]], radius: 1 });
    near(volume(rounded.doc, rounded.id), 997.853981634);
    const sharp = run(rounded.doc, 'delete_faces', { id: rounded.id, facesNear: [[4.7071, 0, 9.7071]] });
    near(volume(sharp.doc, sharp.id), 1000);
    const holed = plate();
    const filled = run(holed.doc, 'delete_faces', { id: holed.id, facesNear: [[3, 0, 0]] });
    near(volume(filled.doc, filled.id), 4000);
    const base = run(createEmptyDocument(), 'add_box', { size: [20, 20, 10] });
    const boss = run(base.doc, 'add_cylinder', { radius: 2, height: 6, position: [0, 0, 5] });
    const joined = run(boss.doc, 'boolean', { op: 'union', a: base.id, b: boss.id });
    const flat = run(joined.doc, 'delete_faces', {
      id: joined.id,
      facesNear: [
        [2, 0, 6.5],
        [0, 0, 8],
      ],
    });
    near(volume(flat.doc, flat.id), 4000);
  });

  it('refuses with stable codes and leaves the document unchanged', () => {
    const holed = plate();
    expect(code(run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[3, 0, 0]], mode: 'offset', distance: -3 }))).toBe(
      'DIR_FACE_MOVE_TOPOLOGY',
    );
    for (const params of [
      { mode: 'translate' },
      { mode: 'translate', vector: [0, 0, 0] },
      { mode: 'rotate', angleDeg: 5 },
      { mode: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] } },
      { mode: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angleDeg: 200 },
      { mode: 'offset' },
    ]) {
      const refused = run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[3, 0, 0]], ...params });
      expect(code(refused)).toBe('DIR_FACE_MOVE_PARAMS');
      expect(refused.doc).toBe(holed.doc);
    }
    const flat = run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[8, 0, 5]], mode: 'translate', vector: [1, 1, 0] });
    expect(code(flat)).toBe('DIR_FACE_MOVE_FAILED');
    expect(flat.doc).toBe(holed.doc);
    const everything = run(holed.doc, 'delete_faces', { id: holed.id, faceIndices: [0, 1, 2, 3, 4, 5, 6] });
    expect(code(everything)).toBe('DIR_DEFEATURE_FAILED');
    expect(everything.doc).toBe(holed.doc);
    expect(run(holed.doc, 'move_faces', { id: holed.id, faceIndices: [99], mode: 'offset', distance: 1 }).doc).toBe(holed.doc);
    expect(run(holed.doc, 'delete_faces', { id: 'nope', faceIndices: [0] }).doc).toBe(holed.doc);
  });

  it('regenerates from the recorded face names (replay equality)', () => {
    const holed = plate();
    const bored = run(holed.doc, 'move_faces', { id: holed.id, facesNear: [[3, 0, 0]], mode: 'offset', distance: 1 });
    const replayed = execute(bored.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    const id = replayed.document.order.at(-1) as string;
    near(volume(replayed.document, id), 3497.34517543);
  });
});
