/**
 * @layer kernel
 * Entity -> OCC solid: exact makers for box, cylinder, sphere, cone, torus, wedge, extrusion and
 * revolution, sewn triangles for pyramid and mesh entities. Every returned solid sits at the
 * entity's rotation and position; the caller owns (releases) it.
 */

import type { MeshData } from '@core/geometry/kernel';
import type { Entity, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { entityToTriangles } from '@core/commands/exportTriangulate';
import { cross3, dot3, sub3 } from '@lib/vec3';
import { isValidPolygon, toCounterClockwise } from '@lib/polygon';
import {
  explorer,
  release,
  type OccApi,
  type OccHandle,
  type OccMakeFace,
  type OccMakePolygon,
  type OccMakeSolid,
  type OccShape,
  type OccSewing,
  type OccTopoDS,
} from './occtTypes';

/** Planar OCC face of a closed polygon wire through `corners`, or null when OCC rejects it. */
function polygonFace(api: OccApi, corners: readonly Vec3[]): OccShape | null {
  const points: OccHandle[] = corners.map(([x, y, z]) => new api.gp_Pnt_3(x, y, z));
  const poly = new api.BRepBuilderAPI_MakePolygon_1() as OccMakePolygon;
  for (const point of points) poly.Add_1(point);
  poly.Close();
  points.forEach(release);
  if (!poly.IsDone()) {
    poly.delete();
    return null;
  }
  const wire = poly.Wire();
  const makeFace = new api.BRepBuilderAPI_MakeFace_15(wire, false) as OccMakeFace;
  release(wire);
  poly.delete();
  const face = makeFace.IsDone() ? makeFace.Face() : null;
  makeFace.delete();
  return face;
}

/**
 * Rebuild a solid from MeshData: per-triangle planar faces sewn into a shell (BRepBuilderAPI_Sewing),
 * promoted with BRepBuilderAPI_MakeSolid. Degenerate triangles are skipped.
 * @failure empty / malformed mesh, open shell, MakeSolid not done -> null
 */
export function meshDataToTopoDSShape(api: OccApi, mesh: MeshData): OccShape | null {
  const { positions, indices } = mesh;
  if (positions.length === 0 || indices.length === 0 || indices.length % 3 !== 0) return null;

  const vertex = (index: number): Vec3 => [
    positions[index * 3] ?? 0,
    positions[index * 3 + 1] ?? 0,
    positions[index * 3 + 2] ?? 0,
  ];
  const sewing: OccSewing = new api.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  for (let t = 0; t < indices.length; t += 3) {
    const corners: [Vec3, Vec3, Vec3] = [
      vertex(indices[t] ?? 0),
      vertex(indices[t + 1] ?? 0),
      vertex(indices[t + 2] ?? 0),
    ];
    const normal = cross3(sub3(corners[1], corners[0]), sub3(corners[2], corners[0]));
    if (dot3(normal, normal) < 1e-24) continue;
    const face = polygonFace(api, corners);
    if (face) {
      sewing.Add(face);
      release(face);
    }
  }

  const noProgress = new api.Handle_Message_ProgressIndicator_1();
  sewing.Perform(noProgress);
  noProgress.delete();
  const sewn = sewing.SewedShape() as OccShape | null;
  if (!sewn) {
    sewing.delete();
    return null;
  }

  const makeSolid: OccMakeSolid = new api.BRepBuilderAPI_MakeSolid_1();
  const shellExp = explorer(api, sewn, 'TopAbs_SHELL');
  let shellCount = 0;
  while (shellExp.More()) {
    const current = shellExp.Current();
    const shell = (api.TopoDS as OccTopoDS).Shell_1(current);
    makeSolid.Add(shell);
    release(shell);
    release(current);
    shellCount++;
    shellExp.Next();
  }
  shellExp.delete();
  release(sewn);
  sewing.delete();

  if (shellCount > 0) makeSolid.Build();
  const solid = shellCount > 0 && makeSolid.IsDone() ? makeSolid.Shape() : null;
  makeSolid.delete();
  return solid;
}

/** llull placement M = Rx·Ry·Rz (Rz applied first, radians) followed by the translation. */
export function placementTransform(
  api: OccApi,
  rotation: Vec3,
  position: Vec3,
  anchorShift: Vec3 = [0, 0, 0],
): OccHandle {
  const total = new api.gp_Trsf_1();
  const offset: OccHandle = new api.gp_Vec_4(position[0], position[1], position[2]);
  total.SetTranslation_1(offset);
  release(offset);
  const axes: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
    [rotation[0], [1, 0, 0]],
    [rotation[1], [0, 1, 0]],
    [rotation[2], [0, 0, 1]],
  ];
  for (const [angle, [x, y, z]] of axes) {
    const origin: OccHandle = new api.gp_Pnt_3(0, 0, 0);
    const direction: OccHandle = new api.gp_Dir_4(x, y, z);
    const axis: OccHandle = new api.gp_Ax1_2(origin, direction);
    const turn = new api.gp_Trsf_1();
    turn.SetRotation_1(axis, angle);
    total.Multiply(turn);
    [turn, axis, direction, origin].forEach(release);
  }
  if (anchorShift.some((component) => component !== 0)) {
    const shift: OccHandle = new api.gp_Vec_4(anchorShift[0], anchorShift[1], anchorShift[2]);
    const local = new api.gp_Trsf_1();
    local.SetTranslation_1(shift);
    total.Multiply(local);
    [local, shift].forEach(release);
  }
  return total;
}

/** Copy of `shape` moved by `transform` (geometry copied); neither input is released. */
export function transformedCopy(api: OccApi, shape: OccShape, transform: OccHandle): OccShape {
  const transformer = new api.BRepBuilderAPI_Transform_2(shape, transform, true) as {
    Shape(): OccShape;
    delete(): void;
  };
  const moved = transformer.Shape();
  transformer.delete();
  return moved;
}

/** Copy of `shape` moved by `placement`; the input shape and the placement are released. */
function placed(api: OccApi, shape: OccShape, placement: OccHandle): OccShape {
  const moved = transformedCopy(api, shape, placement);
  release(placement);
  release(shape);
  return moved;
}

/**
 * Cylinder (centered, axis +Z), sphere and torus (centered) and cone (base-center, apex +height) built at the
 * origin then placed with the entity's rotation and position; non-positive sizes -> null.
 */
function revolvedPrimitive(api: OccApi, entity: Entity): OccShape | null {
  let anchorShift: Vec3 = [0, 0, 0];
  let maker: { Shape(): OccShape; delete(): void };
  if (entity.kind === 'cylinder') {
    if (!(entity.radius > 0 && entity.height > 0)) return null;
    maker = new api.BRepPrimAPI_MakeCylinder_1(entity.radius, entity.height);
    anchorShift = [0, 0, -entity.height / 2];
  } else if (entity.kind === 'sphere') {
    if (!(entity.radius > 0)) return null;
    maker = new api.BRepPrimAPI_MakeSphere_1(entity.radius);
  } else if (entity.kind === 'cone') {
    if (!(entity.radius > 0 && entity.height > 0)) return null;
    maker = new api.BRepPrimAPI_MakeCone_1(entity.radius, 0, entity.height);
  } else if (entity.kind === 'torus') {
    if (!(entity.tubeRadius > 0 && entity.ringRadius > entity.tubeRadius)) return null;
    maker = new api.BRepPrimAPI_MakeTorus_1(entity.ringRadius, entity.tubeRadius);
  } else {
    return null;
  }
  const shape = maker.Shape();
  maker.delete();
  return placed(api, shape, placementTransform(api, entity.rotation, entity.position, anchorShift));
}

/**
 * Prism of an XY polygon from z=0 to z=depth. The outline is made counter-clockwise first (a
 * clockwise face would extrude inside-out); degenerate or non-finite profiles -> null.
 */
function extrudedProfile(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'extrusion' || !isValidPolygon(entity.profile) || !(entity.depth > 0)) {
    return null;
  }
  const outline = toCounterClockwise(entity.profile).map(([x, y]): Vec3 => [x, y, 0]);
  const face = polygonFace(api, outline);
  if (face === null) return null;
  const direction: OccHandle = new api.gp_Vec_4(0, 0, entity.depth);
  const maker = new api.BRepPrimAPI_MakePrism_1(face, direction, false, true) as {
    Shape(): OccShape;
    delete(): void;
  };
  const shape = maker.Shape();
  [maker, direction, face].forEach(release);
  return placed(api, shape, placementTransform(api, entity.rotation, entity.position));
}

/** Right-triangle prism: the YZ triangle (0,0), (h,0), (0,d) extruded along +X by the width. */
function wedgeSolid(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'wedge' || !entity.size.every((side) => side > 0)) return null;
  const [width, height, depth] = entity.size;
  const face = polygonFace(api, [
    [0, 0, 0],
    [0, height, 0],
    [0, 0, depth],
  ]);
  if (face === null) return null;
  const direction: OccHandle = new api.gp_Vec_4(width, 0, 0);
  const maker = new api.BRepPrimAPI_MakePrism_1(face, direction, false, true) as {
    Shape(): OccShape;
    delete(): void;
  };
  const shape = maker.Shape();
  [maker, direction, face].forEach(release);
  return placed(api, shape, placementTransform(api, entity.rotation, entity.position));
}

/**
 * Exact surface of revolution of a profile of [radialOffset, axialOffset] points, using llull's
 * frame for the dominant axis component (Z: radial XY; Y: radial XZ, swept toward +Z; X: radial
 * YZ) and sweeping counter-clockwise from the first radial direction by `angle`.
 */
function revolvedProfile(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'revolution' || !isValidPolygon(entity.profile)) return null;
  if (!(entity.angle > 0) || !(entity.segments >= 3)) return null;
  const [absX, absY, absZ] = [
    Math.abs(entity.axis[0]),
    Math.abs(entity.axis[1]),
    Math.abs(entity.axis[2]),
  ];
  const frame = absZ >= absX && absZ >= absY ? 'Z' : absY >= absX ? 'Y' : 'X';
  // The profile's winding must agree with the sweep direction or the solid comes out inside-out.
  const ordered =
    frame === 'Y'
      ? toCounterClockwise(entity.profile)
      : [...toCounterClockwise(entity.profile)].reverse();
  const corners = ordered.map(
    ([radial, axial]): Vec3 =>
      frame === 'Z' ? [radial, 0, axial] : frame === 'Y' ? [radial, axial, 0] : [axial, radial, 0],
  );
  const face = polygonFace(api, corners);
  if (face === null) return null;
  const sweepAxis: Vec3 = frame === 'Z' ? [0, 0, 1] : frame === 'Y' ? [0, -1, 0] : [1, 0, 0];
  const origin: OccHandle = new api.gp_Pnt_3(0, 0, 0);
  const direction: OccHandle = new api.gp_Dir_4(...sweepAxis);
  const axis: OccHandle = new api.gp_Ax1_2(origin, direction);
  const maker = new api.BRepPrimAPI_MakeRevol_1(face, axis, entity.angle, false) as {
    Shape(): OccShape;
    delete(): void;
  };
  const shape = maker.Shape();
  [maker, axis, direction, origin, face].forEach(release);
  return placed(api, shape, placementTransform(api, entity.rotation, entity.position));
}

/** Closed triangle-mesh solid (world space) rebuilt as a sewn OCC solid; open meshes -> null. */
function meshSolid(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'mesh') return null;
  const shape = meshDataToTopoDSShape(api, entity.mesh);
  const moved = [...entity.rotation, ...entity.position].some((value) => value !== 0);
  return shape !== null && moved
    ? placed(api, shape, placementTransform(api, entity.rotation, entity.position))
    : shape;
}

/** Pyramids (planar faces only, so their sewn triangles are already exact) use their triangles. */
const TRIANGULATED_KINDS: ReadonlySet<Entity['kind']> = new Set(['pyramid']);

/** Primitive tessellation never reads components; instances are not boolean operands. */
const NO_COMPONENTS = createEmptyDocument();

/** Signed volume of a triangle soup (9 numbers per triangle); negative when wound inward. */
function soupVolume(positions: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const [a, b, c] = [
      positions.slice(i, i + 3),
      positions.slice(i + 3, i + 6),
      positions.slice(i + 6, i + 9),
    ];
    sum += dot3(a as unknown as Vec3, cross3(b as unknown as Vec3, c as unknown as Vec3));
  }
  return sum / 6;
}

/** Sewn solid from the entity's own (already world-space, outward-wound) triangles. */
function tessellatedSolid(api: OccApi, entity: Entity): OccShape | null {
  const positions: number[] = [];
  for (const triangle of entityToTriangles(entity, NO_COMPONENTS)) {
    for (const [x, y, z] of triangle) positions.push(x, y, z);
  }
  if (positions.length === 0) return null;
  if (soupVolume(positions) < 0) {
    for (let i = 0; i + 8 < positions.length; i += 9) {
      positions.splice(
        i + 3,
        6,
        ...positions.slice(i + 6, i + 9),
        ...positions.slice(i + 3, i + 6),
      );
    }
  }
  const indices = Array.from({ length: positions.length / 3 }, (_, corner) => corner);
  return meshDataToTopoDSShape(api, { positions, indices });
}

/** Every solid kind a boolean can take (rotation + position honoured); 2D shapes -> null. */
export function entityToOccShape(api: OccApi, entity: Entity): OccShape | null {
  if (TRIANGULATED_KINDS.has(entity.kind)) return tessellatedSolid(api, entity);
  if (entity.kind === 'extrusion') return extrudedProfile(api, entity);
  if (entity.kind === 'wedge') return wedgeSolid(api, entity);
  if (entity.kind === 'revolution') return revolvedProfile(api, entity);
  if (entity.kind === 'mesh') return meshSolid(api, entity);
  if (entity.kind !== 'box') return revolvedPrimitive(api, entity);
  const [sx, sy, sz] = entity.size;
  if (sx <= 0 || sy <= 0 || sz <= 0) return null;
  const [px, py, pz] = entity.position;
  const rotated = entity.rotation.some((angle) => angle !== 0);
  const [ox, oy, oz] = rotated
    ? [-sx / 2, -sy / 2, -sz / 2]
    : [px - sx / 2, py - sy / 2, pz - sz / 2];
  const origin: OccHandle = new api.gp_Pnt_3(ox, oy, oz);
  const maker = new api.BRepPrimAPI_MakeBox_2(origin, sx, sy, sz) as {
    Shape(): OccShape;
    delete(): void;
  };
  const shape = maker.Shape();
  origin.delete();
  maker.delete();
  return rotated
    ? placed(api, shape, placementTransform(api, entity.rotation, entity.position))
    : shape;
}
