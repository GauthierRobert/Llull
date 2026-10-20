/** BDF boundary conditions (SPC1 / SPCD) and loads (FORCE, MOMENT + RBE3, PLOAD4, GRAV) of one analysis. */

import type { FeaConstraint, FeaLoad } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import type { DeckContext, DeckRefusal } from '../context';
import { consistentWeights } from '../loadDistribution';
import { planeAxis } from '../mechanical';
import { cardLines } from './fields';
import { failed, integer, real, refusal, type Rounding } from './model';

const DOF_COMPONENT = { ux: 1, uy: 2, uz: 3, rx: 4, ry: 5, rz: 6 } as const;
/** Corner positions (0-based) of the tetrahedron faces in CalculiX numbering and the corner NOT on each face (PLOAD4 `G4` of a CTETRA). */
const TET_FACES: readonly (readonly [number, number])[] = [
  [0, 3],
  [0, 2],
  [1, 0],
  [2, 1],
];

const nodesOf = (ctx: DeckContext, key: string): readonly number[] =>
  Object.hasOwn(ctx.mesh.nodeSets, key) ? (ctx.mesh.nodeSets[key] ?? []) : [];

/** Components (1-6) a constraint removes: `[component, value]` pairs, value in analysis length units (rotations unscaled). */
function constraintComponents(
  ctx: DeckContext,
  constraint: FeaConstraint,
  nodes: readonly number[],
  shells: boolean,
): [number, number][] | DeckRefusal {
  if (constraint.kind === 'fixed') return (shells ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]).map((component) => [component, 0]);
  if (constraint.kind === 'pinned') return [1, 2, 3].map((component) => [component, 0]);
  if (constraint.kind === 'symmetry') {
    const axis = planeAxis(ctx, nodes);
    return axis === null
      ? refusal('FEA_CONSTRAINT_INVALID', `symmetry constraint '${constraint.id}' is not an axis-aligned plane in the mesh`, [
          constraint.id,
        ])
      : [[axis + 1, 0]];
  }
  const out: [number, number][] = [];
  for (const [dof, value] of Object.entries(constraint.dofs ?? {})) {
    const component = DOF_COMPONENT[dof as keyof typeof DOF_COMPONENT];
    if (component === undefined || (component > 3 && !shells))
      return refusal('FEA_CONSTRAINT_INVALID', `constraint '${constraint.id}': solid elements have no rotational dof '${dof}'`, [
        constraint.id,
      ]);
    out.push([component, component > 3 ? value : value * ctx.lengthToAnalysis]);
  }
  return out;
}

/**
 * `SPC1 sid components grids...` for every constraint (zero components of one constraint in one card) and the enforced displacements as
 * `SPCD loadSid grid component value` rows (selected by `LOAD` in each subcase, together with the SPC1 that holds the dof).
 * @failure target without nodes -> FEA_TARGET_UNRESOLVED; rotational dof on solids / non-axis symmetry plane -> FEA_CONSTRAINT_INVALID
 */
export function constraintCards(
  ctx: DeckContext,
  sid: number,
  shells: boolean,
): { readonly spc: string[]; readonly enforced: readonly (readonly [node: number, component: number, value: number])[] } | DeckRefusal {
  const spc: string[] = [];
  const enforced: [number, number, number][] = [];
  for (const id of ctx.analysis.constraintOrder) {
    const constraint = ctx.analysis.constraints[id];
    if (constraint === undefined) continue;
    const nodes = nodesOf(ctx, `C_${id}`);
    if (nodes.length === 0)
      return refusal('FEA_TARGET_UNRESOLVED', `constraint '${id}' (${constraint.name}) has no nodes in the mesh`, [id]);
    const components = constraintComponents(ctx, constraint, nodes, shells);
    if (!Array.isArray(components)) return components as DeckRefusal;
    const zero = components.filter(([, value]) => value === 0).map(([component]) => component);
    const moving = components.filter(([, value]) => value !== 0);
    const groups: [string, readonly number[]][] = [];
    if (zero.length > 0) groups.push([zero.join(''), nodes]);
    for (const [component] of moving) groups.push([String(component), nodes]);
    for (const [text, group] of groups) spc.push(...cardLines('SPC1', [String(sid), text, ...group.map(String)]));
    for (const [component, value] of moving) for (const node of nodes) enforced.push([node, component, value]);
  }
  return { spc, enforced };
}

/** Accumulate `vector` at `node` in `into`. */
function add(into: Map<number, Vec3>, node: number, vector: Vec3): void {
  const previous = into.get(node) ?? [0, 0, 0];
  into.set(node, [previous[0] + vector[0], previous[1] + vector[1], previous[2] + vector[2]]);
}

const unit = (vector: Vec3): { readonly magnitude: number; readonly direction: Vec3 } => {
  const magnitude = Math.hypot(...vector);
  return { magnitude, direction: magnitude === 0 ? [0, 0, 0] : [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude] };
};

export interface LoadCards {
  /** Entries selected by `LOAD = sid` (FORCE, MOMENT, PLOAD4, GRAV, SPCD). */
  readonly loads: string[];
  /** Reference GRIDs and RBE3 elements of the moments (model level, no stiffness). */
  readonly rigid: string[];
  readonly comments: string[];
}

/** Next free id of each kind for the reference grids and the RBE3 elements of moments. */
export interface FreeIds {
  nextGrid: number;
  nextElement: number;
}

/**
 * Loads of one load case under `sid`: forces split like the INP writer (area-consistent over faces, else equal over the target nodes, or `per_node`),
 * pressure as PLOAD4 (+ into the material, the Nastran solid convention), gravity as one GRAV, and each moment as a MOMENT on a reference GRID held to
 * the target nodes by an RBE3 (at `referencePoint`, else the centroid of the target nodes).
 * @failure target without nodes / faces -> FEA_TARGET_UNRESOLVED; pressure on a non-tetrahedron element or a bad face -> FEA_LOAD_INVALID; id overflow -> FEA_BDF_ID_TOO_LARGE
 */
export function loadCards(ctx: DeckContext, loadCase: string, sid: number, ids: FreeIds, track: Rounding): LoadCards | DeckRefusal {
  const forces = new Map<number, Vec3>();
  const out: LoadCards = { loads: [], rigid: [], comments: [] };
  const gravity: [number, number, number] = [0, 0, 0];
  const elements = new Map(
    ctx.mesh.blocks.flatMap((block) =>
      block.elements.map((element) => [element[0] ?? -1, { type: block.type, nodes: element.slice(1) }] as const),
    ),
  );
  const position = new Map(ctx.mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]] as Vec3] as const));
  const sidText = String(sid);
  for (const id of ctx.analysis.loadOrder) {
    const load: FeaLoad | undefined = ctx.analysis.loads[id];
    if (load === undefined || load.loadCase !== loadCase) continue;
    const key = `L_${id}`;
    const nodes = nodesOf(ctx, key);
    out.comments.push(`$ llull: load '${id}' ${load.kind} in load case ${loadCase}`);
    if (load.kind === 'gravity' && load.vector !== undefined)
      load.vector.forEach((component, axis) => void (gravity[axis] = (gravity[axis] ?? 0) + component));
    else if (load.kind === 'force' && load.vector !== undefined) {
      if (nodes.length === 0) return refusal('FEA_TARGET_UNRESOLVED', `force '${id}' (${load.name}) has no nodes in the mesh`, [id]);
      const weights = load.distribution === 'per_node' ? null : consistentWeights(ctx, key);
      const shares: [number, number][] =
        weights !== null ? [...weights] : nodes.map((node) => [node, load.distribution === 'per_node' ? 1 : 1 / nodes.length]);
      for (const [node, share] of shares) add(forces, node, [load.vector[0] * share, load.vector[1] * share, load.vector[2] * share]);
    } else if (load.kind === 'moment' && load.vector !== undefined) {
      if (nodes.length < 2)
        return refusal('FEA_LOAD_INVALID', `moment '${id}' (${load.name}) needs at least 2 target nodes for its RBE3`, [id]);
      const centre: Vec3 =
        load.referencePoint !== undefined
          ? [
              load.referencePoint[0] * ctx.lengthToAnalysis,
              load.referencePoint[1] * ctx.lengthToAnalysis,
              load.referencePoint[2] * ctx.lengthToAnalysis,
            ]
          : nodes.reduce<Vec3>(
              (sum, node) => {
                const at = position.get(node) ?? [0, 0, 0];
                return [sum[0] + at[0] / nodes.length, sum[1] + at[1] / nodes.length, sum[2] + at[2] / nodes.length];
              },
              [0, 0, 0],
            );
      const grid = ids.nextGrid++;
      const element = ids.nextElement++;
      const text = [
        integer(grid, 'reference grid id'),
        '',
        real(centre[0], 'reference x', track),
        real(centre[1], 'reference y', track),
        real(centre[2], 'reference z', track),
      ];
      const rbe = [integer(element, 'RBE3 element id'), '', String(grid), '123456', '1.', '123', ...nodes.map(String)];
      const bad = [...text, rbe[0] ?? ''].find((field) => typeof field !== 'string');
      if (bad !== undefined) return bad as unknown as DeckRefusal;
      out.rigid.push(...cardLines('GRID', text as string[]), ...cardLines('RBE3', rbe as string[]));
      const { magnitude, direction } = unit(load.vector);
      const fields = [
        sidText,
        String(grid),
        '',
        real(magnitude, 'moment', track),
        ...direction.map((component) => real(component, 'moment direction', track)),
      ];
      const badField = fields.find(failed);
      if (badField !== undefined) return badField as DeckRefusal;
      out.loads.push(...cardLines('MOMENT', fields as string[]));
      out.comments.push(`$ llull: moment '${id}' on reference grid ${grid} (RBE3 ${element} over ${nodes.length} nodes)`);
    } else if (load.kind === 'pressure' && load.magnitude !== undefined) {
      const faces = ctx.faces(key);
      if (faces.length === 0) return refusal('FEA_TARGET_UNRESOLVED', `pressure '${id}' (${load.name}) has no faces in the mesh`, [id]);
      for (const [elementId, label] of faces) {
        const element = elements.get(elementId);
        const corners = TET_FACES[label - 1];
        if (element === undefined || (element.type !== 'C3D4' && element.type !== 'C3D10') || corners === undefined)
          return refusal('FEA_LOAD_INVALID', `pressure '${id}': face ${label} of element ${elementId} is not a tetrahedron face`, [id]);
        const fields = [
          sidText,
          String(elementId),
          real(load.magnitude, 'pressure', track),
          '',
          '',
          '',
          String(element.nodes[corners[0]] ?? 0),
          String(element.nodes[corners[1]] ?? 0),
        ];
        const badField = fields.find(failed);
        if (badField !== undefined) return badField as DeckRefusal;
        out.loads.push(...cardLines('PLOAD4', fields as string[]));
      }
    }
  }
  for (const node of [...forces.keys()].sort((a, b) => a - b)) {
    const { magnitude, direction } = unit(forces.get(node) ?? [0, 0, 0]);
    if (magnitude === 0) continue;
    const fields = [
      sidText,
      String(node),
      '',
      real(magnitude, 'force', track),
      ...direction.map((component) => real(component, 'force direction', track)),
    ];
    const badField = fields.find(failed);
    if (badField !== undefined) return badField as DeckRefusal;
    out.loads.push(...cardLines('FORCE', fields as string[]));
  }
  const { magnitude, direction } = unit(gravity);
  if (magnitude > 0) {
    const fields = [
      sidText,
      '',
      real(magnitude, 'gravity', track),
      ...direction.map((component) => real(component, 'gravity direction', track)),
    ];
    const badField = fields.find(failed);
    if (badField !== undefined) return badField as DeckRefusal;
    out.loads.push(...cardLines('GRAV', fields as string[]));
  }
  return out;
}
