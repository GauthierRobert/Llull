/**
 * Post-solve cross-check of a free-body (inertial-relief) case (14 FLL-M2b): with a 3-2-1 support the solved reactions must be near zero,
 * since they carry only the residual of the loads. CalculiX prints RF = reaction + the external load of the node, so the deck's own nodal
 * loads at the support nodes (concentrated forces, the consistent share of the body force) are subtracted before the comparison.
 */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { buildDeckContext, loadCasesOf, type DeckContext } from '../decks/context';
import { caseLoads, supportReactionSet, type LoadAccumulator } from '../decks/mechanical';
import { densityToAnalysis } from '../decks/units';

/**
 * Solved reaction (force and moment about the centre of mass) above which a free-body case is flagged, relative to the applied load of the
 * pre-solve balance: 10 x its 1e-4 gate, for the .dat print precision and the CalculiX integration of the body force (the centroid-lumped
 * rotation terms of FLL-D2 differ from the exact I alpha by the element self-inertia, which a coarse mesh shows here).
 */
export const SOLVED_RELIEF_TOLERANCE = 1e-3;

const FLOAT_FLOOR = 1e-12;
const DOF_AXIS: Readonly<Record<string, number>> = { ux: 0, uy: 1, uz: 2 };
/** Consistent nodal share of a uniform body force: linear tetrahedron V/4 per corner; quadratic: -V/20 per corner, V/5 per mid-edge node. */
const SHARES: Readonly<Record<string, readonly number[]>> = {
  C3D4: [0.25, 0.25, 0.25, 0.25],
  C3D10: [-0.05, -0.05, -0.05, -0.05, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
};

export interface AppliedScale {
  readonly appliedForce: number;
  readonly appliedMoment: number;
}

interface SolvedReliefCase {
  readonly loadCase: string;
  readonly appliedForce: number;
  /** max(applied moment, applied force x support spread): a reaction of tolerance x F at the support arm is the moment gate. */
  readonly momentScale: number;
  /** |sum of the support reactions| and |sum of their moments about the centre of mass| (analysis units). */
  readonly reactionForce: number;
  readonly reactionMoment: number;
  readonly balanced: boolean;
}

export interface SolvedRelief {
  readonly cases: readonly SolvedReliefCase[];
  /** Load cases the check could not read (no RF table, a pressure, an element type without consistent shares, a part without material). */
  readonly unassessed: readonly string[];
}

interface Support {
  readonly id: string;
  readonly nodes: readonly number[];
  readonly held: readonly number[];
  readonly point: Vec3;
}

interface Touching {
  readonly entityId: string;
  readonly type: string;
  readonly element: readonly number[];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const ZERO: Vec3 = [0, 0, 0];

/** The free-body supports with nodes in the mesh: their node set, held dofs (0 = x) and mean node position. */
function supportsOf(ctx: DeckContext, coordinates: ReadonlyMap<number, Vec3>): Support[] {
  const supports: Support[] = [];
  for (const id of ctx.analysis.constraintOrder) {
    const constraint = ctx.analysis.constraints[id];
    const nodes = Object.hasOwn(ctx.mesh.nodeSets, `C_${id}`) ? (ctx.mesh.nodeSets[`C_${id}`] ?? []) : [];
    if (constraint?.freeBody !== true || nodes.length === 0) continue;
    const held = Object.keys(constraint.dofs ?? {}).flatMap((dof) => DOF_AXIS[dof] ?? []);
    const point = scale(
      nodes.reduce<Vec3>((sum, node) => add(sum, coordinates.get(node) ?? ZERO), ZERO),
      1 / nodes.length,
    );
    supports.push({ id, nodes, held, point });
  }
  return supports;
}

/** Elements that contain one of `nodes`, with their part and element type. */
function touchingElements(mesh: FeMeshArtifact, nodes: ReadonlySet<number>): Touching[] {
  return mesh.blocks.flatMap((block) =>
    block.elements
      .filter((element) => element.slice(1).some((node) => nodes.has(node)))
      .map((element) => ({ entityId: block.entityId, type: block.type, element })),
  );
}

/** Body-force field (acceleration) the deck applies at `point`: the uniform field, minus alpha x (p - O), plus omega^2 times the distance off the axis. */
function fieldAt(acc: LoadAccumulator, point: Vec3): Vec3 {
  const uniform = (axis: number): number => acc.gravity[axis] ?? 0;
  let field: Vec3 = [uniform(0), uniform(1), uniform(2)];
  for (const { alpha, point: origin } of acc.angular) field = sub(field, cross(alpha, sub(point, origin)));
  for (const { omegaSquared, point: onAxis, axis } of acc.centrifugal) {
    const r = sub(point, onAxis);
    field = add(field, scale(sub(r, scale(axis, dot(r, axis))), omegaSquared));
  }
  return field;
}

/** Consistent body-force load of the elements in `touching` on node `node`, or the reason it cannot be computed. */
function bodyLoadAt(
  ctx: DeckContext,
  acc: LoadAccumulator,
  touching: readonly Touching[],
  coordinates: ReadonlyMap<number, Vec3>,
  node: number,
): Vec3 | string {
  let total: Vec3 = ZERO;
  for (const { entityId, type, element } of touching.filter((entry) => entry.element.indexOf(node, 1) > 0)) {
    const share = SHARES[type]?.[element.indexOf(node, 1) - 1];
    if (share === undefined) return `element type ${type} at a support node has no consistent body-force share here`;
    const material = ctx.materialOf(entityId);
    if (material === null) return `part '${entityId}' has no material`;
    const corner = (index: number): Vec3 => coordinates.get(element[index] ?? 0) ?? ZERO;
    const [a, b, c, d] = [corner(1), corner(2), corner(3), corner(4)];
    const volume = Math.abs(dot(sub(b, a), cross(sub(c, a), sub(d, a)))) / 6;
    const centroid = scale(add(add(a, b), add(c, d)), 1 / 4);
    const density = densityToAnalysis(material.density, ctx.doc.units, ctx.unitSystem);
    total = add(total, scale(fieldAt(acc, centroid), density * volume * share));
  }
  return total;
}

/** Summed RF (fx, fy, fz) printed for `set` at total time `time`, or null when the .dat has no such table. */
function printedReaction(results: FeResultsArtifact, set: string, time: number): Vec3 | null {
  const marker = ` FOR SET ${set} AND TIME`;
  for (const table of results.dat?.tables ?? []) {
    const [fx, fy, fz] = table.rows[0] ?? [];
    if (
      table.title.toLowerCase().startsWith('total force') &&
      table.title.toUpperCase().includes(marker) &&
      Math.abs(table.time - time) <= 1e-9 * Math.max(1, Math.abs(time)) &&
      fx !== undefined &&
      fy !== undefined &&
      fz !== undefined
    )
      return [fx, fy, fz];
  }
  return null;
}

/** Reaction of one support in one case: printed RF minus the nodal loads of its nodes, on its held dofs only; or the reason it is unread. */
function supportReaction(
  ctx: DeckContext,
  acc: LoadAccumulator,
  results: FeResultsArtifact,
  time: number,
  support: Support,
  coordinates: ReadonlyMap<number, Vec3>,
): Vec3 | string {
  const set = supportReactionSet(ctx, support.id);
  const printed = printedReaction(results, set, time);
  if (printed === null) return `no RF total of set ${set} at time ${time} in the .dat (solved before the reaction print: re-solve)`;
  const touching = touchingElements(ctx.mesh, new Set(support.nodes));
  let external: Vec3 = ZERO;
  for (const node of support.nodes) {
    const body = bodyLoadAt(ctx, acc, touching, coordinates, node);
    if (typeof body === 'string') return body;
    const nodal = (dof: number): number => acc.forces.get(`${node}:${dof}`)?.[2] ?? 0;
    external = add(external, add(body, [nodal(1), nodal(2), nodal(3)]));
  }
  const reaction = sub(printed, external);
  const held = (axis: 0 | 1 | 2): number => (support.held.includes(axis) ? reaction[axis] : 0);
  return [held(0), held(1), held(2)];
}

/** Total time CalculiX printed for load case `index` (the last stored increment of step index + 1), or null when the solve has none. */
function caseTime(results: FeResultsArtifact, index: number): number | null {
  const steps = results.steps.filter((step) => step.step === index + 1);
  return steps.at(-1)?.time ?? null;
}

/**
 * Solved reactions of every load case of a free-body analysis against its applied load (`applied`, from the pre-solve balance; a case without
 * one is not assessed here, the pre-solve check already names it). `centre` = centre of mass, analysis units.
 * @invariant reaction = printed RF total of the support set - (CLOAD + consistent body force) of its nodes, held dofs only
 * @invariant balanced = |sum R| <= SOLVED_RELIEF_TOLERANCE x appliedForce and |sum (x - c) x R| <= SOLVED_RELIEF_TOLERANCE x max(appliedMoment,
 *   appliedForce x support spread) (plus a 1e-12 floor): a case with no applied moment still allows the printed RF noise at the support arm
 * @failure no free-body support with nodes in the mesh, or not a static analysis -> null
 */
export function solvedRelief(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  applied: ReadonlyMap<string, AppliedScale>,
  centre: Vec3,
): SolvedRelief | null {
  if (analysis.type !== 'static') return null;
  const base = buildDeckContext(doc, analysis.id, mesh);
  if (base === null) return null;
  const ctx: DeckContext = { ...base, analysis };
  const coordinates = new Map(mesh.nodes.map((node): [number, Vec3] => [node[0], [node[1], node[2], node[3]]]));
  const supports = supportsOf(ctx, coordinates);
  if (supports.length === 0) return null;
  const spread = supports.reduce((far, p) => supports.reduce((most, q) => Math.max(most, norm(sub(p.point, q.point))), far), 0);
  const cases: SolvedReliefCase[] = [];
  const unassessed: string[] = [];
  loadCasesOf(analysis).forEach(({ name }, index) => {
    const scales = applied.get(name);
    if (scales === undefined) return;
    const outcome = assessCase(ctx, results, { name, index }, supports, coordinates, centre);
    if (typeof outcome === 'string') {
      unassessed.push(`load case '${name}': ${outcome}`);
      return;
    }
    const momentScale = Math.max(scales.appliedMoment, scales.appliedForce * spread);
    const noise = FLOAT_FLOOR * (scales.appliedForce + momentScale);
    const balanced =
      outcome.force <= SOLVED_RELIEF_TOLERANCE * scales.appliedForce + noise &&
      outcome.moment <= SOLVED_RELIEF_TOLERANCE * momentScale + noise;
    cases.push({
      loadCase: name,
      reactionForce: outcome.force,
      reactionMoment: outcome.moment,
      appliedForce: scales.appliedForce,
      momentScale,
      balanced,
    });
  });
  return { cases, unassessed };
}

/** Net reaction force and moment about `centre` of one load case, or the reason it cannot be read. */
function assessCase(
  ctx: DeckContext,
  results: FeResultsArtifact,
  { name, index }: { readonly name: string; readonly index: number },
  supports: readonly Support[],
  coordinates: ReadonlyMap<number, Vec3>,
  centre: Vec3,
): { readonly force: number; readonly moment: number } | string {
  const time = caseTime(results, index);
  if (time === null) return `the results have no step ${index + 1}`;
  const acc = caseLoads(ctx, name);
  if ('code' in acc) return acc.message;
  if (acc.pressures.size > 0) return 'a pressure load (its nodal share at the supports is not estimated)';
  let force: Vec3 = ZERO;
  let moment: Vec3 = ZERO;
  for (const support of supports) {
    const reaction = supportReaction(ctx, acc, results, time, support, coordinates);
    if (typeof reaction === 'string') return reaction;
    force = add(force, reaction);
    moment = add(moment, cross(sub(support.point, centre), reaction));
  }
  return { force: norm(force), moment: norm(moment) };
}
