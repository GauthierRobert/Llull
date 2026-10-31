/**
 * The crease spoke of a corner star (DES-6c 13.33): where an edge of the part is left sharp at a setback corner it enters the hole, and the star continues it as an edge between two sub-patches
 * that leaves the entry point at the dihedral angle of the part and fades to nothing at the pole. Such an edge is not a tangent contact; it is judged by that shape.
 * @invariant pure over a topology, its face graph and the kernel's continuity samples of the edge; the spoke is recognised by its two corner-patch faces and an end on a sharp edge of the part
 *   (two faces that are neither blends nor patches), never by its angle alone: a large angle anywhere else stays a G1 failure
 * @failure no sharp edge at the large end, or no kernel reading of it -> null (the edge is judged as an ordinary contact)
 */

import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { ShapeHandle } from '../../geometry/kernelTypes';
import type { FaceGraph } from '../../geometry/kernelPorts';
import { cornerSources, measureContact, type ContactSample } from '../../geometry/blend/continuity';
import { roundSignificant } from '../../lib/significant';
import { REMEDIATION, type Finding, type Tolerances } from './checkBlendFindings';

/** Below this angle (radians) at both ends an edge between two sub-patches is an ordinary tangent spoke, not a crease. */
const CREASE_MIN_RAD = 0.1;
/** How far the angle at the entry point may differ from the dihedral angle of the sharp edge (radians). */
export const DIHEDRAL_MATCH_RAD = 0.02;
/** The angle along the spoke may rise by this much (radians) between two samples before it counts as not fading. */
const FADE_SLACK_RAD = 0.02;

export interface CreaseSpoke {
  /** The sharp edge of the part this spoke continues. */
  readonly sharpEdge: number;
  /** The angle between the normals of its two sides at the entry point, and the dihedral angle of the sharp edge there. */
  readonly entryRad: number;
  readonly dihedralRad: number;
  /** The angle at the pole end. */
  readonly poleRad: number;
  /** The angle never rises along the spoke from the entry point to the pole (beyond the slack). */
  readonly fades: boolean;
}

const isSharpFace = (topology: ShapeTopology, face: number): boolean => topology.faces[face]?.name?.startsWith('blend(') !== true;

/**
 * The crease reading of `edge` (its `measured` samples, start to end), or null when it is not the spoke of a star that continues a sharp edge.
 * @param measure the kernel's edge continuity of another edge (the sharp edge), at a few samples
 */
export function creaseSpoke(
  topology: ShapeTopology,
  graph: FaceGraph,
  edge: number,
  measured: readonly ContactSample[],
  measure: (edge: number) => readonly ContactSample[] | null,
): CreaseSpoke | null {
  const around = graph.edgeFaces[edge] ?? [];
  if (around.length !== 2 || around.some((face) => cornerSources(topology.faces[face]?.name ?? '') === null)) return null;
  const first = measured[0]?.g1 ?? 0;
  const last = measured[measured.length - 1]?.g1 ?? 0;
  if (Math.max(first, last) <= CREASE_MIN_RAD) return null;
  const atStart = first >= last;
  const own = topology.edges[edge];
  if (own === undefined) return null;
  const entry = atStart ? own.start : own.end;
  const scale = 1e-7 * Math.max(1, own.length);
  const found = topology.edges.find(
    (candidate) =>
      candidate.index !== edge &&
      (graph.edgeFaces[candidate.index] ?? []).length === 2 &&
      (graph.edgeFaces[candidate.index] ?? []).every((face) => isSharpFace(topology, face)) &&
      [candidate.start, candidate.end].some((end) => Math.hypot(end[0] - entry[0], end[1] - entry[1], end[2] - entry[2]) <= scale),
  );
  if (found === undefined) return null;
  const sharp = measure(found.index);
  if (sharp === null || sharp.length === 0) return null;
  const sharpAtStart = Math.hypot(found.start[0] - entry[0], found.start[1] - entry[1], found.start[2] - entry[2]) <= scale;
  const dihedral = (sharpAtStart ? sharp[0] : sharp[sharp.length - 1])?.g1 ?? 0;
  const ordered = atStart ? measured : [...measured].reverse();
  let fades = true;
  for (let at = 1; at < ordered.length; at++) if ((ordered[at]?.g1 ?? 0) > (ordered[at - 1]?.g1 ?? 0) + FADE_SLACK_RAD) fades = false;
  return { sharpEdge: found.index, entryRad: atStart ? first : last, dihedralRad: dihedral, poleRad: atStart ? last : first, fades };
}

export interface CreaseRow {
  readonly contact: {
    readonly edge: number;
    readonly name?: string;
    readonly g0Gap: number;
    readonly g1AngleRad: number;
    readonly creaseRad: number;
    readonly g2Gap: number;
    readonly g2Rel: number;
    readonly order: 'crease';
  };
  readonly findings: Finding[];
}

const sig = (value: number): number => roundSignificant(value, 10);

/**
 * The contact row and findings of a crease spoke: G0 against the tolerance like any contact; the angle at the entry point must equal the dihedral of the sharp edge it continues
 * (`BLD_CHECK_G1_ANGLE`, fail), must not rise along the spoke (fail) and must be gone at the pole (warn, like the end points of any corner contact). `g1AngleRad` of the row is the pole reading.
 */
export function judgeCrease(
  spoke: CreaseSpoke,
  measured: readonly ContactSample[],
  at: { readonly entityId: string; readonly face: number; readonly edge: number; readonly name: string | undefined; readonly unit: string },
  tolerances: Tolerances,
): CreaseRow {
  const gap = measureContact(
    measured.map((sample) => ({ ...sample, g1: 0 })),
    tolerances,
  );
  const g0Gap = gap?.g0Gap ?? 0;
  const findings: Finding[] = [];
  const raise = (severity: 'fail' | 'warn', value: number, limit: number, message: string): void => {
    findings.push({
      entityId: at.entityId,
      face: at.face,
      edge: at.edge,
      code: 'BLD_CHECK_G1_ANGLE',
      severity,
      value: sig(value),
      limit: sig(limit),
      unit: 'rad',
      remediation: REMEDIATION.BLD_CHECK_G1_ANGLE,
      message,
    });
  };
  if (g0Gap > tolerances.g0)
    findings.push({
      entityId: at.entityId,
      face: at.face,
      edge: at.edge,
      code: 'BLD_CHECK_G0_GAP',
      severity: 'fail',
      value: sig(g0Gap),
      limit: sig(tolerances.g0),
      unit: at.unit,
      remediation: REMEDIATION.BLD_CHECK_G0_GAP,
      message: `the two sub-patches of a corner star are ${sig(g0Gap)} ${at.unit} apart along their crease spoke, edge ${at.edge}`,
    });
  if (Math.abs(spoke.entryRad - spoke.dihedralRad) > DIHEDRAL_MATCH_RAD)
    raise(
      'fail',
      spoke.entryRad,
      spoke.dihedralRad,
      `the crease spoke edge ${at.edge} leaves the sharp edge ${spoke.sharpEdge} at ${sig(spoke.entryRad)} rad, not at its dihedral angle ${sig(spoke.dihedralRad)} rad`,
    );
  if (!spoke.fades)
    raise(
      'fail',
      spoke.entryRad,
      spoke.dihedralRad,
      `the crease of spoke edge ${at.edge} does not fade monotonically from the sharp edge ${spoke.sharpEdge} to the pole`,
    );
  if (spoke.poleRad > tolerances.g1AngleRad)
    raise(
      'warn',
      spoke.poleRad,
      tolerances.g1AngleRad,
      `the crease of spoke edge ${at.edge} is still ${sig(spoke.poleRad)} rad at the pole of the corner star`,
    );
  return {
    contact: {
      edge: at.edge,
      ...(at.name === undefined ? {} : { name: at.name }),
      g0Gap: sig(g0Gap),
      g1AngleRad: sig(spoke.poleRad),
      creaseRad: sig(spoke.dihedralRad),
      g2Gap: 0,
      g2Rel: 0,
      order: 'crease',
    },
    findings,
  };
}

/** What `creaseRowOf` needs of the check: the kernel and the shape it measures, the topology and face graph, and where the findings go. */
export interface CreaseWorld {
  readonly kernel: GeometryKernel;
  readonly shape: ShapeHandle;
  readonly topology: ShapeTopology;
  readonly graph: FaceGraph;
  readonly entityId: string;
  readonly unit: string;
}

/** The crease row of `edge` of corner-patch face `face` (its `measured` samples) when it is the spoke of a star that continues a sharp edge of the part, else null. */
export function creaseRowOf(
  world: CreaseWorld,
  measured: readonly ContactSample[],
  face: number,
  edge: number,
  tolerances: Tolerances,
): CreaseRow | null {
  const { kernel, shape, topology, graph, entityId, unit } = world;
  const spoke = creaseSpoke(topology, graph, edge, measured, (other) => kernel.faceQuery?.edgeContinuity(shape, other, 3) ?? null);
  return spoke === null ? null : judgeCrease(spoke, measured, { entityId, face, edge, name: topology.edges[edge]?.name, unit }, tolerances);
}
