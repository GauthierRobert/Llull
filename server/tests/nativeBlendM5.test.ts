/**
 * BLD M5 on the native OCCT kernel (docs/design/06-variable-blends 13.14): the variable chamfer (`chamfer_edge` distanceEnd, VC-BLD-19) and the
 * per-joint radii of `blend_union` (VC-BLD-32), at 1 / 10 / 100 / 1000 mm against their analytic volumes. Skipped when the llull-kernel binary is
 * not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
const SIZES = [1, 10, 100, 1000] as const;
/** Area a concave right-angle fillet of radius 1 adds to the section. */
const CORNER = 1 - Math.PI / 4;

describeNative('BLD M5: variable chamfer and per-joint blend_union radii (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const made = (
    doc: Doc,
    command: string,
    params: Record<string, unknown>,
  ): { doc: Doc; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const faceNames = (doc: Doc, id: string): string[] =>
    (execute(doc, 'inspect_topology', { id }).data as { faces: Array<{ name?: string }> }).faces.map((face) => face.name ?? '');
  const rows: string[] = [];
  afterAll(() => {
    if (process.env['LLULL_BLEND_TABLE'] !== undefined) console.warn(rows.join(String.fromCharCode(10)));
  });
  const block = (s: number): { doc: Doc; id: string } => made(createEmptyDocument(), 'add_box', { size: [20 * s, 10 * s, 5 * s] });

  it.each(SIZES)('VC-BLD-19: chamfer 1 -> 2 on the 20 mm block top edge removes 1/2 integral d^2 (V 976.666667), %d mm', (s) => {
    const { doc, id } = block(s);
    const started = performance.now();
    const done = made(doc, 'chamfer_edge', { id, edgesNear: [[0, 5 * s, 2.5 * s]], distance: 1 * s, distanceEnd: 2 * s });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    const expected = 976.666667 * s ** 3;
    const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
    rows.push(`| variable chamfer | ${s} | ${error.toExponential(2)} | ${millis.toFixed(0)} |`);
    expect(error).toBeLessThan(2e-9);
    expect(faceNames(done.doc, done.id).filter((name) => name.includes('chamfer('))).toHaveLength(1);
    expect(millis).toBeLessThan(5000);
  });

  interface TopologyEdge {
    readonly name?: string;
    readonly start: number[];
    readonly end: number[];
  }
  const edgesOf = (doc: Doc, id: string): TopologyEdge[] =>
    (execute(doc, 'inspect_topology', { id }).data as { edges: TopologyEdge[] }).edges;

  it('distance applies at the START of the edge (as inspect_topology lists it) and distanceEnd at its END: the chamfer width is measured at both ends', () => {
    const { doc, id } = block(1);
    const source = edgesOf(doc, id).find((edge) =>
      [edge.start, edge.end].every((point) => Math.abs((point[1] ?? 0) - 5) < 1e-9 && Math.abs((point[2] ?? 0) - 2.5) < 1e-9),
    );
    expect(source).toBeDefined();
    const done = made(doc, 'chamfer_edge', { id, edgesNear: [[0, 5, 2.5]], distance: 0.5, distanceEnd: 2 });
    expect(done.result.error).toBeUndefined();
    // the contact line of the chamfer on the top face is parallel to the edge, d inside it: its width at an end is 5 - y
    const contact = edgesOf(done.doc, done.id).find((edge) => edge.name?.includes(':z+|chamfer(') === true);
    expect(contact).toBeDefined();
    const at = (x: number): number => {
      const end = [contact?.start ?? [], contact?.end ?? []].find((point) => Math.abs((point[0] ?? Number.NaN) - x) < 1e-9);
      return 5 - (end?.[1] ?? Number.NaN);
    };
    expect(at(source?.start[0] ?? Number.NaN)).toBeCloseTo(0.5, 9);
    expect(at(source?.end[0] ?? Number.NaN)).toBeCloseTo(2, 9);
  });

  it('the distance starts at the edge start: reversing the pair mirrors the chamfer and keeps the volume; recorded by edge name, it replays', () => {
    const { doc, id } = block(1);
    const forward = made(doc, 'chamfer_edge', { id, edgesNear: [[0, 5, 2.5]], distance: 0.5, distanceEnd: 2 });
    const backward = made(doc, 'chamfer_edge', { id, edgesNear: [[0, 5, 2.5]], distance: 2, distanceEnd: 0.5 });
    expect(volume(forward.doc, forward.id)).toBeCloseTo(volume(backward.doc, backward.id), 9);
    expect(JSON.stringify((forward.doc.entities[forward.id] as MeshSolidEntity).brep)).not.toBe(
      JSON.stringify((backward.doc.entities[backward.id] as MeshSolidEntity).brep),
    );
    const step = forward.doc.featureHistory[1];
    expect(step?.params).toHaveProperty('edgeNames');
    const boxStep = forward.doc.featureHistory[0];
    const edited = execute(forward.doc, 'edit_step_params', { stepId: boxStep?.id, params: { size: [30, 10, 5] } });
    expect(edited.rejected).not.toBe(true);
    // 30 mm edge: removed = 1/2 * 30 * (0.25 + 1 + 4) / 3
    expect(volume(edited.document, edited.document.order[0] as string)).toBeCloseTo(1500 - 0.5 * 30 * (5.25 / 3), 6);
    const replayed = execute(forward.doc, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(forward.doc.entities));
  });

  it('a concave edge (the foot of a wall) gains material', () => {
    const floor = block(1);
    const wall = made(floor.doc, 'add_box', { size: [20, 5, 10], position: [0, -2.5, 2.5] });
    const joined = made(wall.doc, 'boolean', { op: 'union', a: floor.id, b: wall.id });
    expect(joined.result.error).toBeUndefined();
    const plain = volume(joined.doc, joined.id);
    const done = made(joined.doc, 'chamfer_edge', { id: joined.id, edgesNear: [[0, 0, 2.5]], distance: 1, distanceEnd: 2 });
    expect(done.result.error).toBeUndefined();
    expect(volume(done.doc, done.id)).toBeCloseTo(plain + 0.5 * 20 * (7 / 3), 6);
  });

  it('refusals carry the reason and leave the document unchanged: a reach past the faces, edges that share a vertex, a closed edge (a full rim), a missing edge list', () => {
    const { doc, id } = block(1);
    const reach = execute(doc, 'chamfer_edge', { id, edgesNear: [[0, 5, 2.5]], distance: 1, distanceEnd: 6 });
    expect(reach.document).toBe(doc);
    expect(reach.error).toMatchObject({ code: 'BLD_CHAMFER_FAILED', paths: ['distanceEnd'] });
    expect(reach.error?.remediation).toContain('use smaller distances');
    expect(reach.error?.remediation).toContain('constant chamfer');
    expect(reach.summary).toContain('reaches past the faces');
    const corner = execute(doc, 'chamfer_edge', {
      id,
      edgesNear: [
        [0, 5, 2.5],
        [10, 0, 2.5],
      ],
      distance: 1,
      distanceEnd: 2,
    });
    expect(corner.error).toMatchObject({ code: 'BLD_CHAMFER_FAILED' });
    expect(corner.error?.remediation).toContain('unlist edges that share a vertex');
    expect(corner.summary).toContain('meet at a vertex');
    const pipe = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10 });
    const rim = execute(pipe.doc, 'chamfer_edge', { id: pipe.id, edgesNear: [[5, 0, 5]], distance: 1, distanceEnd: 2 });
    expect(rim.error).toMatchObject({ code: 'BLD_CHAMFER_FAILED' });
    expect(rim.summary).toContain('closed edge');
    const all = execute(doc, 'chamfer_edge', { id, distance: 1, distanceEnd: 2 });
    expect(all.error).toMatchObject({ code: 'BLD_CHAMFER_VARIABLE_PARAMS', paths: ['edgeIndices'] });
    expect(all.error?.remediation).toContain('distanceEnd > 0 and the edges listed');
  });

  /** A plate 40 x 20 x 4 with a stem 10 x 20 x 18 sunk 2 into it: two straight joints of length 20 on the plate top, at x = 15 and x = 25. */
  const tee = (s: number): { doc: Doc; ids: [string, string] } => {
    const plate = made(createEmptyDocument(), 'add_box', { size: [40 * s, 20 * s, 4 * s], position: [20 * s, 10 * s, 2 * s] });
    const stem = made(plate.doc, 'add_box', { size: [10 * s, 20 * s, 18 * s], position: [20 * s, 10 * s, 11 * s] });
    return { doc: stem.doc, ids: [plate.id, stem.id] };
  };
  const plainUnion = (s: number): number => (40 * 20 * 4 + 10 * 20 * 16) * s ** 3;

  it.each(SIZES)('VC-BLD-32: blend_union joints give each joint its own radius (0.5 and 1.5 beside a default 1), %d mm', (s) => {
    const { doc, ids } = tee(s);
    const started = performance.now();
    const done = made(doc, 'blend_union', {
      ids,
      radius: 1 * s,
      joints: [
        { near: [15 * s, 10 * s, 4 * s], radius: 0.5 * s },
        { near: [25 * s, 10 * s, 4 * s], radius: 1.5 * s },
      ],
    });
    const millis = performance.now() - started;
    expect(done.result.error).toBeUndefined();
    const expected = plainUnion(s) + CORNER * 20 * s ** 3 * (0.25 + 2.25);
    const error = Math.abs(volume(done.doc, done.id) - expected) / expected;
    rows.push(`| blend_union joints | ${s} | ${error.toExponential(2)} | ${millis.toFixed(0)} |`);
    expect(error).toBeLessThan(1e-9);
    // check_blends reads the realised radius of each joint back (VC-BLD-32)
    const checked = execute(done.doc, 'check_blends', { ids: [done.id] }).data as {
      status: string;
      blends: Array<{ kind: string; source?: string; radius?: { min: number; max: number }; contacts: Array<{ g1AngleRad: number }> }>;
    };
    expect(checked.status).toBe('pass');
    const radii = checked.blends
      .filter((row) => row.kind === 'edge')
      .map((row) => row.radius?.min ?? Number.NaN)
      .sort((a, b) => a - b);
    expect(radii).toHaveLength(2);
    // the left joint (0.5) came from joints[0], the right one (1.5) from joints[1]
    const sourceOf = (radius: number): string | undefined =>
      checked.blends.find((row) => row.kind === 'edge' && Math.abs((row.radius?.min ?? Number.NaN) - radius * s) < 1e-6 * s)?.source;
    expect(sourceOf(0.5)).toBe('joints[0]');
    expect(sourceOf(1.5)).toBe('joints[1]');
    expect(Math.abs((radii[0] ?? 0) - 0.5 * s)).toBeLessThan(1e-6 * s);
    expect(Math.abs((radii[1] ?? 0) - 1.5 * s)).toBeLessThan(1e-6 * s);
  });

  it('check_blends passes a blend_union result at every allowed samples (2, 11, 101), straight joints and the circular joint of a boss', () => {
    const { doc, ids } = tee(1);
    const straight = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: 0.5 }] });
    const plate = made(createEmptyDocument(), 'add_box', { size: [40, 40, 5], position: [0, 0, -1.5] });
    const boss = made(plate.doc, 'add_cylinder', { radius: 5, height: 10, position: [0, 0, 5] });
    const round = made(boss.doc, 'blend_union', { ids: [plate.id, boss.id], radius: 1 });
    expect(round.result.error).toBeUndefined();
    for (const samples of [2, 11, 101])
      for (const built of [straight, round]) {
        const checked = execute(built.doc, 'check_blends', { ids: [built.id], samples }).data as { status: string; blends: unknown[] };
        expect(checked.status).toBe('pass');
        expect(checked.blends.length).toBeGreaterThan(0);
      }
  });

  it('joints for solids that share no joint are BLD_JOINT_PARAMS (path joints), the document unchanged; the unpicked joint reads source default', () => {
    const apart = made(made(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }).doc, 'add_box', {
      size: [10, 10, 10],
      position: [100, 0, 0],
    });
    const first = Object.keys(apart.doc.entities)[0] as string;
    const refused = execute(apart.doc, 'blend_union', { ids: [first, apart.id], radius: 1, joints: [{ near: [0, 0, 0], radius: 0.5 }] });
    expect(refused.document).toBe(apart.doc);
    expect(refused.error).toMatchObject({ code: 'BLD_JOINT_PARAMS', paths: ['joints'] });
    expect(refused.error?.remediation).toContain('one radius per tangent chain');
    expect(refused.summary).toContain('share no joint');
    const { doc, ids } = tee(1);
    const one = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: 2 }] });
    const rows = (execute(one.doc, 'check_blends', { ids: [one.id] }).data as { blends: Array<{ kind: string; source?: string }> }).blends;
    expect(
      rows
        .filter((row) => row.kind === 'edge')
        .map((row) => row.source)
        .sort(),
    ).toEqual(['default', 'joints[0]']);
  });

  it('one pick and the default: the unpicked joint keeps the default radius; two radii on one circular joint are refused with the reason', () => {
    const { doc, ids } = tee(1);
    const one = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: 2 }] });
    expect(volume(one.doc, one.id)).toBeCloseTo(plainUnion(1) + CORNER * 20 * (4 + 1), 6);
    const plate = made(createEmptyDocument(), 'add_box', { size: [40, 40, 5], position: [0, 0, -1.5] });
    const boss = made(plate.doc, 'add_cylinder', { radius: 5, height: 10, position: [0, 0, 5] });
    const refused = execute(boss.doc, 'blend_union', {
      ids: [plate.id, boss.id],
      radius: 1,
      joints: [
        { near: [5, 0, 1], radius: 0.5 },
        { near: [-5, 0, 1], radius: 0.8 },
      ],
    });
    expect(refused.document).toBe(boss.doc);
    expect(refused.summary).toContain('one radius per chain');
    expect(refused.error).toMatchObject({ code: 'BLD_JOINT_PARAMS', paths: ['joints[1].radius'] });
    expect(refused.error?.remediation).toContain('one radius per tangent chain');
  });

  it('a pick more than 10 x its radius from every joint is refused with the distance and the bound; one just inside is accepted and its distance reported', () => {
    const { doc, ids } = tee(1);
    // the joint at x = 15 runs along y at z = 4: the pick (15, 10, 4 + h) is h from it, the other joint 10 + h away
    const far = execute(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4.5 + 5.5], radius: 0.5 }] });
    expect(far.document).toBe(doc);
    expect(far.error).toMatchObject({ code: 'BLD_JOINT_PARAMS', paths: ['joints[0].near'] });
    expect(far.error?.remediation).toContain('within 10 x its radius');
    expect(far.summary).toMatch(/is 6\.\d+ from the nearest joint, more than 10 x its radius \(5\.0/);
    const near = made(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4 + 4.9], radius: 0.5 }] });
    expect(near.result.error).toBeUndefined();
    const data = near.result.data as { joints: Array<{ index: number; distanceToJoint: number; radius: number }> };
    expect(data.joints).toHaveLength(1);
    expect(data.joints[0]?.distanceToJoint).toBeCloseTo(4.9, 6);
    expect(data.joints[0]?.radius).toBe(0.5);
    const negative = execute(doc, 'blend_union', { ids, radius: 1, joints: [{ near: [15, 10, 4], radius: -1 }] });
    expect(negative.error).toMatchObject({ code: 'BLD_JOINT_PARAMS', paths: ['joints[0].radius'] });
  });
});
