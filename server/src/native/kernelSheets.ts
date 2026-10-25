/**
 * The `sheetSolid` recipe node of the native kernel (capability `sheetSolid`, TECHNICAL_SPEC 5.5 / 16): a sweep with laws, a frame mode, rails or a
 * helix the pipe cannot follow exactly, and a loft with exact faces, are lowered here from their entity to one node holding the fitted B-spline faces
 * (`packages/core/src/model/sheetSolid.ts`). The stored recipe keeps the compact leaf; the faces are re-derived from the entity at every evaluation, so
 * replay and persistence are unchanged (L8).
 * @invariant pure: no process, no I/O; an entity this lowering does not cover (or whose faces do not fit) is left to `nativeLeaf`
 */

import type { Entity, ShapeRecipe, SweepEntity } from '@core/model/types';
import type { SheetPipeShell, SheetSolidRecipe } from '@core/model/sheetSolid';
import { isClosedChain } from '@core/geometry/curveSegments';
import { pathLength } from '@core/geometry/sweepEval/evaluate';
import { fitSweepFaces, fitToleranceOf, sewToleranceOf } from '@core/geometry/sweepEval/fitted';
import { sectionTransforms } from '@core/geometry/sweepEval/laws';
import { needsFittedFaces } from '@core/geometry/sweepEval/realisation';
import { encodeSurface } from '@core/geometry/surfaceWire';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { extractSubSurface } from '@lib/nurbs/surfaceEdit';
import { encodeChain, sectionPayload, type WireOptions } from './kernelLeaves';

type LoftEntity = Extract<Entity, { kind: 'loft' }>;

/** Trihedron modes MakePipeShell offers for the orientation modes the sweep evaluator shares with it. */
const SHELL_MODES: Readonly<Record<string, number>> = { minimal: 0, frenet: 1, fixed: 2, binormal: 3 };

/** Samples of the section scale (laws folded in) at 33 path fractions, as (fraction, scale) pairs for a homothetic law. */
function scalePairs(entity: SweepEntity): number[] {
  const ts = Array.from({ length: 33 }, (_, k) => k / 32);
  const transforms = sectionTransforms(entity, ts, pathLength(entity));
  return transforms.flatMap((transform, k) => [ts[k] as number, transform.sx]);
}

/**
 * The MakePipeShell attempt of a sweep (capability `pipeShell`): a constant solid section with a scale / area law and/or a frame mode OCC has an
 * equivalent for. The sidecar uses its result only when it passes `probes` (points of the fitted faces) and reproduces their volume.
 */
function pipeShellOf(entity: SweepEntity, tolerance: number, probes: readonly number[]): SheetPipeShell | null {
  const { section } = entity;
  const unsupported =
    isClosedChain(entity.path) ||
    (section.shape === 'circle' && section.innerRadius !== undefined) ||
    [entity.stations, entity.rails, entity.helix, entity.twist, entity.stretch].some((field) => field !== undefined);
  const mode = entity.orientation?.mode ?? 'minimal';
  const lawed = entity.scale !== undefined || entity.area !== undefined;
  if (unsupported || SHELL_MODES[mode] === undefined || !(lawed || mode !== 'minimal')) return null;
  const orientation = entity.orientation;
  const direction = orientation?.mode === 'fixed' || orientation?.mode === 'binormal' ? (orientation.direction ?? [0, 0, 1]) : [0, 0, 1];
  const { circle, chain } = sectionPayload(entity) as { circle?: SheetPipeShell['circle']; chain?: number[] };
  return {
    spine: encodeChain(entity.path),
    ...(circle === undefined ? {} : { circle }),
    ...(chain === undefined ? {} : { chain }),
    mode: SHELL_MODES[mode] as number,
    direction: direction as SheetPipeShell['direction'],
    ...(lawed ? { law: scalePairs(entity) } : {}),
    transition: 0,
    tolerance,
    probes,
    check: tolerance,
  };
}

/** A plain bored helix keeps the exact helix pipe (`helix_pipe_solid`): the fitted faces are no more exact there. */
const keepsHelixPipe = (entity: SweepEntity): boolean =>
  entity.helix !== undefined &&
  entity.orientation === undefined &&
  [entity.twist, entity.scale, entity.area, entity.stretch].every((law) => law === undefined) &&
  entity.section.shape === 'circle' &&
  entity.section.innerRadius !== undefined;

function sweepSheet(entity: SweepEntity, wire: WireOptions): Omit<SheetSolidRecipe, 'position' | 'rotation' | 'name' | 'op'> | null {
  if (wire.sheetSolid !== true || entity.corners === 'miter' || !needsFittedFaces(entity) || keepsHelixPipe(entity)) return null;
  const fit = fitSweepFaces(entity, fitToleranceOf(entity));
  if (!('faces' in fit)) return null;
  const tolerance = sewToleranceOf(entity);
  const shell = wire.pipeShell === true ? pipeShellOf(entity, tolerance, fit.probes) : null;
  return {
    faces: fit.faces,
    ...(fit.bore === undefined ? {} : { bore: fit.bore.faces }),
    tolerance,
    caps: isClosedChain(entity.path) ? 0 : 2,
    ...(shell === null ? {} : { pipeShell: shell }),
  };
}

/** A face cut at its u knots into single-span faces, like the faces of a fitted sweep: the sewing then joins edges of different faces (a whole section as one face closes on itself and is not sewn). */
function spans(face: NurbsSurfaceData): NurbsSurfaceData[] {
  const v: readonly [number, number] = [face.knotsV[0] as number, face.knotsV[face.knotsV.length - 1] as number];
  if (face.knotsU.length < 3) return [face];
  const pieces = face.knotsU.slice(1).map((end, k) => extractSubSurface(face, [face.knotsU[k] as number, end], v));
  return pieces.every((piece): piece is NurbsSurfaceData => typeof piece !== 'string') ? pieces : [face];
}

/** Exact skin of an advanced loft: its NURBS faces with the sewing tolerance (1e-6 of the skin's size). */
function loftSheet(entity: LoftEntity, wire: WireOptions): Omit<SheetSolidRecipe, 'position' | 'rotation' | 'name' | 'op'> | null {
  if (wire.sheetSolid !== true || entity.faces === undefined || entity.faces.length === 0) return null;
  const faces = entity.faces.flatMap(spans);
  const poles = faces.flatMap((face) => face.poles.flat());
  const extent = [0, 1, 2].map(
    (axis) => Math.max(...poles.map((p) => p[axis] as number)) - Math.min(...poles.map((p) => p[axis] as number)),
  );
  return { faces: faces.map(encodeSurface), tolerance: Math.max(1e-7, 1e-6 * Math.hypot(...extent)), caps: entity.caps ?? 2 };
}

/**
 * The `sheetSolid` node standing for a sweep or loft leaf, or null when the sidecar builds the leaf itself (a pipe, a helix pipe, a mitre, a loft of rings)
 * or the faces do not fit (the leaf then stays a mesh for the exact kernel).
 */
export function sheetSolidOf(entity: Entity, wire: WireOptions): ShapeRecipe | null {
  const sheet = entity.kind === 'sweep' ? sweepSheet(entity, wire) : entity.kind === 'loft' ? loftSheet(entity, wire) : null;
  if (sheet === null) return null;
  return { op: 'sheetSolid', ...sheet, position: entity.position, rotation: entity.rotation, name: entity.id };
}
