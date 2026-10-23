/**
 * probe_fillet (BLD M0, TECHNICAL_SPEC §4): the largest constant radius each edge accepts, found by bisection on exact kernel evaluations, so an
 * agent picks a radius that builds instead of guessing and reading a refusal.
 */

import { bisectLargestRadius } from '../../geometry/blend/probe';
import { diagnoseBlend } from '../../geometry/blend/diagnose';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import { operandRecipe } from '../../geometry/operandRecipe';
import { round6 } from '../../lib/compactNumber';
import type { ShapeRecipe } from '../../model/types';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { noop, report, tableRejection } from '../noop';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { diagonalOf } from './shapeDiagonal';
import { pickEdges } from './edgeReferences';
import { validateSolidTarget } from './modifyTarget';

const DEFAULT_EVALUATIONS = 12;
/** Probe edges per call: each costs up to `maxEvaluations` exact fillets. */
const MAX_EDGES = 32;
/** Fraction of the bounding-box diagonal at which the bisection stops. */
const TOLERANCE_FRACTION = 1e-3;

const refuse = tableRejection({
  BLD_EDGE_NOT_FOUND:
    'inspect_topology lists the edges, their indices and names; pass edgeIndices, edgesNear or edgeNames that select a roundable edge',
});

/** First guess of the limit: the mean width of the faces next to `edge` across it (face area / edge length); the probe grows past it while it builds. */
function upperBoundOf(topology: ShapeTopology, faces: readonly number[], edge: number): number {
  const length = topology.edges[edge]?.length ?? 0;
  const widths = faces.map((face) => (topology.faces[face]?.area ?? 0) / length).filter((width) => Number.isFinite(width) && width > 0);
  return widths.length === 0 ? length : Math.min(...widths);
}

interface EdgeProbe {
  readonly index: number;
  readonly name?: string;
  readonly maxRadius: number;
  readonly upperBound: number;
  readonly limitingCode: string | null;
  readonly evaluations: number;
}

function probeEdge(
  kernel: GeometryKernel,
  source: ShapeRecipe,
  topology: ShapeTopology,
  faces: readonly number[],
  index: number,
  toleranceOf: (upperBound: number) => number,
  cap: number,
  maxEvaluations: number,
): EdgeProbe {
  const upperBound = upperBoundOf(topology, faces, index);
  const tolerance = toleranceOf(upperBound);
  const near = topology.edges[index]?.mid;
  const recipeAt = (radius: number): ShapeRecipe => ({
    op: 'fillet',
    source,
    edges: [index],
    size: radius,
    ...(near === undefined ? {} : { near: [near] }),
  });
  const outcome = bisectLargestRadius(
    (radius) => kernel.evaluate(recipeAt(radius)) !== null,
    upperBound,
    tolerance,
    maxEvaluations,
    Math.max(cap, upperBound),
  );
  let limitingCode: string | null = null;
  if (outcome.refusedAt !== undefined) {
    const blendReport = kernel.blendReport?.(recipeAt(outcome.refusedAt));
    limitingCode = (blendReport === null || blendReport === undefined ? null : diagnoseBlend(blendReport)?.code) ?? 'BLD_RADIUS_TOO_LARGE';
  }
  const name = topology.edges[index]?.name;
  return {
    index,
    ...(name === undefined ? {} : { name }),
    maxRadius: round6(outcome.maxRadius),
    upperBound: round6(upperBound),
    limitingCode,
    evaluations: outcome.evaluations,
  };
}

/**
 * @affects none; data = { id, edges [{ index, name?, maxRadius, upperBound, limitingCode, evaluations }], tolerance { name, value, unit, defaulted, source }, maxEvaluations, unit }
 * @invariant each edge is probed ALONE with a constant radius; maxRadius builds (an evaluation says so), within `tolerance` of the true limit when evaluations suffice; the search grows past the first guess (mean face width) up to the bounding-box diagonal; limitingCode null = no radius up to that cap (or within the evaluation budget) was refused
 * @failure missing id / 2D / instance, no kernel, kernel without fillet, unbuildable operand, selection resolves to no roundable edge (BLD_EDGE_NOT_FOUND), more than 32 edges, tolerance <= 0 or maxEvaluations < 1 -> unchanged doc, no data
 */
export const probeFillet = defineCommand({
  name: 'probe_fillet',
  annotations: { readOnly: true, idempotent: true, requiresKernel: true },
  description:
    'Largest constant fillet radius each edge of a 3D solid accepts, measured by bisection on exact kernel evaluations (each edge probed alone with fillet_edge semantics, ' +
    'results cached by the kernel). Use it BEFORE fillet_edge: pick a radius below maxRadius. Select edges like fillet_edge (edgeIndices from inspect_topology, edgesNear points, ' +
    'or edgeNames); with none, every roundable edge up to 32. Returns per edge: maxRadius (largest radius that builds, document units), upperBound (first guess: mean width of the adjacent faces across the edge; the search grows beyond it ' +
    'while it builds, up to the bounding-box diagonal), limitingCode (the BLD_* code of the first refused radius, e.g. BLD_RADIUS_TOO_LARGE, or null when nothing up to the diagonal was refused) and the number of exact evaluations. ' +
    'Interactions between several rounded edges are not probed: round them together and read the refusal code. Needs the exact kernel (check kernel_info). Does not modify the document.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid entity to probe.'),
    edgeIndices: z
      .array(z.number().int().nonnegative())
      .describe('0-based unique-edge indices from inspect_topology. Omit (with no edgesNear / edgeNames) to probe every roundable edge.')
      .optional(),
    edgesNear: z
      .array(vec3('A point [x, y, z] in document units on or near the edge (the roundable edge nearest to it is probed).'))
      .describe('Select edges by location, as in fillet_edge.')
      .optional(),
    edgeNames: z
      .array(z.string().min(1))
      .describe('Persistent edge names (inspect_topology lists them on the native kernel); win over edgeIndices / edgesNear.')
      .optional(),
    tolerance: z
      .number()
      .describe(
        'Stop the bisection when the bracket is smaller than this, in document units (> 0). Default 1e-3 x the bounding-box diagonal (1e-3 x the first guess when the diagonal is unknown).',
      )
      .optional(),
    maxEvaluations: z.number().int().describe(`Exact fillet evaluations per edge (>= 1). Default ${DEFAULT_EVALUATIONS}.`).optional(),
  }),
  run: (doc, { id, edgeIndices = [], edgesNear = [], edgeNames, tolerance, maxEvaluations = DEFAULT_EVALUATIONS }, ctx): CommandResult => {
    if (tolerance !== undefined && !(tolerance > 0)) return noop(doc, `probe_fillet: tolerance must be > 0 (got ${tolerance}); no-op.`);
    if (maxEvaluations < 1) return noop(doc, `probe_fillet: maxEvaluations must be >= 1 (got ${maxEvaluations}); no-op.`);
    const validation = validateSolidTarget(doc, 'probe_fillet', id);
    if ('summary' in validation) return validation;
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('probe_fillet'));
    if (!kernel.supports('fillet'))
      return noop(doc, 'probe_fillet: this kernel cannot fillet (use the native exact kernel, see kernel_info); no-op.');
    const source = operandRecipe(kernel, validation.entity);
    const shape = kernel.evaluate(source);
    if (shape === null) return noop(doc, `probe_fillet: kernel could not build entity '${id}'; no-op.`);
    const topology = kernel.topology(shape);
    if (topology === null) return noop(doc, `probe_fillet: '${id}' has no exact topology on this kernel; no-op.`);
    const picked = pickEdges(topology, { indices: edgeIndices, near: edgesNear, names: edgeNames });
    if ('problem' in picked)
      return picked.error !== undefined
        ? { ...noop(doc, `probe_fillet: ${picked.problem}`), rejected: true, error: picked.error }
        : refuse(doc, 'probe_fillet', 'BLD_EDGE_NOT_FOUND', `${picked.problem} on '${id}'`, [id], ['edgesNear']);
    const roundable = (index: number): boolean => topology.edges[index]?.seam === false && topology.edges[index]?.degenerate === false;
    const chosen = (picked.edges.length === 0 ? topology.edges.map((edge) => edge.index) : picked.edges).filter(roundable);
    if (chosen.length === 0)
      return refuse(doc, 'probe_fillet', 'BLD_EDGE_NOT_FOUND', `'${id}' has no roundable edge`, [id], ['edgeIndices']);
    if (chosen.length > MAX_EDGES)
      return noop(
        doc,
        `probe_fillet: ${chosen.length} edges selected, at most ${MAX_EDGES} per call; select fewer with edgeIndices; no-op.`,
      );
    const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
    const diagonal = diagonalOf(kernel, shape);
    const toleranceOf = (upperBound: number): number => tolerance ?? TOLERANCE_FRACTION * (diagonal > 0 ? diagonal : upperBound);
    const edges = chosen.map((index) =>
      probeEdge(kernel, source, topology, graph?.edgeFaces[index] ?? [], index, toleranceOf, diagonal, maxEvaluations),
    );
    const limit = toleranceOf(edges[0]?.upperBound ?? 0);
    const lines = edges.map(
      (edge) =>
        `edge ${edge.index}${edge.name === undefined ? '' : ` (${edge.name})`}: max radius ${edge.maxRadius} ${doc.units} (bound ${edge.upperBound}, ${edge.limitingCode ?? 'bound builds'}, ${edge.evaluations} evals)`,
    );
    return report(doc, `probe_fillet: '${id}' — ${lines.join('; ')}. Pick a radius below maxRadius.`, {
      id,
      edges,
      tolerance: {
        name: 'probeTolerance',
        value: round6(limit),
        unit: doc.units,
        defaulted: tolerance === undefined,
        source: 'llull choice: 1e-3 x bounding-box diagonal',
      },
      maxEvaluations,
      unit: doc.units,
    });
  },
});
