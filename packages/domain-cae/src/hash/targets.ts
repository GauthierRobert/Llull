/** Target keys of an analysis case: the names shared by the mesh request, the mesh artifact sets and the deck writers. */

import type { AnalysisCase, FeaTarget } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';

/** One resolvable thing in a case. `entityId` null = a probe point, searched in every part. */
export interface KeyedTarget {
  readonly key: string;
  readonly entityId: string | null;
  readonly facesNear?: readonly Vec3[];
  readonly edgesNear?: readonly Vec3[];
  readonly pointsNear?: readonly Vec3[];
  readonly intersectPlane?: { readonly point: Vec3; readonly normal: Vec3 };
}

const keyed = (key: string, target: FeaTarget): KeyedTarget => ({ key, ...target });

/**
 * Every target of `analysisCase` with its key: `C_<constraintId>`, `L_<loadId>`, `B_<thermalBcId>`, `V_<cavityId>_<faceIndex>`, `K_<contactId>_M|S` (master / slave of a thermal contact), `R_<refinementIndex>`,
 * `P_<probeId>`, `S_<stepId>` (displacement-controlled nonlinear step), `N_<curveProbeId>` (nearest node of a curve probe), `T_<limitId>`. Loads without a target (gravity), heat generation and entity-scoped limits have no key.
 * @invariant order: constraints, loads, thermal BCs, cavity faces, contact faces, refinements, probes, nonlinear steps, curve probes, limits (each in creation order)
 */
export function keyedTargets(analysisCase: AnalysisCase): KeyedTarget[] {
  const out: KeyedTarget[] = [];
  for (const id of analysisCase.constraintOrder) {
    const constraint = analysisCase.constraints[id];
    if (constraint !== undefined) out.push(keyed(`C_${id}`, constraint.target));
  }
  for (const id of analysisCase.loadOrder) {
    const target = analysisCase.loads[id]?.target;
    if (target !== undefined) out.push(keyed(`L_${id}`, target));
  }
  const thermal = analysisCase.thermal ?? analysisCase.thermomech?.thermal;
  for (const id of thermal?.bcOrder ?? []) {
    const bc = thermal?.bcs[id]?.bc;
    if (bc !== undefined && 'target' in bc) out.push(keyed(`B_${id}`, bc.target));
  }
  for (const cavity of Object.values(thermal?.cavities ?? {}))
    cavity.faces.forEach((face, index) => out.push(keyed(`V_${cavity.id}_${index}`, face.target)));
  for (const contact of Object.values(thermal?.contacts ?? {})) {
    out.push(keyed(`K_${contact.id}_M`, contact.master));
    out.push(keyed(`K_${contact.id}_S`, contact.slave));
  }
  analysisCase.mesh.refinements.forEach((refinement, index) => out.push(keyed(`R_${index}`, refinement.target)));
  for (const [id, probe] of Object.entries(analysisCase.probes)) out.push({ key: `P_${id}`, entityId: null, pointsNear: [probe.point] });
  for (const id of analysisCase.nonlinear?.stepOrder ?? []) {
    const control = analysisCase.nonlinear?.steps[id]?.control;
    if (control?.kind === 'displacement') out.push(keyed(`S_${id}`, control.target));
  }
  for (const id of analysisCase.nonlinear?.probeOrder ?? []) {
    const probe = analysisCase.nonlinear?.probes[id];
    if (probe !== undefined) out.push({ key: `N_${id}`, entityId: null, pointsNear: [probe.displacement.point] });
  }
  for (const id of thermal?.limitOrder ?? []) {
    const scope = thermal?.limits[id]?.scope;
    if (scope !== undefined && 'target' in scope) out.push(keyed(`T_${id}`, scope.target));
  }
  return out;
}
