/**
 * Rigid-body balance of a free-body (inertial-relief) load case (14 FLL): with the three 3-2-1 supports the reactions equal minus the net
 * wrench of the loads on the rigid body, so the residual is computed from the loads and the mass properties, not from a solve.
 */

import type { AnalysisCase, FeaLoad } from '@core/model/analysis';
import { resolveMassProperties, type MassContext } from '@core/geometry/resolveMassProperties';
import { combineMassProperties, type MassProperties } from '@core/geometry/massProperties';
import { is3D, type CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import type { Vec3 } from '@core/model/vectors';
import { densityToAnalysis } from '../decks/units';
import { analysisLengthMetres } from '../shared/defaults';

/** Relative reaction (residual wrench over the applied load) above which the case is not balanced (spec 14 FLL section 4). */
export const RELIEF_TOLERANCE = 1e-4;

/** Floating-point floor of a residual relative to the applied load (a balanced case with a zero moment scale). */
const FLOAT_FLOOR = 1e-12;

interface ReliefBalance {
  readonly loadCase: string;
  /** Net unbalanced force (analysis force unit) and moment about the centre of mass: minus the reactions of the supports. */
  readonly residualForce: number;
  readonly residualMoment: number;
  readonly appliedForce: number;
  readonly appliedMoment: number;
  readonly balanced: boolean;
}

export interface ReliefAssessment {
  readonly balances: readonly ReliefBalance[];
  /** Reasons the balance of some load could not be assessed (per-node forces, pressures, missing mass). */
  readonly unassessed: readonly string[];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const ZERO: Vec3 = [0, 0, 0];

/** The inertia tensor [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] (off-diagonals as stored, Ixy = -integral of xy dm) times `v`. */
function applyInertia(inertia: MassProperties['inertia'], v: Vec3): Vec3 {
  const [ixx, iyy, izz, ixy, ixz, iyz] = inertia;
  return [ixx * v[0] + ixy * v[1] + ixz * v[2], ixy * v[0] + iyy * v[1] + iyz * v[2], ixz * v[0] + iyz * v[1] + izz * v[2]];
}

/**
 * Application point of a force: the mean of the target points (the hints the user gave, not the resolved face centroid: the resolution needs the mesh, which this
 * pre-solve balance does not have; a mount on a large face should be given points around its centroid) (pointsNear, else edgesNear, else facesNear), document units. */
function loadPoint(load: FeaLoad): Vec3 | null {
  const points = [load.target?.pointsNear, load.target?.edgesNear, load.target?.facesNear].find(
    (list) => list !== undefined && list.length > 0,
  );
  if (points === undefined) return null;
  return scale(points.reduce<Vec3>(add, ZERO), 1 / points.length);
}

/** Mass properties of the analysed solids in analysis units (mass; lengths scaled to the analysis length), or the reason there are none. */
function bodyMass(doc: CadDocument, analysis: AnalysisCase, length: number, ctx: MassContext): MassProperties | string {
  const parts: MassProperties[] = [];
  for (const entityId of Object.keys(analysis.parts)) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined || !is3D(entity)) return `part '${entityId}' is not a 3D solid`;
    if (analysis.parts[entityId]?.kind !== 'solid') return `part '${entityId}' is not meshed as a solid`;
    const densityOf = (solid: { readonly materialId?: string | undefined }): number => {
      const material =
        solid.materialId !== undefined && Object.hasOwn(doc.materials, solid.materialId) ? doc.materials[solid.materialId] : undefined;
      return material === undefined ? 0 : densityToAnalysis(material.density, doc.units, analysis.unitSystem) * length ** 3;
    };
    const resolved = resolveMassProperties(doc, entity, densityOf, ctx);
    if (resolved === null || !(resolved.properties.mass > 0)) return `part '${entityId}' has no mass (material with a density?)`;
    parts.push(resolved.properties);
  }
  const combined = combineMassProperties(parts);
  if (combined === null) return 'the analysis has no mass';
  return {
    ...combined,
    centerOfMass: scale(combined.centerOfMass, length),
    inertia: combined.inertia.map((value) => value * length * length) as unknown as MassProperties['inertia'],
  };
}

interface CaseWrench {
  gravity: Vec3;
  linear: Vec3;
  omega: Vec3;
  alpha: Vec3;
  origin: Vec3;
  force: Vec3;
  moment: Vec3;
  forceScale: number;
  momentScale: number;
}

/** Sums the loads of one case into a wrench record; a load that cannot be assessed is named in `reasons`. */
function collect(analysis: AnalysisCase, loadCase: string, mass: MassProperties, length: number, reasons: string[]): CaseWrench | null {
  const sum: CaseWrench = {
    gravity: ZERO,
    linear: ZERO,
    omega: ZERO,
    alpha: ZERO,
    origin: ZERO,
    force: ZERO,
    moment: ZERO,
    forceScale: 0,
    momentScale: 0,
  };
  let assessed = true;
  let inertialSeen = false;
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load === undefined || load.loadCase !== loadCase) continue;
    const vector = load.vector ?? ZERO;
    if (load.kind === 'gravity') sum.gravity = add(sum.gravity, vector);
    else if (load.kind === 'inertial') {
      if (inertialSeen) {
        reasons.push(`inertial load '${id}' (${load.name}) in '${loadCase}': more than one inertial load in a load case`);
        assessed = false;
        continue;
      }
      inertialSeen = true;
      sum.linear = add(sum.linear, vector);
      sum.omega = add(sum.omega, load.angularVelocity ?? ZERO);
      sum.alpha = add(sum.alpha, load.angularAccel ?? ZERO);
      sum.origin = scale(load.referencePoint ?? ZERO, length);
    } else if (load.kind === 'moment') {
      sum.moment = add(sum.moment, vector);
      sum.momentScale += norm(vector);
    } else if (load.kind === 'force') {
      const point = loadPoint(load);
      if (load.distribution === 'per_node' || point === null) {
        reasons.push(`force '${id}' (${load.name}) in '${loadCase}': ${point === null ? 'no target points' : 'per_node distribution'}`);
        assessed = false;
        continue;
      }
      const arm = cross(sub(scale(point, length), mass.centerOfMass), vector);
      sum.force = add(sum.force, vector);
      sum.moment = add(sum.moment, arm);
      sum.forceScale += norm(vector);
      sum.momentScale += norm(arm);
    } else {
      reasons.push(`pressure '${id}' (${load.name}) in '${loadCase}': the net force of a pressure is not assessed here`);
      assessed = false;
    }
  }
  return assessed ? sum : null;
}

/**
 * Balance of every load case of a free-body analysis (one that has `freeBody` constraints): net wrench of the mount forces / moments plus the
 * body force -rho (a + alpha x r + omega x (omega x r)) + gravity on the rigid body about its centre of mass; a force acts at the mean of its target points.
 * @invariant residual force = |sum F + M (g - a - alpha x s - omega x (omega x s))|, residual moment = |sum (x - c) x F + sum M - (I alpha + omega x I omega)|, s = c - O
 * @failure no freeBody constraint -> null; per-node forces, pressures, a force without target points or a body without mass -> listed in `unassessed`, their case skipped
 */
export function reliefAssessment(doc: CadDocument, analysis: AnalysisCase, ctx?: MassContext): ReliefAssessment | null {
  if (!Object.values(analysis.constraints).some((constraint) => constraint.freeBody === true)) return null;
  const length = toMetres(doc, 1) / analysisLengthMetres(analysis.unitSystem);
  const mass = bodyMass(doc, analysis, length, ctx ?? {});
  if (typeof mass === 'string') return { balances: [], unassessed: [mass] };
  const unassessed: string[] = [];
  const balances: ReliefBalance[] = [];
  for (const loadCase of new Set(analysis.loadOrder.map((id) => analysis.loads[id]?.loadCase ?? ''))) {
    const wrench = collect(analysis, loadCase, mass, length, unassessed);
    if (wrench === null) continue;
    const s = sub(mass.centerOfMass, wrench.origin);
    const field = sub(sub(sub(wrench.gravity, wrench.linear), cross(wrench.alpha, s)), cross(wrench.omega, cross(wrench.omega, s)));
    const bodyForce = scale(field, mass.mass);
    const bodyMoment = scale(
      add(applyInertia(mass.inertia, wrench.alpha), cross(wrench.omega, applyInertia(mass.inertia, wrench.omega))),
      -1,
    );
    const residualForce = norm(add(wrench.force, bodyForce));
    const residualMoment = norm(add(wrench.moment, bodyMoment));
    const appliedForce = Math.max(wrench.forceScale, norm(bodyForce));
    const appliedMoment = Math.max(wrench.momentScale, norm(bodyMoment));
    const noise = FLOAT_FLOOR * (appliedForce + appliedMoment);
    const balanced = residualForce <= RELIEF_TOLERANCE * appliedForce + noise && residualMoment <= RELIEF_TOLERANCE * appliedMoment + noise;
    balances.push({ loadCase, residualForce, residualMoment, appliedForce, appliedMoment, balanced });
  }
  return { balances, unassessed };
}

/** Centre of mass of the analysed solids in DOCUMENT units, or the reason it cannot be computed. */
export function analysedCentre(doc: CadDocument, analysis: AnalysisCase, ctx?: MassContext): Vec3 | string {
  const length = toMetres(doc, 1) / analysisLengthMetres(analysis.unitSystem);
  const mass = bodyMass(doc, analysis, length, ctx ?? {});
  return typeof mass === 'string' ? mass : scale(mass.centerOfMass, 1 / length);
}
