/**
 * Entity -> OCC solid: exact makers for box, cylinder, sphere, cone, torus, wedge, extrusion,
 * revolution (exact arcs / Béziers when the entity carries `curves`) and sweep, sewn triangles for pyramid and mesh entities. Every returned solid sits at the
 * entity's rotation and position; the caller owns (releases) it.
 */

import { markThreadBearing } from './occtThreadMark';
import type { MeshData } from '@core/model/types';
import { type Entity, type Vec3, createEmptyDocument } from '@core/model/types';
import { entityTrianglePositions } from '@core/geometry/entityTriangles';
import { cross3, dot3, sub3 } from '@lib/vec3';
import { orientOutward } from '@core/geometry/meshVolume';
import { isValidPolygon, toCounterClockwise } from '@lib/polygon';
import { release } from '@core/geometry/nativeObject';
import { revolutionAxisIndex } from '@core/geometry/revolution';
import {
  explorer,
  type OccApi,
  type OccHandle,
  type OccMakeFace,
  type OccMakePolygon,
  type OccMakeSolid,
  type OccShape,
  type OccSewing,
  type OccTopoDS,
} from './occtTypes';
import { chainFace, loftedSolid, sweptSolid } from './occtCurves';
import { subdivisionBSplineSolid } from './occtPatches';

/** Planar OCC face of a closed polygon wire through `corners`, or null when OCC rejects it. */
export function polygonFace(api: OccApi, corners: readonly Vec3[]): OccShape | null {
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
function meshDataToTopoDSShape(api: OccApi, mesh: MeshData): OccShape | null {
  const { positions, indices } = mesh;
  if (positions.length === 0 || indices.length === 0 || indices.length % 3 !== 0) return null;

  const vertex = (index: number): Vec3 => [positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0, positions[index * 3 + 2] ?? 0];
  const sewing: OccSewing = new api.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  for (let t = 0; t < indices.length; t += 3) {
    const corners: [Vec3, Vec3, Vec3] = [vertex(indices[t] ?? 0), vertex(indices[t + 1] ?? 0), vertex(indices[t + 2] ?? 0)];
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
export function placementTransform(api: OccApi, rotation: Vec3, position: Vec3, anchorShift: Vec3 = [0, 0, 0]): OccHandle {
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
  const transformer = new api.BRepBuilderAPI_Transform_2(shape, transform, true) as { Shape(): OccShape; delete(): void };
  const moved = transformer.Shape();
  transformer.delete();
  return moved;
}

/** Copy of `shape` placed at `at`'s rotation and position; the input shape is released. */
function placed(api: OccApi, shape: OccShape, at: { readonly rotation: Vec3; readonly position: Vec3 }, anchorShift?: Vec3): OccShape {
  const placement = placementTransform(api, at.rotation, at.position, anchorShift);
  const moved = transformedCopy(api, shape, placement);
  release(placement);
  release(shape);
  return moved;
}

/** `placed` for a builder result that may be null (null stays null). */
function placedOrNull(api: OccApi, shape: OccShape | null, entity: Entity): OccShape | null {
  return shape === null ? null : placed(api, shape, entity);
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
  return placed(api, shape, entity, anchorShift);
}

/** Sweep `face` along `offset` into a prism, placed at the entity's rotation and position. */
function prism(api: OccApi, face: OccShape, offset: Vec3, entity: Entity): OccShape {
  const direction: OccHandle = new api.gp_Vec_4(...offset);
  const maker = new api.BRepPrimAPI_MakePrism_1(face, direction, false, true) as { Shape(): OccShape; delete(): void };
  const shape = maker.Shape();
  [maker, direction, face].forEach(release);
  return placed(api, shape, entity);
}

/**
 * Prism of an XY polygon from z=0 to z=depth. The outline is made counter-clockwise first (a
 * clockwise face would extrude inside-out); degenerate or non-finite profiles -> null.
 */
function extrudedProfile(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'extrusion' || !isValidPolygon(entity.profile) || !(entity.depth > 0)) return null;
  const face =
    entity.curves !== undefined
      ? chainFace(api, entity.curves, ([x, y]) => [x, y, 0], true)
      : polygonFace(
          api,
          toCounterClockwise(entity.profile).map(([x, y]): Vec3 => [x, y, 0]),
        );
  if (face === null) return null;
  return prism(api, face, [0, 0, entity.depth], entity);
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
  return prism(api, face, [width, 0, 0], entity);
}

/**
 * Exact surface of revolution of a profile of [radialOffset, axialOffset] points, using llull's
 * frame for the dominant axis component (Z: radial XY; Y: radial XZ, swept toward +Z; X: radial
 * YZ) and sweeping counter-clockwise from the first radial direction by `angle`.
 */
function revolvedProfile(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'revolution' || !isValidPolygon(entity.profile)) return null;
  if (!(entity.angle > 0) || !(entity.segments >= 3)) return null;
  const frame = (['X', 'Y', 'Z'] as const)[revolutionAxisIndex(entity.axis)];
  // The profile's winding must agree with the sweep direction or the solid comes out inside-out.
  const ordered = frame === 'Y' ? toCounterClockwise(entity.profile) : [...toCounterClockwise(entity.profile)].reverse();
  const place = ([radial, axial]: readonly [number, number]): Vec3 =>
    frame === 'Z' ? [radial, 0, axial] : frame === 'Y' ? [radial, axial, 0] : [axial, radial, 0];
  const face = entity.curves !== undefined ? chainFace(api, entity.curves, place, frame === 'Y') : polygonFace(api, ordered.map(place));
  if (face === null) return null;
  const sweepAxis: Vec3 = frame === 'Z' ? [0, 0, 1] : frame === 'Y' ? [0, -1, 0] : [1, 0, 0];
  const origin: OccHandle = new api.gp_Pnt_3(0, 0, 0);
  const direction: OccHandle = new api.gp_Dir_4(...sweepAxis);
  const axis: OccHandle = new api.gp_Ax1_2(origin, direction);
  const maker = new api.BRepPrimAPI_MakeRevol_1(face, axis, entity.angle, false) as { Shape(): OccShape; delete(): void };
  const shape = maker.Shape();
  [maker, axis, direction, origin, face].forEach(release);
  return placed(api, shape, entity);
}

/** Closed triangle-mesh solid (world space) rebuilt as a sewn OCC solid; open meshes -> null. */
function meshSolid(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'mesh') return null;
  const shape = meshDataToTopoDSShape(api, entity.mesh);
  const moved = [...entity.rotation, ...entity.position].some((value) => value !== 0);
  const result = shape !== null && moved ? placed(api, shape, entity) : shape;
  return result !== null && entity.threadTool === true ? markThreadBearing(result) : result;
}

/** Pyramids (planar faces only, so their sewn triangles are already exact) use their triangles. */
const TRIANGULATED_KINDS: ReadonlySet<Entity['kind']> = new Set(['pyramid']);

/** Primitive tessellation never reads components; instances are not boolean operands. */
const NO_COMPONENTS = createEmptyDocument();

/** Sewn solid from the entity's own (already world-space, outward-wound) triangles. */
function tessellatedSolid(api: OccApi, entity: Entity): OccShape | null {
  const positions = entityTrianglePositions(entity, NO_COMPONENTS);
  if (positions.length === 0) return null;
  return meshDataToTopoDSShape(api, { positions, indices: orientOutward(positions, []) });
}

/** Every solid kind a boolean can take (rotation + position honoured); 2D shapes -> null. */
export function entityToOccShape(api: OccApi, entity: Entity): OccShape | null {
  if (TRIANGULATED_KINDS.has(entity.kind)) return tessellatedSolid(api, entity);
  if (entity.kind === 'extrusion') return extrudedProfile(api, entity);
  if (entity.kind === 'wedge') return wedgeSolid(api, entity);
  if (entity.kind === 'revolution') return revolvedProfile(api, entity);
  if (entity.kind === 'mesh') return meshSolid(api, entity);
  if (entity.kind === 'subdivision') {
    // Smooth cages become exact B-spline faces; a faceted (level 0) cage keeps its triangles.
    const shape = entity.levels > 0 ? subdivisionBSplineSolid(api, entity) : null;
    return placedOrNull(api, shape, entity) ?? tessellatedSolid(api, entity);
  }
  if (entity.kind === 'loft') return placedOrNull(api, loftedSolid(api, entity), entity);
  if (entity.kind === 'sweep') return placedOrNull(api, sweptSolid(api, entity), entity);
  if (entity.kind !== 'box') return revolvedPrimitive(api, entity);
  const [sx, sy, sz] = entity.size;
  if (sx <= 0 || sy <= 0 || sz <= 0) return null;
  const [px, py, pz] = entity.position;
  const rotated = entity.rotation.some((angle) => angle !== 0);
  const [ox, oy, oz] = rotated ? [-sx / 2, -sy / 2, -sz / 2] : [px - sx / 2, py - sy / 2, pz - sz / 2];
  const origin: OccHandle = new api.gp_Pnt_3(ox, oy, oz);
  const maker = new api.BRepPrimAPI_MakeBox_2(origin, sx, sy, sz) as { Shape(): OccShape; delete(): void };
  const shape = maker.Shape();
  origin.delete();
  maker.delete();
  return rotated ? placed(api, shape, entity) : shape;
}
