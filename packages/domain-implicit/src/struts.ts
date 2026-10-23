/**
 * Strut lattice cells (05 IMP §5.5): unit-cell nodes and beams in cell units, scaled to the cell size and evaluated through the periodic
 * `strut_set` op. Beams are listed once per cell; their periodic images complete the lattice.
 */

import type { StrutBeam, StrutSet } from '@core/geometry/field/program';
import type { Vec3 } from '@core/model/types';
import type { StrutCell } from './model';

interface CellDefinition {
  readonly nodes: readonly Vec3[];
  readonly bonds: ReadonlyArray<readonly [number, number]>;
}

const H = 0.5;

/** Octahedron / FCC bonds: from each of the 4 lattice nodes of the cell to 6 of its 12 neighbours (24 bonds of a / sqrt 2). */
function octetDefinition(): CellDefinition {
  const bases: Vec3[] = [
    [0, 0, 0],
    [H, H, 0],
    [H, 0, H],
    [0, H, H],
  ];
  const steps: Vec3[] = [
    [H, H, 0],
    [H, -H, 0],
    [H, 0, H],
    [H, 0, -H],
    [0, H, H],
    [0, H, -H],
  ];
  const nodes: Vec3[] = [];
  const bonds: Array<readonly [number, number]> = [];
  for (const base of bases) {
    const from = nodes.length;
    nodes.push(base);
    for (const step of steps) {
      nodes.push([base[0] + step[0], base[1] + step[1], base[2] + step[2]]);
      bonds.push([from, nodes.length - 1]);
    }
  }
  return { nodes, bonds };
}

/** Body-centred cubic: the node at the origin bonded to its 8 body-diagonal neighbours (8 half diagonals per cell). */
function bccDefinition(): CellDefinition {
  const nodes: Vec3[] = [[0, 0, 0]];
  for (const i of [-H, H]) for (const j of [-H, H]) for (const k of [-H, H]) nodes.push([i, j, k]);
  return { nodes, bonds: nodes.slice(1).map((_, index): readonly [number, number] => [0, index + 1]) };
}

const DEFINITIONS: Readonly<Record<StrutCell, CellDefinition>> = {
  cubic: {
    nodes: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    bonds: [
      [0, 1],
      [0, 2],
      [0, 3],
    ],
  },
  bcc: bccDefinition(),
  fcc: {
    nodes: [
      [0, 0, 0],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
    ],
    bonds: [
      [0, 1],
      [2, 3],
      [0, 4],
      [5, 3],
      [0, 6],
      [5, 2],
    ],
  },
  octet: octetDefinition(),
};

/** Length of the bond between nodes a and b. */
function bondLength(nodes: readonly Vec3[], a: number, b: number): number {
  const [p, q] = [nodes[a] as Vec3, nodes[b] as Vec3];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export interface StrutGeometry {
  /** Periodic set for the tape. */
  readonly set: StrutSet;
  /** Beam lengths in the cell (document length units). */
  readonly lengths: readonly number[];
}

/** Beams of `cell` scaled to `cellSize`, all of radius `radius`; `nodeRadius` > radius adds a ball at every node. */
export function strutGeometry(cell: StrutCell, cellSize: Vec3, radius: number, nodeRadius: number | undefined): StrutGeometry {
  const definition = DEFINITIONS[cell];
  const nodes: Vec3[] = definition.nodes.map((n) => [n[0] * cellSize[0], n[1] * cellSize[1], n[2] * cellSize[2]]);
  const beams: StrutBeam[] = definition.bonds.map(([a, b]) => ({ a, b, ra: radius, rb: radius, cap: 'sphere' }));
  const lengths = definition.bonds.map(([a, b]) => bondLength(nodes, a, b));
  if (nodeRadius !== undefined && nodeRadius > radius) {
    const used = new Set(definition.bonds.flatMap(([a, b]) => [a, b]));
    for (const index of used) beams.push({ a: index, b: index, ra: nodeRadius, rb: nodeRadius, cap: 'sphere' });
  }
  return { set: { periodic: { cell: cellSize, origin: [0, 0, 0] }, nodes, beams }, lengths };
}

/** Per-cell bookkeeping used by `lattice_properties`: beams, distinct node classes, valence range, total strut length (cell units). */
export function strutBookkeeping(cell: StrutCell): {
  beams: number;
  nodes: number;
  valenceMin: number;
  valenceMax: number;
  lengthPerCell: number;
} {
  const { nodes, bonds } = DEFINITIONS[cell];
  const classKey = (node: Vec3): string => node.map((c) => (((c % 1) + 1) % 1).toFixed(6)).join(',');
  const valence = new Map<string, number>();
  for (const [a, b] of bonds)
    for (const end of [a, b]) {
      const key = classKey(nodes[end] ?? [0, 0, 0]);
      valence.set(key, (valence.get(key) ?? 0) + 1);
    }
  const counts = [...valence.values()];
  const lengthPerCell = bonds.reduce((sum, [a, b]) => sum + bondLength(nodes, a, b), 0);
  return { beams: bonds.length, nodes: valence.size, valenceMin: Math.min(...counts), valenceMax: Math.max(...counts), lengthPerCell };
}

/** Classification from the literature (Deshpande, Ashby, Fleck 2001): octet stretch-dominated; simple-cubic, BCC and face-cross cells bending-dominated. */
export const KNOWN_CLASS: Readonly<Record<StrutCell, 'stretch' | 'bending'>> = {
  cubic: 'bending',
  bcc: 'bending',
  fcc: 'bending',
  octet: 'stretch',
};
