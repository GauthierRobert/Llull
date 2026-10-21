/**
 * AERO-5 exact sheets and ply slabs on the native `llull-kernel` (02 SRF §13.9, 06 CMP §13.5):
 * - a `nurbs_surface` leaf (capability `nurbsSurface`) is one exact B-spline face, trimmed by its (u, v) loops: OCC area against the closed forms;
 * - `export_step_ap242` writes sheets as B-spline faces; the file re-imports with the right face count, and six sheets of a box sew back into a
 *   solid of the box volume (VC-SRF-16 shape);
 * - `create_ply_solids` attaches a `faceSlab` recipe on plane / cylinder / cone / NURBS tool faces: the exact solid has volume = area x thickness
 *   (plus the curvature term of the offset), matches the triangle solid, and exports to STEP under the ply name.
 * Skipped without the llull-kernel binary.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel, type GeometryKernel, type ShapeHandle } from '@core/geometry/kernel';
import type { ExactMassProperties, ImportShapesOptions, ImportedShapes } from '@core/geometry/kernelPorts';
import {
  createEmptyDocument,
  type CadDocument,
  type MeshSolidEntity,
  type NurbsSurfaceEntity,
  type ShapeRecipe,
  type Vec2,
} from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { meshVolume } from '@aero/composites/plySolid';
import { apply, data, ok } from '../../tests/helpers/commandAssertions';
import { WOVEN, spherePatch } from '../../tests/unit/aero/composites/drapeFixtures';
import { AS4, ROSETTE, withMaterials } from '../../tests/unit/aero/composites/fixtures';
import { cylinderSurface } from '../../tests/helpers/revolvedSurfaces';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';

const IMPORT: ImportShapesOptions = { precision: 0.01, maxTolerance: 1, heal: true, sew: true };
let kernel: IsolatedKernel;

const mass = (shape: ShapeHandle | null): ExactMassProperties => {
  const result = shape === null ? null : (kernel.massProperties?.(shape) ?? null);
  if (result === null) throw new Error('no mass properties');
  return result;
};
/** Area of a sheet (a face has no mass properties: `massProperties` needs a solid, `analyze` reports the area). */
const areaOf = (entity: NurbsSurfaceEntity): number => {
  const shape = kernel.evaluate({ op: 'solid', entity });
  const area = shape === null ? null : (kernel.analyze?.(shape)?.area ?? null);
  if (area === null) throw new Error('the kernel could not build the sheet');
  return area;
};
const meshArea = (positions: readonly number[], indices: readonly number[]): number => {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const at = (k: number): number[] => [0, 1, 2].map((axis) => positions[3 * (indices[t + k] as number) + axis] as number);
    const [a, b, c] = [at(0), at(1), at(2)] as [number[], number[], number[]];
    const [ux, uy, uz, vx, vy, vz] = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!, c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return sum;
};
const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);
const count = (text: string, name: string): number => text.match(new RegExp(`[=\\s]${name}\\(`, 'g'))?.length ?? 0;

const addSheet = (doc: CadDocument, surface: NurbsSurfaceData | Record<string, unknown>): { doc: CadDocument; id: string } => {
  const result = ok(doc, 'create_nurbs_surface', { ...surface });
  return { doc: result.document, id: result.affected[0] as string };
};

/** Bilinear planar patch over the corners (u runs p00 -> p10, v p00 -> p01). */
const quad = (p00: number[], p01: number[], p10: number[], p11: number[]): Record<string, unknown> => ({
  degreeU: 1,
  degreeV: 1,
  poles: [
    [p00, p01],
    [p10, p11],
  ],
});

const step = (doc: CadDocument, ids: string[]): { text: string; result: ReturnType<typeof data<Record<string, unknown>>> } => {
  const result = data<Record<string, unknown>>(doc, 'export_step_ap242', {
    entityIds: ids,
    schema: 'ap214',
    includeValidationProperties: false,
  });
  return { text: String(result['step']), result };
};

const solidOf = (text: string): ImportedShapes => {
  const imported = kernel.importShapes?.('step', text, IMPORT);
  if (imported === null || imported === undefined || 'error' in imported) throw new Error(`import failed: ${JSON.stringify(imported)}`);
  return imported;
};

/** Exact volume of every solid a STEP text holds. */
function importedVolumes(text: string): number[] {
  return solidOf(text).solids.map((solid) => {
    const blob = sha256Hex(solid.brep);
    kernel.loadBlob?.(blob, solid.brep);
    return mass(kernel.evaluate({ op: 'brep', blob, format: 'occt-brep-v1' })).volume;
  });
}

describeNative('exact sheets and ply slabs on the native kernel', () => {
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel as GeometryKernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  it('reports the capabilities', () => {
    expect(kernel.info?.().capabilities).toEqual(expect.arrayContaining(['nurbsSurface', 'faceSlab']));
  });

  it('builds a sheet as one exact B-spline face: a rational cylinder and a circle-trimmed plane (VC-SRF-23)', () => {
    const tube = addSheet(createEmptyDocument(), { ...cylinderSurface(10, 5) });
    const sheet = tube.doc.entities[tube.id] as NurbsSurfaceEntity;
    const area = areaOf(sheet);
    // OCC's default Gauss rule does not split a face at its knot spans: the 4-span rational cylinder integrates 1.75e-3 high (measured 314.709); the
    // display triangles of the same face give the exact area
    expect(rel(area, 2 * Math.PI * 10 * 5), `cylinder sheet area ${area}`).toBeLessThan(2e-3);
    const mesh = kernel.tessellate(kernel.evaluate({ op: 'solid', entity: sheet }) as ShapeHandle);
    expect(rel(meshArea(mesh?.positions ?? [], mesh?.indices ?? []), 2 * Math.PI * 10 * 5)).toBeLessThan(2e-3);
    const placed = { ...sheet, position: [3, 0, 2] } as NurbsSurfaceEntity;
    const lifted = kernel.tessellate(kernel.evaluate({ op: 'solid', entity: placed }) as ShapeHandle);
    expect(Math.min(...(lifted?.positions.filter((_, k) => k % 3 === 2) ?? [Number.NaN]))).toBeCloseTo(2, 6);

    const flat = addSheet(createEmptyDocument(), quad([0, 0, 0], [0, 10, 0], [10, 0, 0], [10, 10, 0]));
    const circle = ok(flat.doc, 'create_nurbs_curve', {
      degree: 2,
      poles: [
        [8, 5, 0],
        [8, 8, 0],
        [5, 8, 0],
        [2, 8, 0],
        [2, 5, 0],
        [2, 2, 0],
        [5, 2, 0],
        [8, 2, 0],
        [8, 5, 0],
      ],
      weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
      knots: [0, 0.25, 0.5, 0.75, 1],
      multiplicities: [3, 2, 2, 2, 3],
    });
    const inside = ok(circle.document, 'trim_surface', { id: flat.id, curveIds: [circle.affected[0]], keep: 'inside' });
    const outside = ok(circle.document, 'trim_surface', { id: flat.id, curveIds: [circle.affected[0]], keep: 'outside' });
    const insideArea = areaOf(inside.document.entities[flat.id] as NurbsSurfaceEntity);
    const outsideArea = areaOf(outside.document.entities[flat.id] as NurbsSurfaceEntity);
    expect(rel(insideArea, 9 * Math.PI), `trimmed area ${insideArea}`).toBeLessThan(1e-4);
    expect(rel(outsideArea, 100 - 9 * Math.PI), `holed area ${outsideArea}`).toBeLessThan(1e-4);
  });

  it('writes sheets to STEP as B-spline faces that re-import, skips a sheet the kernel cannot build', () => {
    const flat = addSheet(createEmptyDocument(), quad([0, 0, 0], [0, 10, 0], [10, 0, 0], [10, 10, 0]));
    const tube = addSheet(flat.doc, { ...cylinderSurface(10, 5) });
    const named = apply(tube.doc, 'set_entity_name', { id: flat.id, name: 'Skin sheet' });
    const { text, result } = step(named, [flat.id, tube.id]);
    expect(result['sheetCount']).toBe(2);
    expect(result['entityIds']).toEqual([flat.id, tube.id]);
    expect(result['skipped']).toEqual([]);
    expect(count(text, 'ADVANCED_FACE')).toBe(2);
    expect(text).toContain('B_SPLINE_SURFACE_WITH_KNOTS');
    expect(text).toContain('Skin sheet');
    const imported = kernel.importShapes?.('step', text, IMPORT);
    expect(imported, 'sheets are not solids: the import reports its census').toMatchObject({
      error: 'no_solid',
      detail: expect.stringContaining('2 faces'),
    });
    const everything = data<Record<string, unknown>>(named, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false });
    expect(everything['sheetCount'], 'a whole-document export includes the sheets').toBe(2);
  });

  it('sews six sheets of a box back into a solid of the box volume (VC-SRF-16)', () => {
    const [a, b, c] = [4, 3, 2];
    const p = (x: number, y: number, z: number): number[] => [x, y, z];
    let doc = createEmptyDocument();
    const ids: string[] = [];
    for (const faceParams of [
      quad(p(0, 0, 0), p(0, b, 0), p(a, 0, 0), p(a, b, 0)),
      quad(p(0, 0, c), p(0, b, c), p(a, 0, c), p(a, b, c)),
      quad(p(0, 0, 0), p(0, 0, c), p(a, 0, 0), p(a, 0, c)),
      quad(p(0, b, 0), p(0, b, c), p(a, b, 0), p(a, b, c)),
      quad(p(0, 0, 0), p(0, 0, c), p(0, b, 0), p(0, b, c)),
      quad(p(a, 0, 0), p(a, 0, c), p(a, b, 0), p(a, b, c)),
    ]) {
      const added = addSheet(doc, faceParams);
      doc = added.doc;
      ids.push(added.id);
    }
    const { text } = step(doc, ids);
    expect(count(text, 'ADVANCED_FACE')).toBe(6);
    const solids = solidOf(text).solids;
    expect(solids).toHaveLength(1);
    expect(solids[0]?.faces).toBe(6);
    const sewn = ok(doc, 'sew_surfaces', { ids, makeSolid: true });
    const meshVolumeValue = (sewn.data as { volume: number }).volume;
    const [volume] = importedVolumes(text);
    expect(rel(volume as number, a * b * c), `sewn B-rep volume ${volume}`).toBeLessThan(1e-9);
    expect(rel(meshVolumeValue, a * b * c)).toBeLessThan(0.02);
  });

  /** Part on a tool face, one whole-face or polygon ply of the woven material, then the ply solids. */
  const slabs = (
    doc: CadDocument,
    part: string,
    boundary: Record<string, unknown>,
  ): { doc: CadDocument; solids: MeshSolidEntity[]; ids: string[]; thickness: number } => {
    const withPly = apply(doc, 'add_ply', { part, name: 'C1', material: WOVEN.name, orientation: 0, boundary });
    const result = ok(withPly, 'create_ply_solids', { part, maxEdge: 4 });
    return {
      doc: result.document,
      ids: result.affected,
      solids: result.affected.map((id) => result.document.entities[id] as MeshSolidEntity),
      thickness: WOVEN.plyThickness,
    };
  };

  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  /** The exact solid against the triangle solid: same bounding box (within 2 % of its size) and centroid (within 1 % of its size). */
  const sameGeometry = (solid: MeshSolidEntity, shape: ShapeHandle): void => {
    const exactMesh = kernel.tessellate(shape);
    expect(exactMesh, `${solid.name} tessellates`).not.toBeNull();
    const box = (positions: readonly number[]): { min: number[]; max: number[] } => {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < positions.length; k++) {
        min[k % 3] = Math.min(min[k % 3] as number, positions[k] as number);
        max[k % 3] = Math.max(max[k % 3] as number, positions[k] as number);
      }
      return { min, max };
    };
    const [a, b] = [box(exactMesh?.positions ?? []), box(solid.mesh.positions)];
    const size = Math.max(...b.max.map((value, k) => value - (b.min[k] as number)));
    for (let k = 0; k < 3; k++) {
      expect(Math.abs((a.min[k] as number) - (b.min[k] as number)), `${solid.name} min ${k}`).toBeLessThan(0.02 * size);
      expect(Math.abs((a.max[k] as number) - (b.max[k] as number)), `${solid.name} max ${k}`).toBeLessThan(0.02 * size);
    }
    const centroid = mass(shape).centroid;
    const middle = b.max.map((value, k) => (value + (b.min[k] as number)) / 2);
    // the triangle solid's own centroid by tetrahedra from the origin
    let weighted = [0, 0, 0];
    let volume = 0;
    const { positions, indices } = solid.mesh;
    for (let t = 0; t < indices.length; t += 3) {
      const p = [0, 1, 2].map((k) => [0, 1, 2].map((axis) => positions[3 * (indices[t + k] as number) + axis] as number));
      const [p0, p1, p2] = p as [number[], number[], number[]];
      const v =
        (p0[0]! * (p1[1]! * p2[2]! - p1[2]! * p2[1]!) -
          p0[1]! * (p1[0]! * p2[2]! - p1[2]! * p2[0]!) +
          p0[2]! * (p1[0]! * p2[1]! - p1[1]! * p2[0]!)) /
        6;
      volume += v;
      weighted = weighted.map((w, axis) => w + (v * (p0[axis]! + p1[axis]! + p2[axis]!)) / 4);
    }
    for (let k = 0; k < 3; k++)
      expect(
        Math.abs((centroid[k] as number) - (weighted[k] as number) / volume),
        `${solid.name} centroid ${k} (box middle ${middle[k]})`,
      ).toBeLessThan(0.01 * size);
  };

  /** The exact solids of `slab` against its triangle solids and `expectedVolume`, and the STEP file under the ply names. */
  const check = (slab: ReturnType<typeof slabs>, expectedVolume: number, tolerance: number, meshTolerance: number): void => {
    expect(slab.solids.length).toBeGreaterThan(0);
    let exact = 0;
    for (const solid of slab.solids) {
      expect(solid.stepSlab?.op, `${solid.name} carries its exact recipe`).toBe('faceSlab');
      const shape = kernel.evaluate(solid.stepSlab as ShapeRecipe);
      expect(shape, `${solid.name} builds`).not.toBeNull();
      const volume = mass(shape).volume;
      expect(rel(volume, meshVolume(solid.mesh)), `${solid.name} exact ${volume} vs mesh`).toBeLessThan(meshTolerance);
      exact += volume;
      sameGeometry(solid, shape as ShapeHandle);
      expect(kernel.analyze?.(shape as ShapeHandle)?.valid, `${solid.name} valid`).toBe(true);
    }
    expect(rel(exact, expectedVolume), `exact volume ${exact} vs ${expectedVolume}`).toBeLessThan(tolerance);
    const { text } = step(slab.doc, slab.ids);
    expect(count(text, 'MANIFOLD_SOLID_BREP')).toBe(slab.solids.length);
    for (const solid of slab.solids) expect(text).toContain(solid.name as string);
    expect(importedVolumes(text).reduce((sum, volume) => sum + volume, 0)).toBeCloseTo(exact, 4);
  };

  it('lifts a polygon ply of a flat panel into an exact solid: volume = area x thickness', () => {
    let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
    const tool = ok(doc, 'add_box', { size: [200, 100, 10], anchor: 'min', position: [0, 0, -10] });
    doc = apply(tool.document, 'define_rosette', ROSETTE);
    const part = ok(doc, 'create_composite_part', {
      name: 'Panel',
      toolSurface: { entityId: tool.affected[0], faceNear: [100, 50, 0] },
      rosette: 'R0',
    });
    const slab = slabs(part.document, part.affected[0] as string, { kind: 'polygon', polygons: [rect(20, 10, 180, 90)] });
    check(slab, 160 * 80 * WOVEN.plyThickness, 1e-9, 1e-9);
  });

  it('lifts a ply of a cylinder (full turn: the seam) and a partial one; the curvature term t / 2R is exact', () => {
    let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
    doc = apply(doc, 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    doc = apply(doc, 'create_lamina_material', AS4);
    const tool = ok(doc, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
    const part = ok(tool.document, 'create_composite_part', {
      name: 'Skin',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 0] },
    });
    const radius = 50;
    const t = WOVEN.plyThickness;
    const area = 2 * Math.PI * radius * 200;
    check(slabs(part.document, part.affected[0] as string, { kind: 'whole_face' }), area * t * (1 + t / (2 * radius)), 1e-6, 2e-3);
    const partial = slabs(part.document, part.affected[0] as string, { kind: 'polygon', polygons: [rect(20, 30, 160, 170)] });
    check(partial, 140 * 140 * t * (1 + t / (2 * radius)), 1e-6, 2e-3);

    // moved and rotated after creation: the exact slab follows the entity placement (no fallback to triangles)
    const id = partial.ids[0] as string;
    const moved = apply(partial.doc, 'move_entities', { ids: [id], delta: [30, -20, 5] });
    const turned = apply(moved, 'rotate_entity', { id, delta: [0, 0, 0.7] });
    const exported = data<{ faceted: string[]; solidCount: number; step: string }>(turned, 'export_step_ap242', {
      entityIds: [id],
      schema: 'ap214',
      includeValidationProperties: false,
    });
    expect(exported.faceted).toEqual([]);
    const placed = turned.entities[id] as MeshSolidEntity;
    expect(placed.position).not.toEqual([0, 0, 0]);
    const [volume] = importedVolumes(exported.step);
    expect(rel(volume as number, mass(kernel.evaluate(partial.solids[0]?.stepSlab as ShapeRecipe)).volume)).toBeLessThan(1e-9);
    const box = (positions: readonly number[], axis: number): number => Math.max(...positions.filter((_, k) => k % 3 === axis));
    const shifted = kernel.tessellate(
      kernel.evaluate({ op: 'brep', blob: sha256Hex(solidOf(exported.step).solids[0]?.brep ?? ''), format: 'occt-brep-v1' }) as ShapeHandle,
    );
    expect(box(shifted?.positions ?? [], 2)).toBeGreaterThan(5);

    // a document holding an instance of the ply solid exports through the assembly path (triangles) without failing
    const withInstance = apply(partial.doc, 'create_component', { name: 'Ply', entityIds: [id] });
    expect(
      data<{ solidCount: number }>(withInstance, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false }).solidCount,
    ).toBeGreaterThan(0);
  });

  it('lifts a ply of a cone, away from the apex', () => {
    let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
    doc = apply(doc, 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    doc = apply(doc, 'create_lamina_material', AS4);
    const tool = ok(doc, 'add_cone', { radius: 100, height: 100, position: [0, 0, 0] });
    const part = ok(tool.document, 'create_composite_part', {
      name: 'Skin',
      rosette: 'Rax',
      toolSurface: { entityId: tool.affected[0], faceNear: [50, 0, 50] },
    });
    // flat development: polar about the apex; a block of rho 60..120 over x 40..110 (a patch of the sector)
    const polygon = [
      [70, 10],
      [110, 10],
      [110, 40],
      [70, 40],
    ];
    const slab = slabs(part.document, part.affected[0] as string, { kind: 'polygon', polygons: [polygon] });
    expect(slab.solids.length).toBeGreaterThan(0);
    for (const solid of slab.solids) {
      expect(solid.stepSlab?.op).toBe('faceSlab');
      const cone = kernel.evaluate(solid.stepSlab as ShapeRecipe);
      sameGeometry(solid, cone as ShapeHandle);
      const exact = mass(cone).volume;
      expect(rel(exact, meshVolume(solid.mesh)), `${solid.name}: exact ${exact}`).toBeLessThan(0.01);
    }
  });

  it('lifts a ply of a NURBS tool sheet (a sphere patch), exact against the triangle solid', () => {
    const base = withMaterials();
    let doc = apply(base, 'create_lamina_material', WOVEN);
    doc = apply(doc, 'define_rosette', ROSETTE);
    const sheet = addSheet(doc, spherePatch(100, 30, 90));
    const R = 100;
    const onSheet = [R * Math.sin(Math.PI / 3) * Math.SQRT1_2, R * Math.sin(Math.PI / 3) * Math.SQRT1_2, R * Math.cos(Math.PI / 3)];
    const part = ok(sheet.doc, 'create_composite_part', {
      name: 'Skin',
      toolSurface: { entityId: sheet.id, faceNear: onSheet },
      rosette: 'R0',
      laminateSide: 'negative_normal',
    });
    const slab = slabs(part.document, part.affected[0] as string, { kind: 'whole_face' });
    // quarter of a spherical zone of polar 30..90 degrees; the sheet normal Su x Sv points inward, so negative_normal lifts outward
    const t = WOVEN.plyThickness;
    const zone = (Math.PI / 2) * R * R * (Math.cos(Math.PI / 6) - Math.cos(Math.PI / 2));
    const expected = zone * t * (1 + t / R + (t * t) / (3 * R * R));
    check(slab, expected, 1e-4, 0.02);
    expect(step(slab.doc, slab.ids).text, 'the lifted B-spline face is an offset surface of its basis').toContain('OFFSET_SURFACE');
  });
});
