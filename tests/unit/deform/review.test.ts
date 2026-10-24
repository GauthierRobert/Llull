import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { WORLD_Z, addBox, installKernel, meshEntity } from './harness';

afterEach(() => setGeometryKernel(null));

describe('a deformation whose map is regular but whose result crosses itself is refused (flow, field, surface laws)', () => {
  const frame = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] };
  /** A circle of radius 8 followed for `degrees`, as an interpolated cubic. */
  function loop(degrees: number): { doc: CadDocument; id: string } {
    const points = Array.from({ length: 25 }, (_, k) => {
      const angle = (((degrees * k) / 24) * Math.PI) / 180;
      return [8 * Math.sin(angle), 8 - 8 * Math.cos(angle), 0];
    });
    const made = execute(createEmptyDocument(), 'interpolate_curve', { points, degree: 3 });
    return { doc: made.document, id: made.affected[0] as string };
  }

  it.each(['none', 'warp'] as const)('flow_along_curve along a path that winds past a full turn over the bar (kernel %s)', async (kind) => {
    await installKernel(kind);
    const path = loop(420);
    const bar = execute(path.doc, 'add_box', { size: [10, 10, 55], anchor: 'base-center' });
    const params = { id: bar.affected[0], targetId: path.id, frame, output: { tolerance: 0.1 } };
    const crossing = execute(bar.document, 'flow_along_curve', params);
    expectNoOp(crossing, bar.document, 'cross itself');
    expect(crossing.error?.code).toBe('DEF_SELF_INTERSECTION');
    const open = loop(200);
    const fine = execute(open.doc, 'add_box', { size: [10, 10, 25], anchor: 'base-center' });
    const accepted = execute(fine.document, 'flow_along_curve', {
      id: fine.affected[0],
      targetId: open.id,
      frame,
      output: { tolerance: 0.1 },
    });
    expect(accepted.error, accepted.summary).toBeUndefined();
  });

  it('deform_by_point, flow_along_curve and a sheet target do not touch their input document', async () => {
    await installKernel('none');
    const box = addBox([100, 100, 50], 'base-center');
    expectPure(box.doc, () =>
      execute(box.doc, 'deform_by_point', {
        id: box.id,
        point: [0, 0, 50],
        direction: [0, 0, 1],
        distance: 2,
        radius: 10,
        falloff: 'smooth_c2',
        output: { tolerance: 0.05 },
      }),
    );
    const path = loop(90);
    const bar = execute(path.doc, 'add_box', { size: [4, 4, 12], anchor: 'base-center' });
    expectPure(bar.document, () => execute(bar.document, 'flow_along_curve', { id: bar.affected[0], targetId: path.id, frame }));
    const sheet = execute(createEmptyDocument(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [4, 0, 0],
        ],
        [
          [0, 0, 20],
          [4, 0, 20],
        ],
      ],
    });
    const sheetId = sheet.affected[0] as string;
    const twist = {
      id: sheetId,
      angleDeg: 45,
      frame: WORLD_Z,
      region: { start: 0, end: 20, falloff: 'linear' },
      output: { tolerance: 0.01 },
    };
    expectPure(sheet.document, () => execute(sheet.document, 'twist_body', twist));
    const twisted = execute(sheet.document, 'twist_body', twist);
    expect(twisted.error, twisted.summary).toBeUndefined();
    expect(twisted.document.entities[sheetId]?.kind).toBe('nurbs_surface');
  });

  it('several bodies with keepSource leave the inputs and every original in place', async () => {
    await installKernel('none');
    const first = addBox([10, 10, 100]);
    const second = execute(first.doc, 'add_box', { size: [8, 8, 60], anchor: 'base-center', position: [50, 0, 0] });
    const ids = [first.id, second.affected[0] as string];
    const params = { ids, angleDeg: 45, frame: WORLD_Z, keepSource: true, output: { tolerance: 0.05 } };
    expectPure(second.document, () => execute(second.document, 'twist_body', params));
    const result = execute(second.document, 'twist_body', params);
    expect(result.error, result.summary).toBeUndefined();
    expect(result.document.order).toHaveLength(4);
    for (const id of ids) expect(result.document.entities[id]).toBe(second.document.entities[id]);
  });
});

describe('morph_bodies on meshes works in world coordinates', () => {
  it('a translated and a rotated mesh morph through their placed vertices, and the result sits at the origin', async () => {
    await installKernel('none');
    const a = addBox([10, 10, 10], 'center');
    const b = execute(a.doc, 'add_box', { size: [10, 10, 10], anchor: 'center', position: [100, 0, 0] });
    const named = execute(b.document, 'twist_body', { id: a.id, angleDeg: 0.001, frame: WORLD_Z, output: { tolerance: 0.5 } });
    expect(named.error, named.summary).toBeUndefined();
    // two meshes with equal connectivity: the twisted copy of the box, and the same mesh translated by 100 along x, then rotated
    const base = meshEntity(named.document, named.affected[0] as string);
    const moved = { ...base, id: 'm2', position: [100, 0, 0], rotation: [0, 0, Math.PI / 2] } as typeof base;
    const doc: CadDocument = {
      ...named.document,
      entities: { ...named.document.entities, m2: moved },
      order: [...named.document.order, 'm2'],
    };
    const half = execute(doc, 'morph_bodies', { fromId: base.id, toId: 'm2', t: 0.5 });
    expect(half.error, half.summary).toBeUndefined();
    const mid = meshEntity(half.document, half.affected[0] as string);
    expect(mid.position).toEqual([0, 0, 0]);
    expect(mid.rotation).toEqual([0, 0, 0]);
    const end = execute(doc, 'morph_bodies', { fromId: base.id, toId: 'm2', t: 1 });
    const last = meshEntity(end.document, end.affected[0] as string);
    // vertex 0 of the target: rotate (x, y) by 90 degrees about z, then translate by 100 along x
    const [x, y, z] = [base.mesh.positions[0] as number, base.mesh.positions[1] as number, base.mesh.positions[2] as number];
    expect(last.mesh.positions[0]).toBeCloseTo(100 - y, 9);
    expect(last.mesh.positions[1]).toBeCloseTo(x, 9);
    expect(last.mesh.positions[2]).toBeCloseTo(z, 9);
    expectPure(doc, () => execute(doc, 'morph_bodies', { fromId: base.id, toId: 'm2', t: 0.5 }));
  });
});
