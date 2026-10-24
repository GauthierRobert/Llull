/**
 * Packed conversion of a regular region of a Catmull-Clark level (04 DIR §5.8): maximal rectangular blocks of regular quads become ONE
 * uniform cubic B-spline surface each (the exact limit surface of the block), instead of one Bézier patch per quad. A block of m x n quads
 * has an (m + 3) x (n + 3) control lattice; the uniform (unclamped) spline is converted to a clamped NURBS by knot insertion at both ends.
 * Pure.
 */

import type { Vec3 } from '../../model/types';
import { add3, scale3 } from '../../lib/vec3';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { type Level, regularRing } from './limit';

export interface PackedBlock {
  /** Vertex ids of the (m + 3) x (n + 3) control lattice; the block quads own lattice rows 1..m+1 and columns 1..n+1. */
  readonly lattice: number[][];
  readonly rows: number;
  readonly columns: number;
  /** Quads of the block. */
  readonly quads: number[];
}

type Grid = number[][];

/** The face of `level` wound a -> b -> c -> d as in the lattice cell, or undefined when the cell is not a quad of the level. */
function cellFace(level: Level, a: number, b: number, c: number, d: number): number | undefined {
  const f = level.topology.directed.get(`${a}>${b}`);
  if (f === undefined) return undefined;
  const face = level.topology.faces[f] as ReadonlyArray<number>;
  const k = face.indexOf(a);
  return face.length === 4 && face[(k + 1) % 4] === b && face[(k + 2) % 4] === c && face[(k + 3) % 4] === d ? f : undefined;
}

const sameIds = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Tries to add one row (`along` "i") or column ("j") of regular quads to `lattice`; returns the new lattice and the added quads, or null
 * when some cell is missing, used, irregular or inconsistent with the lattice.
 */
function extend(level: Level, lattice: Grid, used: ReadonlySet<number>, along: 'i' | 'j'): { lattice: Grid; added: number[] } | null {
  const view = along === 'i' ? lattice : (lattice[0] as number[]).map((_, j) => lattice.map((row) => row[j] as number));
  const rows = view.length;
  const columns = (view[0] as number[]).length;
  const at = (i: number, j: number): number => (view[i] as number[])[j] as number;
  const added: number[] = [];
  const fresh: number[] = new Array<number>(columns).fill(-1);
  for (let q = 0; q < columns - 3; q++) {
    const [a, b, c, d] = [at(rows - 2, q + 1), at(rows - 1, q + 1), at(rows - 1, q + 2), at(rows - 2, q + 2)];
    // the transposed view of a column extension reverses the winding of every cell
    const f = along === 'i' ? cellFace(level, a, b, c, d) : cellFace(level, a, d, c, b);
    if (f === undefined || used.has(f) || added.includes(f)) return null;
    const raw = regularRing(level, f, (level.topology.faces[f] as ReadonlyArray<number>).indexOf(a));
    if (raw === null) return null;
    const ring = along === 'i' ? raw : raw.map((_, x) => raw.map((row) => row[x] as number));
    for (let i = 0; i < 3; i++) if (!sameIds((ring[i] as number[]).slice(), (view[rows - 3 + i] as number[]).slice(q, q + 4))) return null;
    for (let j = 0; j < 4; j++) {
      const id = (ring[3] as number[])[j] as number;
      const slot = q + j;
      if (fresh[slot] !== -1 && fresh[slot] !== id) return null;
      fresh[slot] = id;
    }
    added.push(f);
  }
  const grown = [...view.map((row) => [...row]), fresh];
  return { lattice: along === 'i' ? grown : fresh.map((_, j) => grown.map((row) => row[j] as number)), added };
}

/**
 * Greedy maximal blocks of regular quads of `level` (all-quad): a block grows along i, then j, as long as the next row / column of quads is
 * regular, unused and consistent. Single regular quads are blocks of 1 x 1.
 */
export function packedBlocks(level: Level): PackedBlock[] {
  const used = new Set<number>();
  const blocks: PackedBlock[] = [];
  for (let f = 0; f < level.topology.faces.length; f++) {
    if (used.has(f)) continue;
    const ring = regularRing(level, f);
    if (ring === null) continue;
    let lattice: Grid = ring.map((row) => [...row]);
    const quads = [f];
    used.add(f);
    for (let grew = true; grew; ) {
      grew = false;
      for (const along of ['i', 'j'] as const) {
        const next = extend(level, lattice, used, along);
        if (next === null) continue;
        lattice = next.lattice;
        for (const g of next.added) {
          used.add(g);
          quads.push(g);
        }
        grew = true;
      }
    }
    blocks.push({ lattice, rows: lattice.length - 3, columns: (lattice[0] as number[]).length - 3, quads });
  }
  return blocks;
}

/** Boehm insertion of the knot `u` into an unclamped cubic spline given by `points` and the knot list `knots`. */
function insertUnclamped(points: Vec3[], knots: number[], u: number): { points: Vec3[]; knots: number[] } {
  let k = 3;
  while ((knots[k + 1] as number) <= u) k++;
  const s = knots.filter((knot) => knot === u).length;
  const next: Vec3[] = [];
  for (let i = 0; i <= points.length; i++) {
    if (i <= k - 3) next.push(points[i] as Vec3);
    else if (i >= k - s + 1) next.push(points[i - 1] as Vec3);
    else {
      const alpha = (u - (knots[i] as number)) / ((knots[i + 3] as number) - (knots[i] as number));
      next.push(add3(scale3(points[i] as Vec3, alpha), scale3(points[i - 1] as Vec3, 1 - alpha)));
    }
  }
  return { points: next, knots: [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)] };
}

/** Clamped control points of the uniform cubic spline through `points` (valid on [3, count]): same curve, end multiplicity 4. */
function clampUniform(points: Vec3[]): Vec3[] {
  let state = { points, knots: Array.from({ length: points.length + 4 }, (_, k) => k) };
  for (let times = 0; times < 3; times++) state = insertUnclamped(state.points, state.knots, 3);
  for (let times = 0; times < 3; times++) state = insertUnclamped(state.points, state.knots, points.length);
  return state.points.slice(3, state.points.length - 3);
}

/** The block as one clamped bicubic NURBS surface (poles from `positions`, vertex id -> point), parameter domain [0, rows] x [0, columns]. */
export function blockSurface(block: PackedBlock, positions: ReadonlyArray<Vec3>): NurbsSurfaceData {
  const grid = block.lattice.map((row) => row.map((id) => positions[id] as Vec3));
  const alongJ = grid.map(clampUniform);
  const columns = (alongJ[0] as Vec3[]).map((_, j) => clampUniform(alongJ.map((row) => row[j] as Vec3)));
  const poles = alongJ.map((_, i) => columns.map((column) => column[i] as Vec3));
  const knots = (count: number): { knots: number[]; multiplicities: number[] } => ({
    knots: Array.from({ length: count + 1 }, (_, k) => k),
    multiplicities: Array.from({ length: count + 1 }, (_, k) => (k === 0 || k === count ? 4 : 1)),
  });
  const [ku, kv] = [knots(block.rows), knots(block.columns)];
  return {
    degreeU: 3,
    degreeV: 3,
    poles,
    knotsU: ku.knots,
    multiplicitiesU: ku.multiplicities,
    knotsV: kv.knots,
    multiplicitiesV: kv.multiplicities,
  };
}
