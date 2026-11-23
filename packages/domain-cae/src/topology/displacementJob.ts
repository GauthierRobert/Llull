/** Displacement constraints of a min_volume study as solver rows: the DOFs of the target nodes, the load case and the limit in analysis units. */

import type { TopologyDisplacementConstraint, TopologyStudy, WorldAxis } from '@core/model/topology';
import { dofComponents, isMappingFailure, mapTarget, type nodeSets } from './mapping';
import type { TopologyGrid } from './voxel';

/** One constraint of `job.json`: `|mean u[dofs]| <= maxDisplacement` in load case `loadCase` (analysis length unit). */
export interface JobDisplacement {
  readonly label: string;
  readonly loadCase: string;
  /** `dimension * node + component` of every mapped grid node. */
  readonly dofs: readonly number[];
  readonly maxDisplacement: number;
}

interface DisplacementRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/** Triangles of a design-domain entity (null when it is not a 3D solid). */
type SurfaceOf = (entityId: string) => Parameters<typeof mapTarget>[2] | null;

const AXES: readonly WorldAxis[] = ['x', 'y', 'z'];

function rowsOf(
  study: TopologyStudy,
  constraint: TopologyDisplacementConstraint,
  grid: TopologyGrid,
  sets: ReturnType<typeof nodeSets>,
  lengthFactor: number,
  surfaceOf: SurfaceOf,
  fixed: ReadonlySet<number>,
): { readonly dofs: number[]; readonly maxDisplacement: number } | string {
  const surface = study.designDomain.includes(constraint.target.entityId) ? surfaceOf(constraint.target.entityId) : null;
  if (surface === null) return `target entity '${constraint.target.entityId}' is not a design-domain solid`;
  const mapped = mapTarget(grid, sets, surface, constraint.target);
  if (isMappingFailure(mapped)) return mapped.error;
  const axis = grid.axes.indexOf(AXES.indexOf(constraint.component.slice(1) as WorldAxis));
  if (axis < 0 || axis >= dofComponents(grid)) return `component ${constraint.component} is the normal of the 2D grid plane`;
  const dofs = [...new Set(mapped.nodes)].sort((a, b) => a - b).map((node) => dofComponents(grid) * node + axis);
  if (dofs.length === 0) return 'the target maps to no grid node';
  if (dofs.every((dof) => fixed.has(dof)))
    return `every grid node of the target is held by a support along ${constraint.component} (its displacement is 0): pick a free face, edge or point`;
  return { dofs, maxDisplacement: constraint.maxDisplacement * lengthFactor };
}

/**
 * The solver rows of the displacement constraints of `study` (a constraint without `loadCase` yields one row per load case name).
 * @failure unmappable target, a target held entirely by supports, a component normal to the 2D plane, an unknown load case name -> TOP_TARGET_UNMAPPED / TOP_SETUP_INVALID
 */
export function displacementRows(
  study: TopologyStudy,
  grid: TopologyGrid,
  sets: ReturnType<typeof nodeSets>,
  lengthFactor: number,
  caseNames: readonly string[],
  surfaceOf: SurfaceOf,
  fixed: ReadonlySet<number>,
): JobDisplacement[] | DisplacementRefusal {
  const rows: JobDisplacement[] = [];
  const constraints = study.objective.kind === 'min_volume' ? (study.objective.displacementConstraints ?? []) : [];
  for (const constraint of constraints) {
    const refuse = (code: string, message: string): DisplacementRefusal => ({
      ok: false,
      code,
      message: `displacement constraint '${constraint.label}': ${message}`,
      ids: [study.id],
    });
    if (constraint.loadCase !== undefined && !caseNames.includes(constraint.loadCase))
      return refuse('TOP_SETUP_INVALID', `load case '${constraint.loadCase}' is not a load case of the analysis (${caseNames.join(', ')})`);
    const row = rowsOf(study, constraint, grid, sets, lengthFactor, surfaceOf, fixed);
    if (typeof row === 'string') return refuse('TOP_TARGET_UNMAPPED', row);
    for (const loadCase of constraint.loadCase === undefined ? caseNames : [constraint.loadCase])
      rows.push({
        label: constraint.loadCase === undefined && caseNames.length > 1 ? `${constraint.label}@${loadCase}` : constraint.label,
        loadCase,
        ...row,
      });
  }
  return rows;
}
