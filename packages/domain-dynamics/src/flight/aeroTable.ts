/** Aero table of a surface (13 FLT M4): assembly from vortex-lattice rows with the profile-drag model, bilinear lookup, design hash. */

import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { hashText } from '@lib/hash';
import type { AeroTable } from './aeroModel';

/** One vortex-lattice result row (per angle of attack, for one pivot angle). */
export interface LatticeRow {
  readonly alphaDeg: number;
  readonly cl: number;
  readonly cdi: number;
  readonly cm: number;
}

export interface AssembledTable {
  readonly table: AeroTable;
  /** Angle-of-attack range kept after the stall bound (all of the sweep without a clMax). */
  readonly validAlphaDeg: readonly [number, number];
  /** Angles of attack dropped because |CL| exceeded clMax at some pivot angle. */
  readonly droppedAlphaDeg: readonly number[];
}

/**
 * Table from the lattice rows of each pivot angle (`rowsByPivot[p]` over the same ascending angles of attack): CL and Cm as solved,
 * CD = cd0 + CDi (constant profile drag plus the induced drag of the lattice). With `clMax` the run of angles of attack around the one nearest
 * zero where |CL| stays within it at every pivot angle is kept (the inviscid lattice does not model stall); the rest is dropped. Null when fewer
 * than 2 angles of attack remain.
 */
export function assembleTable(
  pivotDeg: readonly number[],
  rowsByPivot: readonly (readonly LatticeRow[])[],
  cd0: number,
  clMax: number | null,
): AssembledTable | null {
  const first = rowsByPivot[0] ?? [];
  const within = first.map((_, a) => clMax === null || rowsByPivot.every((rows) => Math.abs(rows[a]?.cl ?? 0) <= clMax));
  let centre = 0;
  first.forEach((row, a) => {
    if (Math.abs(row.alphaDeg) < Math.abs(first[centre]?.alphaDeg ?? Infinity)) centre = a;
  });
  if (within[centre] !== true) return null;
  let lo = centre;
  let hi = centre;
  while (lo > 0 && within[lo - 1] === true) lo--;
  while (hi < first.length - 1 && within[hi + 1] === true) hi++;
  if (hi - lo < 1) return null;
  const picked = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
  const grid = (pick: (row: LatticeRow) => number): number[][] => picked.map((a) => rowsByPivot.map((rows) => pick(rows[a] as LatticeRow)));
  const alphaDeg = picked.map((a) => (first[a] as LatticeRow).alphaDeg);
  return {
    table: { alphaDeg, pivotDeg, cl: grid((row) => row.cl), cd: grid((row) => cd0 + row.cdi), cm: grid((row) => row.cm) },
    validAlphaDeg: [alphaDeg[0] as number, alphaDeg[alphaDeg.length - 1] as number],
    droppedAlphaDeg: first.map((row) => row.alphaDeg).filter((_, a) => a < lo || a > hi),
  };
}

export interface AeroCoefficients {
  readonly cl: number;
  readonly cd: number;
  readonly cm: number;
  /** The angle of attack or pivot angle was outside the table (held at its edge). */
  readonly outside: boolean;
}

function bracket(axis: readonly number[], x: number): { i: number; t: number; outside: boolean } {
  const last = axis.length - 1;
  const lo = axis[0] ?? 0;
  const hi = axis[last] ?? 0;
  if (last <= 0) return { i: 0, t: 0, outside: x !== lo };
  const clamped = Math.min(hi, Math.max(lo, x));
  let i = 0;
  while (i < last - 1 && (axis[i + 1] ?? hi) <= clamped) i++;
  const a = axis[i] ?? 0;
  const b = axis[i + 1] ?? a;
  return { i, t: b > a ? (clamped - a) / (b - a) : 0, outside: x < lo || x > hi };
}

/** Bilinear lookup of the table at (α, pivot), both deg; held at the edges (`outside`). A one-column table ignores the pivot angle. */
export function lookupAero(table: AeroTable, alphaDeg: number, pivotDeg: number): AeroCoefficients {
  const a = bracket(table.alphaDeg, alphaDeg);
  const p = bracket(table.pivotDeg, pivotDeg);
  const at = (grid: readonly (readonly number[])[]): number => {
    const column = (row: readonly number[]): number => {
      const left = row[p.i] ?? 0;
      return left + ((row[p.i + 1] ?? left) - left) * p.t;
    };
    const v0 = column(grid[a.i] ?? []);
    return v0 + (column(grid[a.i + 1] ?? grid[a.i] ?? []) - v0) * a.t;
  };
  return { cl: at(table.cl), cd: at(table.cd), cm: at(table.cm), outside: a.outside || (table.pivotDeg.length > 1 && p.outside) };
}

/** The part of the document a table depends on: the body record and the entities it is made of (moving or reshaping them stales the table). */
export function aeroDesignHash(doc: CadDocument, bodyId: string, inputsHash: string): string {
  const body = doc.dynamics?.bodies[bodyId];
  const entities = (body?.entityIds ?? []).map((id) => doc.entities[id] ?? null);
  return hashText(`${inputsHash}|${canonicalJson({ body: body ?? null, entities })}`);
}
