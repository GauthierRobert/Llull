/** 05 §5.6 mechanical deck sections: material cards, boundary conditions, loads and the static step (solid tets only). */

import type { FeaConstraint, FeaLoad, TemperatureScale } from '@core/model/analysis';
import { ALL_ELEMENTS, isDeckRefusal, loadCasesOf, type DeckContext, type DeckRefusal, type DeckSections } from './context';
import { densityToAnalysis, stressPerMpa } from './units';
import { elasticConstants, elasticTable, isElasticRefusal, propertyTemperatureK } from './elastic';
import { resolveTemperatureField, thermomechOf } from '../thermomech/field';
import { fromKelvin, kelvinOf } from '../thermomech/units';
import { caseTemperatureRange } from '../thermal/material';
import { commentText, linesText, num, row } from './format';
import { consistentWeights, momentForces } from './loadDistribution';
import { targetKind } from '../shell/shellDeck';

const DOF_NUMBER = { ux: 1, uy: 2, uz: 3 } as const;
/** Shell nodes carry rotations (radians): CalculiX dofs 4-6. */
const ROTATION_NUMBER = { rx: 4, ry: 5, rz: 6 } as const;

const refusal = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

/**
 * `*ELASTIC` and `*DENSITY` cards (no `*MATERIAL` line) of the material of `entityId`, in the case unit system. E and nu come from the
 * default constitutive set (`elastic_isotropic`) else the PHY-01 property models `E`, `nu`, read at the reference temperature
 * or 20 degC; thermo_static (field range) and coupled (initial / BC temperatures) write a table `E, nu, T` when E or nu depend on temperature; density is `Material.density` (g per cubic document unit) converted to the unit system.
 * @failure no material -> FEA_MATERIAL_MISSING; no E / nu -> FEA_MATERIAL_NO_ELASTIC; invalid E / nu -> FEA_PROPERTY_INVALID
 */
export function mechanicalMaterialLines(ctx: DeckContext, entityId: string): DeckSections {
  const material = ctx.materialOf(entityId);
  if (material === null) return refusal('FEA_MATERIAL_MISSING', `part '${entityId}' has no material`, [entityId]);
  const name = ctx.materialId(entityId) ?? '';
  const referenceKelvin = propertyTemperatureK(ctx.analysis);
  const density = densityToAnalysis(material.density, ctx.doc.units, ctx.unitSystem);
  const range = temperatureRange(ctx);
  if (range === undefined) {
    const elastic = elasticConstants(material, name, referenceKelvin);
    if (isElasticRefusal(elastic)) return refusal(elastic.code, elastic.message, [entityId]);
    return { text: linesText(['*ELASTIC', row(elastic.E * stressPerMpa(ctx.unitSystem), elastic.nu), '*DENSITY', row(density)]) };
  }
  const { scale, low, high, label } = range;
  const table = elasticTable(material, name, referenceKelvin, kelvinOf(low, scale), kelvinOf(high, scale));
  if ('code' in table) return refusal(table.code, table.message, [entityId]);
  const factor = stressPerMpa(ctx.unitSystem);
  const dependent = table.rows.length > 1;
  return {
    text: linesText([
      ...(dependent
        ? [`** E, nu tabulated against temperature (${scale}) over ${label} ${num(low)} to ${num(high)}: ${commentText(table.source)}`]
        : []),
      '*ELASTIC',
      ...table.rows.map(([E, nu, kelvin]) => (kelvin === undefined ? row(E * factor, nu) : row(E * factor, nu, fromKelvin(kelvin, scale)))),
      '*DENSITY',
      row(density),
    ]),
  };
}

/** Temperatures (case scale) the elastic table must cover: thermo_static = the resolved field range; coupled = initial / BC temperatures. */
function temperatureRange(
  ctx: DeckContext,
): { readonly scale: TemperatureScale; readonly low: number; readonly high: number; readonly label: string } | undefined {
  const setup = ctx.analysis.thermomech;
  if (setup === undefined) return undefined;
  if (ctx.analysis.type === 'coupled_temperature_displacement') {
    const bounds = setup.thermal === undefined ? null : caseTemperatureRange(setup.thermal);
    return bounds === null
      ? undefined
      : { scale: setup.temperatureScale, low: bounds[0], high: bounds[1], label: 'the initial / BC range' };
  }
  const thermoStatic = thermomechOf(ctx.analysis);
  if (thermoStatic === undefined) return undefined;
  const field = resolveTemperatureField(ctx.doc, ctx.analysisId, ctx.mesh, ctx.artifacts);
  return field.ok ? { scale: thermoStatic.temperatureScale, low: field.min, high: field.max, label: 'the field range' } : undefined;
}

/** Axis (0|1|2) a node set is flat in (one plane, or two parallel planes such as both ends of a symmetric slice), or null when it is not axis-aligned. */
export function planeAxis(ctx: DeckContext, nodeIds: readonly number[]): number | null {
  const coordinates = new Map(ctx.mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]] as const]));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const meshLo = [Infinity, Infinity, Infinity];
  const meshHi = [-Infinity, -Infinity, -Infinity];
  for (const node of ctx.mesh.nodes)
    for (let axis = 0; axis < 3; axis++) {
      meshLo[axis] = Math.min(meshLo[axis] ?? Infinity, node[axis + 1] ?? 0);
      meshHi[axis] = Math.max(meshHi[axis] ?? -Infinity, node[axis + 1] ?? 0);
    }
  for (const id of nodeIds) {
    const point = coordinates.get(id);
    if (point === undefined) continue;
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis] ?? Infinity, point[axis] ?? 0);
      hi[axis] = Math.max(hi[axis] ?? -Infinity, point[axis] ?? 0);
    }
  }
  const size = Math.hypot(...meshHi.map((value, axis) => value - (meshLo[axis] ?? 0)));
  const tolerance = 1e-6 * size;
  // An axis the whole mesh is flat in (a planar shell / plane-stress mesh) says nothing about the symmetry plane.
  const meshFlat = (axis: number): boolean => (meshHi[axis] ?? 0) - (meshLo[axis] ?? 0) <= tolerance;
  const flat = [0, 1, 2].filter((axis) => (hi[axis] ?? 0) - (lo[axis] ?? 0) <= tolerance && !meshFlat(axis));
  if (flat.length === 1) return flat[0] ?? null;
  if (flat.length > 0) return null;
  const paired = [0, 1, 2].filter((axis) => levelCount(nodeIds, coordinates, axis, tolerance) <= 2);
  return paired.length === 1 ? (paired[0] ?? null) : null;
}

/** Number of distinct coordinate levels (values further apart than `tolerance`) the nodes take along `axis`. */
function levelCount(
  nodeIds: readonly number[],
  coordinates: ReadonlyMap<number, readonly number[]>,
  axis: number,
  tolerance: number,
): number {
  const values = nodeIds.flatMap((id) => coordinates.get(id)?.[axis] ?? []).sort((a, b) => a - b);
  return values.reduce((count, value, index) => (index === 0 || value - (values[index - 1] ?? value) > tolerance ? count + 1 : count), 0);
}

function constraintLines(ctx: DeckContext, constraint: FeaConstraint): string[] | DeckRefusal {
  const key = `C_${constraint.id}`;
  const nodes = Object.hasOwn(ctx.mesh.nodeSets, key) ? (ctx.mesh.nodeSets[key] ?? []) : [];
  if (nodes.length === 0)
    return refusal('FEA_TARGET_UNRESOLVED', `constraint '${constraint.id}' (${constraint.name}) has no nodes in the mesh`, [constraint.id]);
  const set = ctx.nset(key);
  const kind = targetKind(ctx, constraint.target.entityId);
  if (constraint.kind === 'fixed') return [kind === 'shell' ? row(set, 1, 6) : kind === 'plane_stress' ? row(set, 1, 2) : row(set, 1, 3)];
  if (constraint.kind === 'pinned') return [kind === 'plane_stress' ? row(set, 1, 2) : row(set, 1, 3)];
  if (constraint.kind === 'symmetry') {
    const axis = planeAxis(ctx, nodes);
    if (axis === null)
      return refusal('FEA_CONSTRAINT_INVALID', `symmetry constraint '${constraint.id}' is not an axis-aligned plane in the mesh`, [
        constraint.id,
      ]);
    // Shells: the normal translation and the rotations about the two in-plane axes of the symmetry plane.
    const rotations = kind === 'shell' ? [0, 1, 2].filter((other) => other !== axis).map((other) => row(set, other + 4, other + 4)) : [];
    return [row(set, axis + 1, axis + 1), ...rotations];
  }
  const lines: string[] = [];
  for (const [dof, value] of Object.entries(constraint.dofs ?? {})) {
    if (kind === 'shell' && dof in ROTATION_NUMBER) {
      const number = ROTATION_NUMBER[dof as keyof typeof ROTATION_NUMBER];
      lines.push(value === 0 ? row(set, number, number) : row(set, number, number, value));
      continue;
    }
    if (!(dof in DOF_NUMBER))
      return refusal('FEA_CONSTRAINT_INVALID', `constraint '${constraint.id}': solid elements have no rotational dof '${dof}'`, [
        constraint.id,
      ]);
    const number = DOF_NUMBER[dof as keyof typeof DOF_NUMBER];
    const scaled = value * ctx.lengthToAnalysis;
    lines.push(scaled === 0 ? row(set, number, number) : row(set, number, number, scaled));
  }
  return lines;
}

const byNumbers = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** Data lines of every constraint of the case (the `*BOUNDARY` body), or the refusal of the first unresolved one. */
export function boundaryData(ctx: DeckContext): string[] | DeckRefusal {
  const boundary: string[] = [];
  for (const id of ctx.analysis.constraintOrder) {
    const constraint = ctx.analysis.constraints[id];
    if (constraint === undefined) continue;
    const lines = constraintLines(ctx, constraint);
    if (!Array.isArray(lines)) return lines;
    boundary.push(...lines);
  }
  return boundary;
}

/** Nonlinear steps restate loads incrementally: scaled by a multiplier, modified (not replaced) and without the boundary block after step 1. */
export interface StepLoadOptions {
  /** Multiplier of each load (loads of every load case are written). */
  readonly scale: (load: FeaLoad) => number;
  /** Keyword parameters appended to `*CLOAD` / `*DLOAD` (e.g. `, AMPLITUDE=A_X`); the default operation is OP=MOD, so none. */
  readonly parameters: string;
  /** Write the constraint `*BOUNDARY` block (first step only). */
  readonly boundary: boolean;
  /** Load cases summed into `loadCase` at equal targets (buckling: the preload + the reference load, since a modifying card REPLACES the value of an earlier step). */
  readonly addLoadCases?: readonly string[];
}

/**
 * Mechanical `*BOUNDARY, OP=NEW` / `*CLOAD, OP=NEW` / `*DLOAD, OP=NEW` lines for one step.
 * Force: the vector is the TOTAL load, consistent with the face integration when the target has faces (a linear face gives each corner A / 3, a quadratic face its
 * mid-edge nodes A / 3) and split equally over the target nodes otherwise (edges, points), or applied at every node (`'per_node'`); moment: a statically equivalent nodal force
 * couple on the target nodes (`loadDistribution.momentForces`); contributions to one node and dof are summed. Pressure: `P<face>` per (element, face) of the target's face set,
 * positive into the material. Gravity: acceleration vector on every element (`GRAV`, magnitude and unit direction). All of them
 * are restated with `OP=NEW` in each step, so load cases do not accumulate.
 * @param loadCase only the loads of this load case; without it every load of the case is written (thermo_static uses a single step)
 * @param options nonlinear steps: every load scaled by its multiplier, zero values kept (they remove a load under OP=MOD), no `OP=NEW`
 * @failure constraint / load target without nodes or faces in the mesh -> FEA_TARGET_UNRESOLVED; rotational dof or non-axis symmetry plane
 *   -> FEA_CONSTRAINT_INVALID
 */
export function mechanicalStepLines(ctx: DeckContext, loadCase?: string, options?: StepLoadOptions): DeckSections {
  const boundary = options?.boundary === false ? [] : boundaryData(ctx);
  if (!Array.isArray(boundary)) return boundary;
  const forces = new Map<string, readonly [node: number, dof: number, value: number]>();
  const pressures = new Map<string, readonly [element: number, face: number, value: number]>();
  const gravity = [0, 0, 0];
  const gravityDirection = [0, 0, 0];
  for (const id of ctx.analysis.loadOrder) {
    const load = ctx.analysis.loads[id];
    if (load === undefined || (loadCase !== undefined && load.loadCase !== loadCase && !options?.addLoadCases?.includes(load.loadCase)))
      continue;
    const factor = options === undefined ? 1 : options.scale(load);
    const key = `L_${id}`;
    if (load.kind === 'gravity' && load.vector !== undefined) {
      load.vector.forEach((component, axis) => {
        gravity[axis] = (gravity[axis] ?? 0) + component * factor;
        gravityDirection[axis] = (gravityDirection[axis] ?? 0) + component;
      });
    } else if (load.kind === 'force' && load.vector !== undefined) {
      const nodes = Object.hasOwn(ctx.mesh.nodeSets, key) ? (ctx.mesh.nodeSets[key] ?? []) : [];
      if (nodes.length === 0) return refusal('FEA_TARGET_UNRESOLVED', `force '${id}' (${load.name}) has no nodes in the mesh`, [id]);
      const weights = load.distribution === 'per_node' ? null : consistentWeights(ctx, key);
      const shares: [number, number][] =
        weights !== null
          ? [...weights]
          : nodes.map((node) => [node, load.distribution === 'per_node' ? 1 : 1 / nodes.length] as [number, number]);
      for (const [node, share] of shares)
        load.vector.forEach((component, axis) => {
          const mapKey = `${node}:${axis + 1}`;
          forces.set(mapKey, [node, axis + 1, (forces.get(mapKey)?.[2] ?? 0) + component * share * factor]);
        });
    } else if (load.kind === 'moment' && load.vector !== undefined) {
      const nodes = Object.hasOwn(ctx.mesh.nodeSets, key) ? (ctx.mesh.nodeSets[key] ?? []) : [];
      if (nodes.length === 0) return refusal('FEA_TARGET_UNRESOLVED', `moment '${id}' (${load.name}) has no nodes in the mesh`, [id]);
      const couple = momentForces(ctx.mesh, nodes, load.vector);
      if ('refusal' in couple) return refusal('FEA_LOAD_INVALID', `moment '${id}' (${load.name}): ${couple.refusal}`, [id]);
      for (const [node, force] of couple.forces)
        force.forEach((component, axis) => {
          const mapKey = `${node}:${axis + 1}`;
          forces.set(mapKey, [node, axis + 1, (forces.get(mapKey)?.[2] ?? 0) + component * factor]);
        });
    } else if (load.kind === 'pressure' && load.magnitude !== undefined) {
      const faces = ctx.faces(key);
      const kind = targetKind(ctx, load.target?.entityId);
      if (kind === 'plane_stress')
        return refusal(
          'FEA_LOAD_INVALID',
          `pressure '${id}' (${load.name}) on a plane-stress part is not built: apply a force on the edge`,
          [id],
        );
      if (faces.length === 0) return refusal('FEA_TARGET_UNRESOLVED', `pressure '${id}' (${load.name}) has no faces in the mesh`, [id]);
      for (const [element, face] of faces) {
        // Shells: label P on the element; the mesher's face 1 = loaded from the top (+normal) side, 2 = from the bottom side. CalculiX 2.21
        // moves a shell ALONG its normal under a positive P (measured, server/tests/feaShellSolve.test.ts), so a load pushing into the material
        // from the top side is -p and from the bottom side +p.
        const shellSign = face === 2 ? 1 : -1;
        const label = kind === 'shell' ? 0 : face;
        const mapKey = `${element}:${label}`;
        const value = load.magnitude * factor * (kind === 'shell' ? shellSign : 1);
        pressures.set(mapKey, [element, label, (pressures.get(mapKey)?.[2] ?? 0) + value]);
      }
    }
  }
  const lines: string[] = [];
  if (boundary.length > 0) lines.push('*BOUNDARY, OP=NEW', ...boundary);
  const parameters = options === undefined ? ', OP=NEW' : options.parameters;
  const cloads = [...forces.values()].filter((entry) => options !== undefined || entry[2] !== 0).sort(byNumbers);
  const dloads = [...pressures.values()]
    .sort(byNumbers)
    .map(([element, face, value]) => row(element, face === 0 ? 'P' : `P${face}`, value));
  const magnitude = Math.hypot(gravity[0] ?? 0, gravity[1] ?? 0, gravity[2] ?? 0);
  const directionLength = Math.hypot(gravityDirection[0] ?? 0, gravityDirection[1] ?? 0, gravityDirection[2] ?? 0);
  if (magnitude > 0)
    dloads.push(`${ALL_ELEMENTS}, GRAV, ${num(magnitude)}, ${gravity.map((component) => num(component / magnitude)).join(', ')}`);
  else if (options !== undefined && directionLength > 0)
    dloads.push(`${ALL_ELEMENTS}, GRAV, 0, ${gravityDirection.map((component) => num(component / directionLength)).join(', ')}`);
  if (options === undefined || cloads.length > 0)
    lines.push(`*CLOAD${parameters}`, ...cloads.map(([node, dof, value]) => row(node, dof, value)));
  if (options === undefined || dloads.length > 0) lines.push(`*DLOAD${parameters}`, ...dloads);
  return { text: linesText(lines) };
}

/** `*NODE PRINT` requests for the displacement probes of the case (nearest mesh node, table in the .dat file). */
function probePrintLines(ctx: DeckContext): string[] {
  const lines: string[] = [];
  for (const [id, probe] of Object.entries(ctx.analysis.probes)) {
    const key = `P_${id}`;
    if (!probe.quantity.startsWith('u_') || (ctx.mesh.nodeSets[key]?.length ?? 0) === 0) continue;
    lines.push(`*NODE PRINT, NSET=${ctx.nset(key)}`, 'U');
  }
  return lines;
}

/**
 * The static procedure, one `*STEP` per load case (`loadCasesOf` order): `*STATIC`, the mechanical lines of the case, `*NODE FILE U`,
 * `*EL FILE S, E` and `*NODE PRINT U` for displacement probes. Results of step n are load case n.
 * @failure as mechanicalStepLines
 */
export function staticStep(ctx: DeckContext): DeckSections {
  const out: string[] = [];
  for (const { name } of loadCasesOf(ctx.analysis)) {
    const mechanical = mechanicalStepLines(ctx, name);
    if (isDeckRefusal(mechanical)) return mechanical;
    out.push(`** load case ${commentText(name)}`, '*STEP', '*STATIC');
    out.push(...mechanical.text.split('\n').filter((line) => line !== ''));
    out.push('*NODE FILE', 'U', '*EL FILE', 'S, E', ...probePrintLines(ctx), '*END STEP');
  }
  return { text: linesText(out) };
}
