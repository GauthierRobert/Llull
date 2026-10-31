/** Failure and edge paths of the M5/M6 implicit code: level-set hook, law ranges, curve polylines, staleness, edits, Voronoi limits, 3MF paths. */
import { describe, expect, it } from 'vitest';
import { entityWorldPolyline } from '@core/geometry/entityPolyline';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { CadDocument } from '@core/model/types';
import { lawRange } from '@implicit/lawRange';
import { levelSetOf } from '@implicit/levelSet';
import { implicitPlugin } from '@implicit/plugin';
import { isStale } from '@implicit/rederive';
import { addVoronoiLattice } from '@implicit/voronoiCommand';
import { voronoiGeometry } from '@implicit/voronoi';
import { empty, expectRefused, ok, run } from './helpers';

const withoutField = (doc: CadDocument, id: string): CadDocument => {
  const model = doc.implicit;
  if (model === undefined) throw new Error('no implicit slice');
  const { [id]: removed, ...fields } = model.fields;
  void removed;
  return { ...doc, implicit: { ...model, fields } };
};

describe('levelSetOf and the plugin hooks', () => {
  it('answers null for a non-body, a reason for a body whose field is gone, and null step skip for a non-body', () => {
    const box = ok(empty(), 'add_box', { size: [2, 2, 2] });
    expect(levelSetOf(box.doc, box.id)).toBeNull();
    expect(implicitPlugin.stepSkip?.(box.doc, box.id)).toBeNull();
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    expect(typeof levelSetOf(withoutField(body.doc, sphere.id), body.id)).toBe('string');
    expect(implicitPlugin.stepSkip?.(body.doc, body.id)).toContain('IMP_STEP_NOT_EXACT');
  });

  it('export_3mf implicit levelset keeps a body whose field is gone as a mesh with the reason, and refuses solids in a non-millimetre document', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const broken = ok(withoutField(body.doc, sphere.id), 'export_3mf', { entityIds: [body.id], implicit: 'levelset' });
    expect((broken.data['implicit'] as { skipped: unknown[] }).skipped).toHaveLength(1);
    const box = ok(empty(), 'add_box', { size: [4, 4, 4] });
    const solid = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const made = ok(solid.doc, 'create_implicit_body', { field: solid.id, voxel: 0.5 });
    const inches = ok({ ...made.doc, units: 'in' }, 'export_3mf', { entityIds: [made.id], implicit: 'levelset' });
    expect((inches.data['implicit'] as { skipped: Array<{ reason: string }> }).skipped[0]?.reason).toContain('millimetre');
    const plain = ok(box.doc, 'export_3mf', { entityIds: [box.id], implicit: 'levelset' });
    expect(plain.data['implicit']).toEqual({ written: [], skipped: [] });
  });
});

describe('lawRange', () => {
  it('returns the number, null without a box or with an unknown scalar, and the sampled range of a ramp', () => {
    const z = ok(empty(), 'create_scalar_field', { kind: 'coordinate', axis: 'z' });
    const box = { min: [0, 0, 0], max: [10, 10, 10] } as const;
    expect(lawRange(tsFieldEngine, z.doc, 3, null)).toEqual({ min: 3, max: 3, constant: true });
    expect(lawRange(tsFieldEngine, z.doc, z.id, null)).toBeNull();
    expect(lawRange(tsFieldEngine, z.doc, 'missing', box)).toBeNull();
    const range = lawRange(tsFieldEngine, z.doc, z.id, box);
    expect(range?.constant).toBe(false);
    expect(range?.min).toBeLessThan(0.5);
    expect(range?.max).toBeGreaterThan(9.5);
    const refusing = { ...tsFieldEngine, measure: () => ({ ok: false as const, code: 'IMP_ENGINE_FAILED' as const, message: 'x' }) };
    expect(lawRange(refusing, z.doc, z.id, box)).toBeNull();
  });
});

describe('a law that points at the wrong kind of node or a node that vanished', () => {
  it('is refused with the code of the problem', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const notScalar = run(sphere.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: sphere.id, cellSize: 4 });
    expectRefused(sphere.doc, notScalar, 'IMP_PARAM_RANGE');
    const z = ok(empty(), 'create_scalar_field', { kind: 'coordinate', axis: 'z' });
    const ramp = ok(z.doc, 'create_scalar_field', { kind: 'ramp', input: z.id, inMin: 0, inMax: 10, outMin: 0.2, outMax: 0.8 });
    const orphan = withoutField(ramp.doc, z.id);
    const refused = run(orphan, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: ramp.id, cellSize: 4 });
    expect(refused.result.error).toBeDefined();
    expect(refused.doc).toBe(orphan);
  });
});

describe('isStale and regenerate_implicit_bodies', () => {
  it('is stale when the field is gone, the field is unbounded, or the entity is missing, and fresh otherwise', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const record = body.doc.implicit?.bodies[body.id];
    if (record === undefined) throw new Error('body expected');
    expect(isStale(body.doc, record, undefined)).toBe(false);
    expect(isStale(withoutField(body.doc, sphere.id), record, undefined)).toBe(true);
    const { [body.id]: dropped, ...entities } = body.doc.entities;
    void dropped;
    expect(isStale({ ...body.doc, entities }, record, undefined)).toBe(true);
    const plane = ok(empty(), 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    expect(isStale(plane.doc, { ...record, field: plane.id }, undefined)).toBe(true);
    expect(isStale(body.doc, { ...record, explicitBounds: true, bounds: { min: [-1, -1, -1], max: [1, 1, 1] } }, undefined)).toBe(true);
  });

  it('re-derives a stale body after a field edit that bypassed edit_field and reports a body that cannot be realised', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const model = body.doc.implicit;
    if (model === undefined) throw new Error('slice expected');
    const node = model.fields[sphere.id];
    if (node?.op !== 'primitive') throw new Error('primitive expected');
    const grown: CadDocument = {
      ...body.doc,
      implicit: { ...model, fields: { ...model.fields, [sphere.id]: { ...node, dims: { radius: 3 } } } },
    };
    const again = ok(grown, 'regenerate_implicit_bodies', {});
    expect(again.data['rederived']).toEqual([body.id]);
    const missing = run(withoutField(body.doc, sphere.id), 'regenerate_implicit_bodies', { ids: [body.id] });
    expect(missing.result.error).toBeDefined();
    expect(missing.result.affected).toEqual([]);
  });
});

describe('edit_field on a TPMS lattice and a refused edit', () => {
  it('switching to relativeDensity drops the thickness, switching back drops the density, and a refused creator is relayed', () => {
    const gyroid = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.5, cellSize: 5 });
    const dense = ok(gyroid.doc, 'edit_field', { id: gyroid.id, changes: { relativeDensity: 0.3 } });
    expect(dense.doc.implicit?.fields[gyroid.id]).toMatchObject({ relativeDensityTarget: 0.3 });
    const back = ok(dense.doc, 'edit_field', { id: gyroid.id, changes: { thickness: 0.4 } });
    const node = back.doc.implicit?.fields[gyroid.id] as { control: unknown; relativeDensityTarget?: number };
    expect(node.control).toMatchObject({ kind: 'thickness', value: 0.4 });
    expect(node.relativeDensityTarget).toBeUndefined();
    const bad = run(gyroid.doc, 'edit_field', { id: gyroid.id, changes: { cellSize: -1 } });
    expect(bad.result.error).toBeDefined();
    expect(bad.doc).toBe(gyroid.doc);
  });
});

describe('infill_solid failure inside a composed step', () => {
  it('relays the refusal of a composed command and leaves the document untouched', () => {
    const box = ok(empty(), 'add_box', { size: [20, 20, 20] });
    const tooThick = run(box.doc, 'infill_solid', {
      entityId: box.id,
      wall: 0,
      voxel: 1,
      lattice: { type: 'tpms', kind: 'gyroid', form: 'sheet', thickness: 0.5, cellSize: 5 },
    });
    expect(tooThick.result.error).toBeDefined();
    expect(tooThick.doc).toBe(box.doc);
    const badOpen = run(box.doc, 'infill_solid', {
      entityId: box.id,
      wall: 1,
      voxel: 0.8,
      lattice: { type: 'tpms', kind: 'gyroid', form: 'sheet', thickness: 0.5, cellSize: 5 },
      openBy: 'missing',
    });
    expect(badOpen.result.error).toBeDefined();
    const badDrain = run(box.doc, 'infill_solid', {
      entityId: box.id,
      wall: 1,
      voxel: 0.8,
      lattice: { type: 'struts', cell: 'cubic', cellSize: 5, radius: 0.4 },
      drainHoles: { diameter: 0, count: 1 },
    });
    expect(badDrain.result.error).toBeDefined();
  });
});

describe('Voronoi limits', () => {
  it('builds the 20 mm cube at 0.04 seeds/mm3 that the 5000 beam cap used to refuse, builds the 60 mm cube (12000 seeds, 300000 beams: refused until 14.16) and refuses a box above 100000 seeds by name', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const dense = ok(box.doc, 'add_voronoi_lattice', { region: box.id, density: 0.04, seed: 1, radius: 0.1 });
    expect(dense.data['beams'] as number).toBeGreaterThan(4000);
    const large = ok(empty(), 'add_field_primitive', { shape: 'box', size: [60, 60, 60], position: [30, 30, 30] });
    const built = ok(large.doc, 'add_voronoi_lattice', { region: large.id, density: 0.04, seed: 1, radius: 0.1 });
    expect(built.data['beams'] as number).toBeGreaterThan(100_000);
    const huge = ok(empty(), 'add_field_primitive', { shape: 'box', size: [150, 150, 150], position: [75, 75, 75] });
    const refused = run(huge.doc, 'add_voronoi_lattice', { region: huge.id, density: 0.04, seed: 1, radius: 0.1 });
    expectRefused(huge.doc, refused, 'IMP_GRAPH_TOO_LARGE');
    expect(refused.result.summary).toContain('limit 100000');
  });

  it('keeps the command object and a deterministic geometry for equal inputs', () => {
    expect(addVoronoiLattice.name).toBe('add_voronoi_lattice');
    const node = { min: [0, 0, 0], max: [10, 10, 10], density: 0.03, seed: 4, radius: 0.3, cap: 'butt' } as const;
    expect(JSON.stringify(voronoiGeometry(node))).toBe(JSON.stringify(voronoiGeometry(node)));
  });
});

describe('entityWorldPolyline', () => {
  it('chains arcs, ellipses, rectangles, splines and NURBS curves and refuses what is not a curve or a bad chord', () => {
    let doc = empty();
    const ids: string[] = [];
    const add = (name: string, params: Record<string, unknown>): void => {
      const step = ok(doc, name, params);
      doc = step.doc;
      ids.push(step.id);
    };
    add('draw_arc', { center: [0, 0], radius: 3 });
    add('draw_ellipse', { center: [0, 0], radiusX: 4, radiusY: 2 });
    add('draw_rectangle', { width: 4, height: 2 });
    add('draw_spline', {
      points: [
        [0, 0],
        [2, 3],
        [5, 1],
        [8, 4],
      ],
    });
    add('create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [4, 0, 0],
      ],
    });
    for (const id of ids) {
      const chain = entityWorldPolyline(doc.entities[id] as never, 0.5);
      expect(Array.isArray(chain), id).toBe(true);
      expect((chain as unknown[]).length).toBeGreaterThan(2);
    }
    const nurbs = entityWorldPolyline(doc.entities[ids[4] as string] as never, 1);
    expect(Array.isArray(nurbs) ? nurbs.length : 0).toBeGreaterThanOrEqual(5);
    expect(entityWorldPolyline(doc.entities[ids[0] as string] as never, 0)).toContain('chord');
    const box = ok(doc, 'add_box', { size: [1, 1, 1] });
    expect(entityWorldPolyline(box.doc.entities[box.id] as never, 1)).toContain('not a curve');
  });
});

describe('beam lattice size cap, explicit bounds and selection on delete', () => {
  it('keeps a lattice with more than 200000 beams as a mesh and says why', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const lattice = ok(box.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5, region: box.id });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5 });
    const model = body.doc.implicit;
    const node = model?.fields[lattice.id];
    if (model === undefined || node?.op !== 'struts') throw new Error('struts node expected');
    const tiny: CadDocument = {
      ...body.doc,
      implicit: { ...model, fields: { ...model.fields, [lattice.id]: { ...node, cellSize: [0.01, 0.01, 0.01] } } },
    };
    const out = ok(tiny, 'export_3mf', { entityIds: [body.id], beamLattice: true });
    expect((out.data['beamLattice'] as { skipped: Array<{ reason: string }> }).skipped[0]?.reason).toContain('beam-lattice limit');
  });

  it('re-derives a body made with explicit bounds, and recreates a mesh whose entity is gone', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5, bounds: { min: [-3, -3, -3], max: [3, 3, 3] } });
    const edited = ok(body.doc, 'edit_field', { id: sphere.id, changes: { radius: 2.5 } });
    expect(edited.doc.implicit?.bodies[body.id]?.explicitBounds).toBe(true);
    const { [body.id]: dropped, ...entities } = edited.doc.entities;
    void dropped;
    const gone: CadDocument = { ...edited.doc, entities, order: edited.doc.order.filter((id) => id !== body.id) };
    const back = ok(gone, 'regenerate_implicit_bodies', {});
    expect(back.data['rederived']).toEqual([body.id]);
    expect(back.doc.entities[body.id]?.kind).toBe('mesh');
    expect(back.doc.order).toContain(body.id);
  });

  it('removes a selected body when its field is deleted with cascade', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const selected: CadDocument = { ...body.doc, selection: [body.id] };
    const gone = ok(selected, 'delete_field', { id: sphere.id, cascade: true });
    expect(gone.doc.selection).toEqual([]);
    expect(gone.doc.entities[body.id]).toBeUndefined();
  });
});

describe('edit_field edges', () => {
  it('clears an optional value set to null, refuses an unknown key on a non-primitive, and relays a body that can no longer be realised', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [4, 4, 4], rounding: 0.5 });
    const plain = ok(box.doc, 'edit_field', { id: box.id, changes: { rounding: null } });
    expect((plain.doc.implicit?.fields[box.id] as { rounding?: number }).rounding).toBeUndefined();
    const solid = ok(empty(), 'add_box', { size: [2, 2, 2] });
    const fromSolid = ok(solid.doc, 'field_from_solid', { entityId: solid.id });
    const unknown = run(fromSolid.doc, 'edit_field', { id: fromSolid.id, changes: { radius: 1 } });
    expectRefused(fromSolid.doc, unknown, 'IMP_PARAM_RANGE');
    expect(unknown.result.summary).toContain('solid node');
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const huge = run(body.doc, 'edit_field', { id: sphere.id, changes: { radius: 1e6 } });
    expectRefused(body.doc, huge, 'IMP_GRID_BUDGET');
  });

  it('switches a network from a level to a relative density and back', () => {
    const net = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0.1, cellSize: 5 });
    const dense = ok(net.doc, 'edit_field', { id: net.id, changes: { relativeDensity: 0.4 } });
    expect(dense.doc.implicit?.fields[net.id]).toMatchObject({ relativeDensityTarget: 0.4 });
    const level = ok(dense.doc, 'edit_field', { id: net.id, changes: { level: 0.2 } });
    expect(level.doc.implicit?.fields[net.id]).toMatchObject({ control: { kind: 'level', value: 0.2 } });
  });
});
