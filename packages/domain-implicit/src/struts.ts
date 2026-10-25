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

const FCC_BASES: readonly Vec3[] = [
  [0, 0, 0],
  [H, H, 0],
  [H, 0, H],
  [0, H, H],
];

/**
 * Periodic bonds of the nodes `base` (cell units, inside the unit cell): every pair at distance `length` over the 27 neighbouring cells, each undirected
 * periodic pair once; the far end of a bond that leaves the cell is added as an image node.
 */
function periodicBonds(base: readonly Vec3[], length: number): CellDefinition {
  const nodes: Vec3[] = [...base];
  const bonds: Array<readonly [number, number]> = [];
  const seen = new Set<string>();
  const imageOf = new Map<string, number>();
  const locate = (p: Vec3): number => {
    const key = p.map((c) => c.toFixed(9)).join(',');
    const known = imageOf.get(key);
    if (known !== undefined) return known;
    const direct = nodes.findIndex((n) => n.every((c, axis) => Math.abs(c - (p[axis] as number)) < 1e-9));
    const index = direct >= 0 ? direct : nodes.push(p) - 1;
    imageOf.set(key, index);
    return index;
  };
  base.forEach((from, i) => {
    base.forEach((to, j) => {
      for (const di of [-1, 0, 1])
        for (const dj of [-1, 0, 1])
          for (const dk of [-1, 0, 1]) {
            const image: Vec3 = [to[0] + di, to[1] + dj, to[2] + dk];
            if (Math.abs(Math.hypot(image[0] - from[0], image[1] - from[1], image[2] - from[2]) - length) > 1e-9) continue;
            const forward = `${i}|${j}|${di},${dj},${dk}`;
            const backward = `${j}|${i}|${-di},${-dj},${-dk}`;
            if (seen.has(backward)) continue;
            seen.add(forward);
            bonds.push([i, locate(image)]);
          }
    });
  });
  return { nodes, bonds };
}

/** Diamond cubic: the FCC nodes and the same shifted by (1/4, 1/4, 1/4), each bonded to its 4 nearest (16 bonds of sqrt 3 / 4 per cell). */
function diamondDefinition(): CellDefinition {
  const shifted = FCC_BASES.map((p): Vec3 => [p[0] + 0.25, p[1] + 0.25, p[2] + 0.25]);
  return periodicBonds([...FCC_BASES, ...shifted], Math.sqrt(3) / 4);
}

/** Kelvin cell (bitruncated cubic honeycomb): the 12 vertices that are the permutations of (0, +-1/4, 1/2) modulo the cell, bonds of sqrt 2 / 4 (24 per cell, valence 4). */
function kelvinDefinition(): CellDefinition {
  const base: Vec3[] = [];
  for (const q of [0.25, 0.75])
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ] as const) {
      const values = [0, q, 0.5];
      base.push([values[order[0]] as number, values[order[1]] as number, values[order[2]] as number]);
    }
  return periodicBonds(base, Math.SQRT2 / 4);
}

/** Re-entrant (auxetic) cell as defined by llull: the cell corners and six face nodes pushed a quarter cell inward, each bonded to the 4 corners of its face (24 struts of 0.75 a). */
function reentrantDefinition(): CellDefinition {
  const corners: Vec3[] = [];
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) corners.push([i, j, k]);
  const cornerAt = (p: Vec3): number => corners.findIndex((c) => c.every((v, axis) => v === p[axis]));
  const nodes: Vec3[] = [...corners];
  const bonds: Array<readonly [number, number]> = [];
  for (const axis of [0, 1, 2] as const)
    for (const side of [0, 1]) {
      const face: [number, number, number] = [H, H, H];
      face[axis] = side === 0 ? 0.25 : 0.75;
      nodes.push(face);
      const faceIndex = nodes.length - 1;
      for (const a of [0, 1])
        for (const b of [0, 1]) {
          const corner: [number, number, number] = [0, 0, 0];
          corner[axis] = side;
          corner[(axis + 1) % 3] = a;
          corner[(axis + 2) % 3] = b;
          bonds.push([faceIndex, cornerAt(corner)]);
        }
    }
  return { nodes, bonds };
}

/** `definition` plus the vertical z edge of the cell (node (0,0,0) to (0,0,1)). */
function withZEdge(definition: CellDefinition, origin: number): CellDefinition {
  const nodes: Vec3[] = [...definition.nodes];
  const top = nodes.findIndex((n) => n[0] === 0 && n[1] === 0 && n[2] === 1);
  const index = top >= 0 ? top : nodes.push([0, 0, 1]) - 1;
  return { nodes, bonds: [...definition.bonds, [origin, index]] };
}

const FCC_DEFINITION: CellDefinition = {
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
};

const DEFINITIONS: Readonly<Record<StrutCell, CellDefinition>> = {
  diamond: diamondDefinition(),
  kelvin: kelvinDefinition(),
  reentrant: reentrantDefinition(),
  bccz: withZEdge(bccDefinition(), 0),
  fccz: withZEdge(FCC_DEFINITION, 0),
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
  fcc: FCC_DEFINITION,
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

/**
 * Classification: octet stretch-dominated; simple-cubic, BCC and face-cross cells bending-dominated (Deshpande, Ashby, Fleck 2001). The five cells added in M5
 * (diamond, Kelvin, BCCZ, FCCZ, re-entrant) are classed bending-dominated because none is a rigid triangulated frame; no literature class is pinned for them
 * and the Maxwell count of a single periodic cell is a necessary condition only.
 */
export const KNOWN_CLASS: Readonly<Record<StrutCell, 'stretch' | 'bending'>> = {
  cubic: 'bending',
  bcc: 'bending',
  fcc: 'bending',
  octet: 'stretch',
  diamond: 'bending',
  kelvin: 'bending',
  bccz: 'bending',
  fccz: 'bending',
  reentrant: 'bending',
};
