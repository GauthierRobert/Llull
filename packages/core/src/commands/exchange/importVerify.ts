/**
 * GVP check of an imported product tree (aerospace 04 XCH M3, TR-XCH-08): the validation properties the sender embedded (read from the file text by
 * the independent Part 21 reader) against the volume, area and centroid llull recomputes from the exact B-rep it just built, per product, placed
 * assemblies included. Never blocks an import: the band only informs `unverified` and `reviewRequired`.
 * @invariant lengths are millimetres on both sides (the kernel reads in mm); document units are applied when the result is stored
 */

import type { ImportedExchange } from '../../geometry/kernelExchange';
import type { ExactMassProperties } from '../../geometry/kernelPorts';
import type { Vec3 } from '../../model/types';
import type { EmbeddedGvp, GvpCheck, GvpPolicy } from '../../model/exchange';
import type { Step21Summary } from '../../lib/step21/summary';
import { type FileGvpGroup, embeddedOf, groupFileGvp } from './fileGvp';
import { type GvpSample, compareGvp, worstBand } from './gvpBands';

/** One integrated piece: volume, area, centroid and its axis-aligned box (mm). */
interface Piece {
  readonly volume: number;
  readonly area: number;
  readonly centroid: Vec3;
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface ProductVerification {
  readonly product: number;
  readonly name: string;
  readonly embedded?: EmbeddedGvp;
  /** Recomputed in millimetres (mm^3, mm^2, mm). */
  readonly recomputed?: { readonly volume: number; readonly area: number; readonly centroid: Vec3 };
  readonly check: GvpCheck;
}

const fromExact = (mass: ExactMassProperties): Piece => ({
  volume: mass.volume,
  area: mass.area,
  centroid: mass.centroid,
  min: mass.bounds.min,
  max: mass.bounds.max,
});

/** `p` placed by the row-major 3x4 matrix `m`. */
function place(m: readonly number[], p: Vec3): Vec3 {
  const at = (row: number): number =>
    (m[row * 4] ?? 0) * p[0] + (m[row * 4 + 1] ?? 0) * p[1] + (m[row * 4 + 2] ?? 0) * p[2] + (m[row * 4 + 3] ?? 0);
  return [at(0), at(1), at(2)];
}

function placed(piece: Piece, matrix: readonly number[]): Piece {
  const corners: Vec3[] = [];
  for (const x of [piece.min[0], piece.max[0]])
    for (const y of [piece.min[1], piece.max[1]]) for (const z of [piece.min[2], piece.max[2]]) corners.push(place(matrix, [x, y, z]));
  const axis = (k: 0 | 1 | 2): number[] => corners.map((corner) => corner[k]);
  return {
    volume: piece.volume,
    area: piece.area,
    centroid: place(matrix, piece.centroid),
    min: [Math.min(...axis(0)), Math.min(...axis(1)), Math.min(...axis(2))],
    max: [Math.max(...axis(0)), Math.max(...axis(1)), Math.max(...axis(2))],
  };
}

function sum(pieces: readonly Piece[]): Piece | undefined {
  const volume = pieces.reduce((total, piece) => total + piece.volume, 0);
  if (pieces.length === 0 || !(volume > 0)) return undefined;
  const centroid = [0, 1, 2].map(
    (k) => pieces.reduce((total, piece) => total + piece.volume * piece.centroid[k]!, 0) / volume,
  ) as unknown as Vec3;
  const lowest = (k: 0 | 1 | 2): number => Math.min(...pieces.map((piece) => piece.min[k]));
  const highest = (k: 0 | 1 | 2): number => Math.max(...pieces.map((piece) => piece.max[k]));
  return {
    volume,
    area: pieces.reduce((total, piece) => total + piece.area, 0),
    centroid,
    min: [lowest(0), lowest(1), lowest(2)],
    max: [highest(0), highest(1), highest(2)],
  };
}

/** Group matching the product: same name, nearest volume among the not yet used ones. */
function matchGroup(
  names: readonly string[],
  volume: number | undefined,
  groups: readonly FileGvpGroup[],
  used: Set<FileGvpGroup>,
): FileGvpGroup | undefined {
  const candidates = groups.filter((group) => group.product !== null && names.includes(group.product) && !used.has(group));
  return candidates.reduce<FileGvpGroup | undefined>(
    (best, group) =>
      best === undefined || Math.abs((group.volume ?? 0) - (volume ?? 0)) < Math.abs((best.volume ?? 0) - (volume ?? 0)) ? group : best,
    undefined,
  );
}

/**
 * Per product of `imported`: embedded properties (matched by product name) against the recomputed ones.
 * @param masses exact mass properties (mm) of `imported.solids`, in order; null where the kernel could not integrate the solid
 */
export function verifyImportedProducts(
  imported: ImportedExchange,
  masses: readonly (ExactMassProperties | null)[],
  summary: Step21Summary,
  policy: GvpPolicy,
): ProductVerification[] {
  const groups = groupFileGvp(summary, 1);
  const used = new Set<FileGvpGroup>();
  const memo = new Map<number, Piece | undefined>();
  const visiting = new Set<number>();

  const pieceOf = (index: number): Piece | undefined => {
    if (memo.has(index)) return memo.get(index);
    if (visiting.has(index)) return undefined;
    visiting.add(index);
    const product = imported.products[index];
    const parts: Piece[] = [];
    let complete = product !== undefined;
    for (const solid of product?.solids ?? []) {
      const mass = masses[solid];
      if (mass === null || mass === undefined) complete = false;
      else parts.push(fromExact(mass));
    }
    for (const use of imported.occurrences) {
      if (use.parent !== index) continue;
      const child = pieceOf(use.product);
      if (child === undefined) complete = false;
      else parts.push(placed(child, use.matrix));
    }
    visiting.delete(index);
    const total = complete ? sum(parts) : undefined;
    memo.set(index, total);
    return total;
  };

  return imported.products.map((product, index): ProductVerification => {
    const piece = pieceOf(index);
    const group = matchGroup(product.aliases ?? [product.name], piece?.volume, groups, used);
    if (group !== undefined) used.add(group);
    const diagonal =
      piece === undefined ? 1 : Math.hypot(piece.max[0] - piece.min[0], piece.max[1] - piece.min[1], piece.max[2] - piece.min[2]);
    const receiver: GvpSample | undefined =
      piece === undefined ? undefined : { volume: piece.volume, area: piece.area, centroid: piece.centroid };
    const check: GvpCheck =
      group === undefined || receiver === undefined
        ? { band: 'not-checkable', comparisons: [], policy }
        : compareGvp(group, receiver, diagonal, 1, policy);
    return {
      product: index,
      name: product.name,
      ...(group === undefined ? {} : { embedded: embeddedOf(group) }),
      ...(piece === undefined ? {} : { recomputed: { volume: piece.volume, area: piece.area, centroid: piece.centroid } }),
      check,
    };
  });
}

/** Worst band over the verified products (`not-checkable` when none could be compared). */
export const overallBand = (verifications: readonly ProductVerification[]): GvpCheck['band'] =>
  worstBand(verifications.map((entry) => entry.check.band));
