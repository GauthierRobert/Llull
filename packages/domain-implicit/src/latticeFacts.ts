/** Facts of strut and TPMS lattice nodes for lattice_properties (05 IMP 5.4, 5.5, FR-IMP-31): bookkeeping, closed forms, Maxwell count, wall / pore measures. */

import { FieldBuilder } from '@core/geometry/field/build';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { CadDocument, Vec3 } from '@core/model/types';
import { meshMeasures } from '@lib/isosurface/measures';
import { type NodeWindow, type ThicknessStats, phaseThickness } from './edt';
import { worldFrame } from './frame';
import type { LawRange } from './lawRange';
import { type FieldNode, type StrutsNode, type TpmsNode, withField } from './model';
import { KNOWN_CLASS, strutBookkeeping, strutGeometry } from './struts';
import { TPMS_FACTS, rectangularCoordinates, tpmsRegisters } from './tpms';
import { compileField } from './compile';

const TOLERANCE = 1e-6;
const MAX_BLOCK = 40;
/** Grid nodes the thickness analysis may use (the transform keeps ~20 bytes per node). */
const EDT_NODES = 2 ** 21;

type Box = { readonly min: Vec3; readonly max: Vec3 };

/** Whole cells per axis when `box` is a block of the lattice (min on the lattice, extents whole cells), else null. */
function wholeBlock(node: StrutsNode, box: Box): [number, number, number] | null {
  const counts = [0, 1, 2].map((axis) => {
    const cell = node.cellSize[axis] as number;
    const extent = ((box.max[axis] as number) - (box.min[axis] as number)) / cell;
    const offset = ((box.min[axis] as number) - (node.origin[axis] as number)) / cell;
    const whole = Math.abs(extent - Math.round(extent)) < TOLERANCE && Math.abs(offset - Math.round(offset)) < TOLERANCE;
    return whole ? Math.round(extent) : NaN;
  });
  return counts.every((c) => c >= 1 && c <= MAX_BLOCK) && node.rotation.every((r) => r === 0) ? (counts as [number, number, number]) : null;
}

/** Nodes and beams (both ends inside the closed block) of an aligned block of `counts` cells, in cell units. */
function blockCounts(node: StrutsNode, counts: readonly [number, number, number]): { nodes: number; beams: number } {
  const { set } = strutGeometry(node.cell, [1, 1, 1], 1, undefined);
  const inside = (p: Vec3): boolean => p.every((c, axis) => c > -TOLERANCE && c < (counts[axis] as number) + TOLERANCE);
  const key = (p: Vec3): string => p.map((c) => Math.round(c * 1e6)).join(',');
  const nodes = new Set<string>();
  const beams = new Set<string>();
  for (let i = 0; i <= counts[0]; i += 1)
    for (let j = 0; j <= counts[1]; j += 1)
      for (let k = 0; k <= counts[2]; k += 1)
        for (const beam of set.beams) {
          const [a, b] = [set.nodes[beam.a], set.nodes[beam.b]];
          if (a === undefined || b === undefined) continue;
          const [pa, pb]: [Vec3, Vec3] = [
            [a[0] + i, a[1] + j, a[2] + k],
            [b[0] + i, b[1] + j, b[2] + k],
          ];
          if (!inside(pa) || !inside(pb)) continue;
          nodes.add(key(pa));
          nodes.add(key(pb));
          beams.add([key(pa), key(pb)].sort().join('|'));
        }
  return { nodes: nodes.size, beams: beams.size };
}

/** Bookkeeping and closed forms of a periodic strut lattice; `radius` is the range of the strut radius over the lattice. */
export function strutFacts(node: StrutsNode, box: Box | null, radius: LawRange): Record<string, unknown> {
  const book = strutBookkeeping(node.cell);
  const [ax, ay, az] = node.cellSize;
  const cellVolume = ax * ay * az;
  const lengths = strutGeometry(node.cell, node.cellSize, 1, undefined).lengths;
  const lengthPerCell = lengths.reduce((a, b) => a + b, 0);
  const block = box === null ? null : wholeBlock(node, box);
  const cells = box === null ? null : ((box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2])) / cellVolume;
  const counted = block === null ? null : blockCounts(node, block);
  const rho1 = (r: number): number => (Math.PI * r ** 2 * lengthPerCell) / cellVolume;
  const longest = Math.max(...lengths);
  const maxwell = book.beams - 3 * book.nodes + 6;
  return {
    cell: node.cell,
    cellSize: node.cellSize,
    cells: block === null ? cells : block[0] * block[1] * block[2],
    cellsExact: block !== null,
    beamsPerCell: book.beams,
    nodesPerCell: book.nodes,
    nodes: counted?.nodes ?? (cells === null ? null : book.nodes * cells),
    beams: counted?.beams ?? (cells === null ? null : book.beams * cells),
    countsExact: counted !== null,
    totalLength: cells === null ? null : lengthPerCell * cells,
    lengthPerCell,
    radiusMin: radius.min,
    radiusMax: Math.max(radius.max, node.nodeRadius ?? 0),
    radiusGraded: !radius.constant,
    slendernessMax: radius.min > 0 ? longest / (2 * radius.min) : null,
    valence: { min: book.valenceMin, max: book.valenceMax },
    rho1: radius.constant ? rho1(radius.min) : null,
    rho1Range: radius.constant ? null : { min: rho1(radius.min), max: rho1(radius.max) },
    maxwell: {
      b: book.beams,
      j: book.nodes,
      M: maxwell,
      class: KNOWN_CLASS[node.cell],
      basis:
        node.cell === 'cubic' || node.cell === 'bcc' || node.cell === 'fcc' || node.cell === 'octet'
          ? 'class from the literature (Deshpande, Ashby, Fleck 2001); M = b - 3j + 6 is a necessary condition only'
          : 'class assigned by llull (no literature class pinned): none of these cells is a rigid triangulated frame; M = b - 3j + 6 is a necessary condition only',
    },
  };
}

/** The lattice node without region, map and rotation, as a stand-alone node `__cell` (one unrotated rectangular cell at its origin). */
export function bareCell(doc: CadDocument, node: FieldNode & { op: 'tpms' | 'struts' }): ReturnType<typeof compileField> {
  const bare: FieldNode =
    node.op === 'tpms'
      ? (({ region: clipped, map: wrapped, ...rest }) => (
          void clipped,
          void wrapped,
          { ...rest, rotation: [0, 0, 0] as Vec3, id: '__cell' }
        ))(node)
      : (({ region: clipped, ...rest }) => (void clipped, { ...rest, rotation: [0, 0, 0] as Vec3, id: '__cell' }))(node);
  return compileField(withField(doc, bare), '__cell');
}

/** Nodes per cell edge of the thickness analysis for a 2 x 2 x 2 block under the engine's budget (never above `wanted`). */
function cellNodes(engine: FieldEngine, wanted: number): number {
  const budget = Math.min(engine.limits.maxSamples, EDT_NODES);
  return Math.max(8, Math.min(wanted, Math.floor(Math.cbrt(budget) / 2) - 1));
}

export interface PhaseMeasures {
  readonly wall: ThicknessStats | null;
  readonly pore: ThicknessStats | null;
  readonly voxel: number;
  readonly note: string | null;
}

/**
 * Wall and pore thickness of one unrotated TPMS cell from the sign grid of a 2 x 2 x 2 block (the central half-offset cell is read, so the periodic neighbours
 * are present): thickness = 2 d h - h on the medial set (edt.ts), accurate to about +-2.5 voxels.
 */
export function cellPhaseMeasures(engine: FieldEngine, program: FieldProgram, node: TpmsNode, resolution: number): PhaseMeasures {
  const cell = node.cellSize;
  const voxel = Math.min(...cell) / cellNodes(engine, resolution);
  const box = { min: node.origin, max: [node.origin[0] + 2 * cell[0], node.origin[1] + 2 * cell[1], node.origin[2] + 2 * cell[2]] as Vec3 };
  const answer = engine.measure(program, { ...box, voxel }, null, { kind: 'nodes' });
  if (!answer.ok || answer.kind !== 'nodes')
    return { wall: null, pore: null, voxel, note: answer.ok ? 'unexpected answer' : answer.message };
  const perCell = cell.map((c) => c / voxel);
  const window: NodeWindow = {
    lo: [Math.ceil((perCell[0] as number) / 2), Math.ceil((perCell[1] as number) / 2), Math.ceil((perCell[2] as number) / 2)],
    hi: [
      Math.floor((3 * (perCell[0] as number)) / 2),
      Math.floor((3 * (perCell[1] as number)) / 2),
      Math.floor((3 * (perCell[2] as number)) / 2),
    ],
  };
  const inside = answer.inside;
  const pore = Uint8Array.from(inside, (v) => (v === 1 ? 0 : 1));
  return {
    wall: phaseThickness(inside, answer.nodes, voxel, window),
    pore: phaseThickness(pore, answer.nodes, voxel, window),
    voxel,
    note: null,
  };
}

/** Facts of a TPMS node: control, wall range, specific surface (table or measured mesh area of the nodal surface of one cell), wall and pore thickness. */
export function tpmsFacts(
  node: TpmsNode,
  value: LawRange,
  surface: { readonly perVolume: number; readonly source: string },
  phases: PhaseMeasures | null,
): Record<string, unknown> {
  const facts = TPMS_FACTS[node.kind];
  const smallest = Math.min(...node.cellSize);
  const thickness =
    node.form === 'network'
      ? null
      : node.normalize === 'gradient'
        ? { min: value.min, max: value.max }
        : {
            min: (2 * value.min) / ((2 * Math.PI * facts.gradOnSurface[1]) / smallest),
            max: (2 * value.max) / ((2 * Math.PI * facts.gradOnSurface[0]) / smallest),
          };
  return {
    kind: node.kind,
    form: node.form,
    cellSize: node.cellSize,
    control: node.control,
    controlRange: { min: value.min, max: value.max, graded: !value.constant },
    normalized: node.normalize === 'gradient',
    relativeDensityTarget: node.relativeDensityTarget ?? null,
    thicknessMin: thickness?.min ?? null,
    thicknessMax: thickness?.max ?? null,
    specificSurface: surface.perVolume * (node.form === 'sheet' ? 2 : 1),
    specificSurfaceNote: `nodal-surface area per cell volume (${surface.source}), doubled for a sheet (two faces); first order in the wall thickness`,
    wallThicknessMeasured: phases?.wall?.min ?? null,
    wallThicknessMaxMeasured: phases?.wall?.max ?? null,
    poreDiameterMax: phases?.pore?.max ?? null,
    poreDiameterMin: phases?.pore?.min ?? null,
    thicknessResolution: phases === null ? null : phases.voxel,
    notComputed: phases === null || phases.note !== null ? ['wallThicknessMeasured', 'poreDiameterMax'] : [],
    thicknessNote: phases?.note ?? null,
  };
}

/** Area of the nodal surface (F = 0 for a network at level 0 is not used: the surface of `program` itself) per cell volume, by mesh area of one cell at `cells` voxels per edge. */
export function measuredSpecificSurface(
  engine: FieldEngine,
  nodalProgram: Parameters<FieldEngine['mesh']>[0],
  cell: Vec3,
  cells: number,
): number | null {
  const voxel = Math.min(...cell) / cells;
  const result = engine.mesh(nodalProgram, { min: [0, 0, 0], max: cell, voxel }, { mesher: 'tetra', maxTriangles: 2_000_000 });
  if (!result.ok) return null;
  return meshMeasures(result.mesh).area / (cell[0] * cell[1] * cell[2]);
}

/** Program whose negative side is {F < 0} of the TPMS family of `node` on its rectangular cells (the nodal surface F = 0). */
export function nodalSurfaceProgram(node: TpmsNode): FieldProgram {
  const b = new FieldBuilder('mm');
  const { field } = tpmsRegisters(b, node.kind, rectangularCoordinates(b, node.cellSize, worldFrame(b)));
  return b.finish(field, { bounds: null, lipschitz: 1, quality: 'approximate' });
}
