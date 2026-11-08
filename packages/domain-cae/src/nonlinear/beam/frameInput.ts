/** BeamFrameInput (PHY-05 §3) -> corotational frame model: validation with named problems, subdivision of members, supports and reference load. */

import { z } from '@core/commands/schema';
import { frameModel, type FrameElement, type FrameModel } from './frameModel';

/** Element i of a numeric array; 0 for an index past the end (noUncheckedIndexedAccess identity, never an engineering default). */
const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

/** Most elements of one frame, and the work cap maxSteps x free dofs x (bandwidth + 1)^2 (measured about 0.1 s per 1e6: a query answers in seconds, AF-40). */
const MAX_ELEMENTS = 4000;
const WORK_BUDGET = 2e8;

const DOFS = ['ux', 'uy', 'rz'] as const;
type Dof = (typeof DOFS)[number];
export const DOF_OFFSET: Readonly<Record<Dof, number>> = { ux: 0, uy: 1, rz: 2 };

const nodeRef = z.string().describe('Id of a node of nodes[].');
const finite = (text: string): z.ZodNumber => z.number().describe(text);

export const beamFrameShape = {
  units: z
    .object({
      length: z.enum(['mm', 'm', 'in']).describe('Length unit of coordinates, A, I and displacements.'),
      force: z.enum(['N', 'kN', 'lbf']).describe('Force unit of loads; E is force / length^2 in these units.'),
    })
    .describe('Consistent unit system of every number (labels only: nothing is converted).'),
  nodes: z
    .array(z.object({ id: z.string().min(1).max(64).describe('Node id, unique.'), x: finite('x coordinate.'), y: finite('y coordinate.') }))
    .min(2)
    .max(2000)
    .describe('Frame nodes in the x-y plane (member ends, supports, loads). Every node must be on a member.'),
  members: z
    .array(
      z.object({
        from: nodeRef,
        to: nodeRef,
        E: finite("Young's modulus, force / length^2, > 0."),
        A: finite('Cross-section area, length^2, > 0.'),
        I: finite('Second moment of area about the out-of-plane axis, length^4, > 0.'),
        elements: z.number().int().min(1).max(1000).describe('Number of equal corotational beam elements along the member.'),
      }),
    )
    .min(1)
    .max(2000)
    .describe('Straight prismatic members, rigidly connected at shared nodes; subdivided into elements (numbered along members in order).'),
  supports: z
    .array(
      z.object({
        node: nodeRef,
        ux: z.boolean().optional().describe('true: x displacement held at 0.'),
        uy: z.boolean().optional().describe('true: y displacement held at 0.'),
        rz: z.boolean().optional().describe('true: rotation held at 0 (with ux, uy: clamped; without: pinned).'),
      }),
    )
    .min(1)
    .max(2000)
    .describe('Restrained nodal dofs. They must stop every rigid-body motion.'),
  referenceLoad: z
    .array(
      z.object({
        node: nodeRef,
        fx: z.number().optional().describe('Force in x, force units; absent = no component.'),
        fy: z.number().optional().describe('Force in y, force units; absent = no component.'),
        mz: z.number().optional().describe('Moment about z, force x length; absent = no component.'),
      }),
    )
    .min(1)
    .max(2000)
    .describe('Reference nodal loads (fixed direction, not follower); the solution is load factor x this vector.'),
  control: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('arc_length').describe('Spherical arc-length: follows limit points, snap-through and snap-back.'),
        arcLength: z.number().describe('Arc length per step in the free-displacement space (length units), > 0, e.g. 1 for the NL7 frame.'),
        maxSteps: z.number().int().min(1).max(100000).describe('Most arc-length steps.'),
      }),
      z.object({
        kind: z.literal('load').describe('Load control (Newton): monotone problems only, it cannot pass a limit point.'),
        increments: z.number().int().min(1).max(100000).describe('Equal load-factor increments up to maxFactor.'),
        maxFactor: z.number().describe('Final load factor (signed, non-zero).'),
      }),
    ])
    .describe('Path-following method.'),
  stop: z
    .object({
      maxLoadFactor: z.number().optional().describe('Stop once |load factor| exceeds this (> 0).'),
      node: nodeRef.optional(),
      dof: z.enum(DOFS).optional().describe('Dof of stop.node watched by maxAbsDisplacement.'),
      maxAbsDisplacement: z.number().optional().describe('Stop once |stop.node stop.dof| exceeds this (length units or rad), > 0.'),
    })
    .optional()
    .describe('Optional early stop rules, checked after every converged step.'),
  report: z
    .object({
      node: nodeRef,
      dofs: z
        .array(z.enum(DOFS))
        .min(1)
        .max(3)
        .describe(
          'Displacements reported along the path: ux, uy (length units), rz (rad). The FIRST is the primary dof (limit-point refinement, snap-back).',
        ),
      every: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Report every n-th step (default 1; raised automatically to keep <= 2000 points).'),
    })
    .describe('Which node and dofs the returned path, limit points and snap-back flag are about.'),
};

export type BeamFrameInput = z.output<z.ZodObject<typeof beamFrameShape>>;

export interface BuiltFrame {
  readonly model: FrameModel;
  readonly reference: Float64Array;
  /** Input node id -> global node index. */
  readonly nodeIndex: ReadonlyMap<string, number>;
}

/** [fx, fy, mz] of a reference load; an absent component is no load in that direction (not a substituted value). */
const components = (load: BeamFrameInput['referenceLoad'][number]): [number, number, number] => [
  load.fx === undefined ? 0 : load.fx,
  load.fy === undefined ? 0 : load.fy,
  load.mz === undefined ? 0 : load.mz,
];

const positive = (value: number | undefined): boolean => value !== undefined && Number.isFinite(value) && value > 0;

/** The first problem of the input (with its param path), else null. */
function inputProblem(input: BeamFrameInput): { readonly message: string; readonly path: string } | null {
  const ids = new Set<string>();
  for (const [index, node] of input.nodes.entries()) {
    if (ids.has(node.id)) return { message: `node id '${node.id}' is used twice`, path: `nodes[${index}].id` };
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y))
      return { message: `node '${node.id}' has a non-finite coordinate`, path: `nodes[${index}]` };
    ids.add(node.id);
  }
  const known = (id: string | undefined): boolean => id !== undefined && ids.has(id);
  const onMember = new Set<string>();
  let elements = 0;
  for (const [index, member] of input.members.entries()) {
    const where = `members[${index}]`;
    if (!known(member.from) || !known(member.to)) return { message: `member ${index} names an unknown node`, path: where };
    if (member.from === member.to) return { message: `member ${index} starts and ends at '${member.from}'`, path: where };
    if (![member.E, member.A, member.I].every(positive))
      return { message: `member ${index}: E, A and I must be finite and > 0`, path: where };
    onMember.add(member.from).add(member.to);
    elements += member.elements;
  }
  if (elements > MAX_ELEMENTS) return { message: `${elements} elements: at most ${MAX_ELEMENTS}`, path: 'members' };
  const lonely = input.nodes.find((node) => !onMember.has(node.id));
  if (lonely !== undefined) return { message: `node '${lonely.id}' is on no member`, path: 'nodes' };
  for (const [index, support] of input.supports.entries())
    if (!known(support.node)) return { message: `support ${index}: unknown node '${support.node}'`, path: `supports[${index}].node` };
  let loaded = false;
  for (const [index, load] of input.referenceLoad.entries()) {
    if (!known(load.node)) return { message: `referenceLoad ${index}: unknown node '${load.node}'`, path: `referenceLoad[${index}].node` };
    const values = components(load);
    if (!values.every(Number.isFinite)) return { message: `referenceLoad ${index} is not finite`, path: `referenceLoad[${index}]` };
    loaded ||= values.some((value) => value !== 0);
  }
  if (!loaded) return { message: 'the reference load is zero', path: 'referenceLoad' };
  const { control, stop, report } = input;
  if (control.kind === 'arc_length' && !positive(control.arcLength))
    return { message: 'arcLength must be finite and > 0', path: 'control.arcLength' };
  if (control.kind === 'load' && !(Number.isFinite(control.maxFactor) && control.maxFactor !== 0))
    return { message: 'maxFactor must be finite and non-zero', path: 'control.maxFactor' };
  if (stop?.maxLoadFactor !== undefined && !positive(stop.maxLoadFactor))
    return { message: 'stop.maxLoadFactor must be > 0', path: 'stop.maxLoadFactor' };
  const watching = stop?.node !== undefined || stop?.dof !== undefined || stop?.maxAbsDisplacement !== undefined;
  if (watching && !(known(stop?.node) && stop?.dof !== undefined && positive(stop.maxAbsDisplacement)))
    return { message: 'a displacement stop needs stop.node (a node id), stop.dof and stop.maxAbsDisplacement > 0', path: 'stop' };
  if (!known(report.node)) return { message: `report.node '${report.node}' is not a node`, path: 'report.node' };
  if (new Set(report.dofs).size !== report.dofs.length) return { message: 'report.dofs lists a dof twice', path: 'report.dofs' };
  return null;
}

/**
 * The model of a validated input: node `i` of the input order of first appearance along the members, then the subdivision nodes of each member.
 * @failure the first input problem -> { problem, path }; a zero-length member, or more work than WORK_BUDGET -> { problem, path }
 */
export function buildFrame(input: BeamFrameInput): BuiltFrame | { readonly problem: string; readonly path: string } {
  const found = inputProblem(input);
  if (found !== null) return { problem: found.message, path: found.path };
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const coords: [number, number][] = [];
  const nodeIndex = new Map<string, number>();
  const indexOf = (id: string): number => {
    const existing = nodeIndex.get(id);
    if (existing !== undefined) return existing;
    const node = byId.get(id);
    // every id was checked by inputProblem; an unknown one would poison the run with NaN rather than sit silently at the origin
    coords.push(node === undefined ? [Number.NaN, Number.NaN] : [node.x, node.y]);
    nodeIndex.set(id, coords.length - 1);
    return coords.length - 1;
  };
  const elements: FrameElement[] = [];
  for (const [index, member] of input.members.entries()) {
    const from = byId.get(member.from);
    const to = byId.get(member.to);
    if (from === undefined || to === undefined || Math.hypot(to.x - from.x, to.y - from.y) === 0)
      return { problem: `member ${index} has zero length`, path: `members[${index}]` };
    let previous = indexOf(member.from);
    for (let k = 1; k < member.elements; k++) {
      coords.push([from.x + ((to.x - from.x) * k) / member.elements, from.y + ((to.y - from.y) * k) / member.elements]);
      elements.push({ a: previous, b: coords.length - 1, E: member.E, A: member.A, I: member.I });
      previous = coords.length - 1;
    }
    elements.push({ a: previous, b: indexOf(member.to), E: member.E, A: member.A, I: member.I });
  }
  const fixed = new Set<number>();
  for (const support of input.supports) {
    const node = nodeIndex.get(support.node) ?? 0;
    for (const dof of DOFS) if (support[dof] === true) fixed.add(3 * node + DOF_OFFSET[dof]);
  }
  const model = frameModel(coords, elements, fixed);
  const steps = input.control.kind === 'arc_length' ? input.control.maxSteps : input.control.increments;
  const work = steps * model.free.length * (model.bandwidth + 1) ** 2;
  if (work > WORK_BUDGET)
    return {
      problem: `the run would cost ${work.toExponential(2)} work units (steps x free dofs x (bandwidth + 1)^2), above ${WORK_BUDGET.toExponential(0)}: fewer steps or elements`,
      path: 'control',
    };
  const reference = new Float64Array(model.dofs);
  for (const load of input.referenceLoad) {
    const node = nodeIndex.get(load.node) ?? 0;
    const [fx, fy, mz] = components(load);
    reference[3 * node] = at(reference, 3 * node) + fx;
    reference[3 * node + 1] = at(reference, 3 * node + 1) + fy;
    reference[3 * node + 2] = at(reference, 3 * node + 2) + mz;
  }
  return { model, reference, nodeIndex };
}
