/** Draping a ply (06 CMP §5.4): a net per boundary piece, seeded at the ply seed (or the piece bisector at a shared vertex), warp along the fibre. */

import type { CompositePart, Ply } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import { polygonArea, polygonCentroid } from '@lib/polygon';
import { normalize3, sub3 } from '@lib/vec3';
import { boundaryDistance, insideOrOn, piecesOf } from '../geometry2d';
import { fibreDirection, fromFlat } from '../surface';
import { netFlattener } from './flatten';
import { type DrapeNet, buildNet } from './net';
import { type ShearLimits, type ShearSummary, summarizeShear } from './shear';
import { type DrapeSurface, drapeSurfaceOf } from './surfaceQuery';

export interface PieceDrape {
  readonly index: number;
  readonly piece: readonly Vec2[];
  readonly seedUv: Vec2;
  readonly net: DrapeNet;
  readonly summary: ShearSummary;
  /** Fraction of interior chart samples of the piece that fall in a complete net cell (ok or locked); below ~0.99 the drape is incomplete. */
  readonly coverage: number;
}

export interface PlyDrapeSet {
  readonly stepLength: number;
  readonly pieces: readonly PieceDrape[];
}

export interface PlyDrapeOptions {
  readonly stepLength?: number | undefined;
  readonly limits: ShearLimits;
  readonly allowOverLock: boolean;
  /** Node budget of the net (default 400 000). */
  readonly maxNodes?: number | undefined;
}

export type PlyDrapeResult =
  | ({ readonly ok: true } & PlyDrapeSet)
  | { readonly ok: false; readonly code: 'CMP_PARAM_INVALID'; readonly message: string };

const MAX_NODES_ESTIMATE = 1_500_000;

const bounds = (polygon: readonly Vec2[]): { min: Vec2; max: Vec2 } => ({
  min: [Math.min(...polygon.map(([x]) => x)), Math.min(...polygon.map(([, y]) => y))],
  max: [Math.max(...polygon.map(([x]) => x)), Math.max(...polygon.map(([, y]) => y))],
});

/**
 * Share of a regular chart grid (30 x 30 over the bounding box, interior points only) that lies in a net cell whose four corners exist. A failed node
 * (off face, inverted, non-converged) or a truncated net leaves cells missing, so coverage falls below 1; a cell over the lock still counts (it is mapped).
 */
export function pieceCoverage(net: DrapeNet, piece: readonly Vec2[]): number {
  const lookup = netFlattener(net);
  const { min, max } = bounds(piece);
  let inside = 0;
  let mapped = 0;
  for (let i = 0; i < 30; i++)
    for (let j = 0; j < 30; j++) {
      const p: Vec2 = [min[0] + ((max[0] - min[0]) * (i + 0.5)) / 30, min[1] + ((max[1] - min[1]) * (j + 0.5)) / 30];
      if (!insideOrOn(p, piece, 0)) continue;
      inside++;
      if (lookup(p).kind !== 'miss') mapped++;
    }
  return inside === 0 ? 1 : mapped / inside;
}

/** Automatic fishnet step: the outline diagonal over 200. */
export function autoStepLength(part: CompositePart): number {
  const { min, max } = bounds(part.outline);
  return Math.hypot(max[0] - min[0], max[1] - min[1]) / 200;
}

/** A point well inside `polygon`: its centroid when inside, else the grid point farthest from the boundary. */
export function interiorPoint(polygon: readonly Vec2[]): Vec2 {
  const centre = polygonCentroid(polygon);
  if (insideOrOn(centre, polygon, 0)) return centre;
  const { min, max } = bounds(polygon);
  let best: Vec2 = centre;
  let distance = -1;
  for (let i = 1; i < 24; i++)
    for (let j = 1; j < 24; j++) {
      const p: Vec2 = [min[0] + ((max[0] - min[0]) * i) / 24, min[1] + ((max[1] - min[1]) * j) / 24];
      if (insideOrOn(p, polygon, 0) && boundaryDistance(p, polygon) > distance) [best, distance] = [p, boundaryDistance(p, polygon)];
    }
  return best;
}

/** Default seed: the pole of a sphere cap, otherwise a point well inside the face outline (the centroid when inside). */
export function defaultSeed(part: CompositePart): Vec2 {
  return part.surface.type === 'sphere' ? [0, 0] : interiorPoint(part.outline);
}

/** Unit 3D image of the chart direction `dir` at `uv` (central difference through the chart parametrization). */
function imageDirection(part: CompositePart, uv: Vec2, dir: Vec2): Vec3 {
  const step = 1e-4 * (1 + Math.hypot(uv[0], uv[1]));
  return normalize3(
    sub3(
      fromFlat(part.surface, [uv[0] + dir[0] * step, uv[1] + dir[1] * step]),
      fromFlat(part.surface, [uv[0] - dir[0] * step, uv[1] - dir[1] * step]),
    ),
  );
}

/** Chart direction bisecting the interior angle of counter-clockwise `piece` at vertex `k`. */
function bisector(piece: readonly Vec2[], k: number): Vec2 {
  const [v, next, previous] = [
    piece[k] as Vec2,
    piece[(k + 1) % piece.length] as Vec2,
    piece[(k + piece.length - 1) % piece.length] as Vec2,
  ];
  const unit = (to: Vec2): Vec2 => {
    const length = Math.hypot(to[0] - v[0], to[1] - v[1]) || 1;
    return [(to[0] - v[0]) / length, (to[1] - v[1]) / length];
  };
  const [e1, e2] = [unit(next), unit(previous)];
  let angle = Math.atan2(e1[0] * e2[1] - e1[1] * e2[0], e1[0] * e2[0] + e1[1] * e2[1]);
  if (angle <= 0) angle += 2 * Math.PI;
  return [e1[0] * Math.cos(angle / 2) - e1[1] * Math.sin(angle / 2), e1[0] * Math.sin(angle / 2) + e1[1] * Math.cos(angle / 2)];
}

/** Seed (chart) and warp direction (3D) of one piece. */
function pieceStart(part: CompositePart, ply: Ply, piece: readonly Vec2[]): { seedUv: Vec2; warp: Vec3 } {
  const wanted = ply.drape?.seed ?? defaultSeed(part);
  const seedUv = insideOrOn(wanted, piece, 1e-6) ? wanted : interiorPoint(piece);
  const size = Math.max(...piece.map(([x]) => Math.abs(x)), ...piece.map(([, y]) => Math.abs(y)), 1);
  const vertex = piece.findIndex((p) => Math.hypot(p[0] - seedUv[0], p[1] - seedUv[1]) <= 1e-6 * size);
  const rotated = (dir: Vec2): Vec2 => {
    const theta = (ply.orientation * Math.PI) / 180;
    return [dir[0] * Math.cos(theta) - dir[1] * Math.sin(theta), dir[0] * Math.sin(theta) + dir[1] * Math.cos(theta)];
  };
  const dir = vertex >= 0 ? rotated(bisector(piece, vertex)) : fibreDirection(part.surface, seedUv, ply.orientation);
  return { seedUv, warp: imageDirection(part, seedUv, dir) };
}

/**
 * Drapes every piece of `ply` (darts and splices included) with its own net.
 * @invariant each piece is draped from the ply seed (the piece bisector there when the seed is a vertex of the piece, as after darts meeting at
 *   a pole), else from an interior point; the net spans the whole face (plus a margin of two steps) so that generators outside the piece exist, statistics count only nodes inside the piece, and locking is evaluated on the whole-face net
 * @failure a net estimated above 1.5 million nodes -> CMP_PARAM_INVALID naming a larger step length
 */
export function drapePly(part: CompositePart, ply: Ply, options: PlyDrapeOptions): PlyDrapeResult {
  const d = options.stepLength ?? ply.drape?.stepLength ?? autoStepLength(part);
  const pieces: PieceDrape[] = [];
  for (const [index, piece] of piecesOf(ply, part).entries()) {
    const estimate = (polygonArea(part.outline) * 2) / (d * d);
    if (estimate > MAX_NODES_ESTIMATE)
      return {
        ok: false,
        code: 'CMP_PARAM_INVALID',
        message: `a step length of ${d} would need about ${Math.round(estimate)} nodes for piece ${index}; use a larger stepLength`,
      };
    const { seedUv, warp } = pieceStart(part, ply, piece);
    const surface: DrapeSurface = drapeSurfaceOf(part);
    const seed = surface.project(fromFlat(part.surface, seedUv));
    if (seed === null)
      return {
        ok: false,
        code: 'CMP_PARAM_INVALID',
        message: `the tool surface is degenerate at the seed [${seedUv.join(', ')}] of piece ${index}`,
      };
    const { min, max } = bounds(part.outline);
    const net = buildNet(surface, {
      d,
      seed,
      warp,
      lockingAngle: options.limits.lock,
      allowOverLock: options.allowOverLock,
      ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      extent: Math.hypot(max[0] - min[0], max[1] - min[1]) * 1.5,
    });
    pieces.push({
      index,
      piece,
      seedUv,
      net,
      coverage: pieceCoverage(net, piece),
      summary: summarizeShear(net, options.limits, (node) => insideOrOn(node.hit.uv, piece, 1e-6 * (1 + Math.hypot(...node.hit.uv)))),
    });
  }
  return { ok: true, stepLength: d, pieces };
}
