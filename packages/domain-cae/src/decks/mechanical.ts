/** 05 §5.6 mechanical deck sections: material cards, boundary conditions, loads and the static step (solid tets only). */

import type { FeaConstraint } from '@core/model/analysis';
import { ALL_ELEMENTS, isDeckRefusal, loadCasesOf, type DeckContext, type DeckRefusal, type DeckSections } from './context';
import { densityToAnalysis, stressPerMpa } from './units';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from './elastic';
import { linesText, num, row } from './format';

const DOF_NUMBER = { ux: 1, uy: 2, uz: 3 } as const;

const refusal = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

/**
 * `*ELASTIC` and `*DENSITY` cards (no `*MATERIAL` line) of the material of `entityId`, in the case unit system. E and nu come from the
 * default constitutive set (`elastic_isotropic`) else the PHY-01 property models `E`, `nu`, read at the reference temperature (thermo_static)
 * or 20 degC; density is `Material.density` (g per cubic document unit) converted to the unit system.
 * @failure no material -> FEA_MATERIAL_MISSING; no E / nu -> FEA_MATERIAL_NO_ELASTIC; invalid E / nu -> FEA_PROPERTY_INVALID
 */
export function mechanicalMaterialLines(ctx: DeckContext, entityId: string): DeckSections {
  const material = ctx.materialOf(entityId);
  if (material === null) return refusal('FEA_MATERIAL_MISSING', `part '${entityId}' has no material`, [entityId]);
  const elastic = elasticConstants(material, ctx.materialName(entityId), propertyTemperatureK(ctx.analysis));
  if (isElasticRefusal(elastic)) return refusal(elastic.code, elastic.message, [entityId]);
  const density = densityToAnalysis(material.density, ctx.doc.units, ctx.unitSystem);
  return { text: linesText(['*ELASTIC', row(elastic.E * stressPerMpa(ctx.unitSystem), elastic.nu), '*DENSITY', row(density)]) };
}

/** Axis (0|1|2) a node set is flat in, or null when it is not an axis-aligned plane. */
function planeAxis(ctx: DeckContext, nodeIds: readonly number[]): number | null {
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
  const flat = [0, 1, 2].filter((axis) => (hi[axis] ?? 0) - (lo[axis] ?? 0) <= 1e-6 * size);
  return flat.length === 1 ? (flat[0] ?? null) : null;
}

function constraintLines(ctx: DeckContext, constraint: FeaConstraint): string[] | DeckRefusal {
  const key = `C_${constraint.id}`;
  const nodes = Object.hasOwn(ctx.mesh.nodeSets, key) ? (ctx.mesh.nodeSets[key] ?? []) : [];
  if (nodes.length === 0)
    return refusal('FEA_TARGET_UNRESOLVED', `constraint '${constraint.id}' (${constraint.name}) has no nodes in the mesh`, [constraint.id]);
  const set = ctx.nset(key);
  if (constraint.kind === 'fixed' || constraint.kind === 'pinned') return [row(set, 1, 3)];
  if (constraint.kind === 'symmetry') {
    const axis = planeAxis(ctx, nodes);
    if (axis === null)
      return refusal('FEA_CONSTRAINT_INVALID', `symmetry constraint '${constraint.id}' is not an axis-aligned plane in the mesh`, [
        constraint.id,
      ]);
    return [row(set, axis + 1, axis + 1)];
  }
  const lines: string[] = [];
  for (const [dof, value] of Object.entries(constraint.dofs ?? {})) {
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

/**
 * Mechanical `*BOUNDARY, OP=NEW` / `*CLOAD, OP=NEW` / `*DLOAD, OP=NEW` lines for one step.
 * Force: the vector is the TOTAL load split equally over the nodes of the target (`distribution: 'total'`), or applied at every node
 * (`'per_node'`); contributions to one node and dof are summed. Pressure: `P<face>` per (element, face) of the target's face set,
 * positive into the material. Gravity: acceleration vector on every element (`GRAV`, magnitude and unit direction). All of them
 * are restated with `OP=NEW` in each step, so load cases do not accumulate.
 * @param loadCase only the loads of this load case; without it every load of the case is written (thermo_static uses a single step)
 * @failure constraint / load target without nodes or faces in the mesh -> FEA_TARGET_UNRESOLVED; rotational dof or non-axis symmetry plane
 *   -> FEA_CONSTRAINT_INVALID
 */
export function mechanicalStepLines(ctx: DeckContext, loadCase?: string): DeckSections {
  const boundary: string[] = [];
  for (const id of ctx.analysis.constraintOrder) {
    const constraint = ctx.analysis.constraints[id];
    if (constraint === undefined) continue;
    const lines = constraintLines(ctx, constraint);
    if (!Array.isArray(lines)) return lines;
    boundary.push(...lines);
  }
  const forces = new Map<string, readonly [node: number, dof: number, value: number]>();
  const pressures = new Map<string, readonly [element: number, face: number, value: number]>();
  const gravity = [0, 0, 0];
  for (const id of ctx.analysis.loadOrder) {
    const load = ctx.analysis.loads[id];
    if (load === undefined || (loadCase !== undefined && load.loadCase !== loadCase)) continue;
    const key = `L_${id}`;
    if (load.kind === 'gravity' && load.vector !== undefined) {
      load.vector.forEach((component, axis) => (gravity[axis] = (gravity[axis] ?? 0) + component));
    } else if (load.kind === 'force' && load.vector !== undefined) {
      const nodes = Object.hasOwn(ctx.mesh.nodeSets, key) ? (ctx.mesh.nodeSets[key] ?? []) : [];
      if (nodes.length === 0) return refusal('FEA_TARGET_UNRESOLVED', `force '${id}' (${load.name}) has no nodes in the mesh`, [id]);
      const share = load.distribution === 'per_node' ? 1 : 1 / nodes.length;
      for (const node of nodes)
        load.vector.forEach((component, axis) => {
          const mapKey = `${node}:${axis + 1}`;
          forces.set(mapKey, [node, axis + 1, (forces.get(mapKey)?.[2] ?? 0) + component * share]);
        });
    } else if (load.kind === 'pressure' && load.magnitude !== undefined) {
      const faces = ctx.faces(key);
      if (faces.length === 0) return refusal('FEA_TARGET_UNRESOLVED', `pressure '${id}' (${load.name}) has no faces in the mesh`, [id]);
      for (const [element, face] of faces) {
        const mapKey = `${element}:${face}`;
        pressures.set(mapKey, [element, face, (pressures.get(mapKey)?.[2] ?? 0) + load.magnitude]);
      }
    }
  }
  const lines: string[] = [];
  if (boundary.length > 0) lines.push('*BOUNDARY, OP=NEW', ...boundary);
  const cloads = [...forces.values()].filter((entry) => entry[2] !== 0).sort(byNumbers);
  lines.push('*CLOAD, OP=NEW', ...cloads.map(([node, dof, value]) => row(node, dof, value)));
  const dloads = [...pressures.values()].sort(byNumbers).map(([element, face, value]) => row(element, `P${face}`, value));
  const magnitude = Math.hypot(gravity[0] ?? 0, gravity[1] ?? 0, gravity[2] ?? 0);
  if (magnitude > 0)
    dloads.push(`${ALL_ELEMENTS}, GRAV, ${num(magnitude)}, ${gravity.map((component) => num(component / magnitude)).join(', ')}`);
  lines.push('*DLOAD, OP=NEW', ...dloads);
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
    out.push(`** load case ${name}`, '*STEP', '*STATIC');
    out.push(...mechanical.text.split('\n').filter((line) => line !== ''));
    out.push('*NODE FILE', 'U', '*EL FILE', 'S, E', ...probePrintLines(ctx), '*END STEP');
  }
  return { text: linesText(out) };
}
