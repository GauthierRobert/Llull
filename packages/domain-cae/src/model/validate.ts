/** Value validation of a raw `analysis` slice (persistence rejects the file when this returns errors). */

import { isRecord } from '@lib/isRecord';
import { durabilityErrors } from './validateDurability';

const TYPES = [
  'static',
  'modal',
  'buckling',
  'heat_steady',
  'heat_transient',
  'thermo_static',
  'coupled_temperature_displacement',
  'nonlinear_static',
];
const UNIT_SYSTEMS = ['N-mm-t-s', 'N-m-kg-s', 'lbf-in-slinch-s'];
const CONSTRAINT_KINDS = ['fixed', 'pinned', 'symmetry', 'displacement'];
const LOAD_KINDS = ['force', 'pressure', 'gravity', 'moment'];
const CATEGORIES = ['limit', 'ultimate'];
const SCALES = ['degC', 'K'];
const QUANTITIES = [
  'temperature',
  'heat_flux',
  'u_mag',
  'u_x',
  'u_y',
  'u_z',
  'von_mises',
  's_xx',
  's_yy',
  's_zz',
  's_hoop',
  's_radial',
  's_axial',
  'u_radial',
];
const IDEALIZATION_KINDS = ['solid', 'plane_stress', 'shell', 'beam'];

const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === 'number' && Number.isFinite(c));
const oneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

/** Paths of every non-finite number below `value`. */
function nonFinitePaths(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => nonFinitePaths(item, `${path}[${index}]`, out));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) nonFinitePaths(item, `${path}.${key}`, out);
  }
}

interface Scope {
  readonly entities: Record<string, unknown>;
  readonly errors: string[];
}

function checkTarget(scope: Scope, target: unknown, where: string): void {
  if (!isRecord(target) || typeof target['entityId'] !== 'string') return void scope.errors.push(`${where}: target needs an entityId`);
  if (!Object.hasOwn(scope.entities, target['entityId']))
    scope.errors.push(`${where}: target entity '${target['entityId']}' does not exist`);
  for (const key of ['facesNear', 'edgesNear', 'pointsNear']) {
    const points = target[key];
    if (points !== undefined && !(Array.isArray(points) && points.every(isVec3)))
      scope.errors.push(`${where}: ${key} must be a list of finite [x, y, z] points`);
  }
}

function checkBag(
  scope: Scope,
  where: string,
  bag: unknown,
  order: unknown,
  check: (id: string, value: Record<string, unknown>) => void,
): void {
  if (!isRecord(bag) || !Array.isArray(order) || !order.every((id) => typeof id === 'string'))
    return void scope.errors.push(`${where}: expected a record and an id list`);
  const ids = order as string[];
  if (new Set(ids).size !== ids.length) scope.errors.push(`${where}: duplicate ids in the order list`);
  for (const id of ids) if (!Object.hasOwn(bag, id)) scope.errors.push(`${where}: '${id}' is listed but missing`);
  for (const [id, value] of Object.entries(bag)) {
    if (!ids.includes(id)) scope.errors.push(`${where}: '${id}' is missing from the order list`);
    if (!isRecord(value) || value['id'] !== id) scope.errors.push(`${where}: entry '${id}' is malformed`);
    else check(id, value);
  }
}

function checkThermal(scope: Scope, thermal: unknown, where: string): void {
  if (!isRecord(thermal)) return void scope.errors.push(`${where}: expected a thermal set-up`);
  if (!oneOf(SCALES, thermal['temperatureScale'])) scope.errors.push(`${where}: temperatureScale must be degC or K`);
  checkBag(scope, `${where}.bcs`, thermal['bcs'], thermal['bcOrder'], (id, record) => {
    const bc = record['bc'];
    if (!isRecord(bc) || typeof bc['kind'] !== 'string') return void scope.errors.push(`${where}.bcs: '${id}' has no bc`);
    if (isRecord(bc['target'])) checkTarget(scope, bc['target'], `${where}.bcs '${id}'`);
    if (bc['kind'] === 'heat_generation' && (typeof bc['entityId'] !== 'string' || !Object.hasOwn(scope.entities, bc['entityId'])))
      scope.errors.push(`${where}.bcs '${id}': heat_generation entity does not exist`);
  });
  checkBag(scope, `${where}.limits`, thermal['limits'], thermal['limitOrder'], (id, limit) => {
    const limitScope = limit['scope'];
    if (isRecord(limitScope) && isRecord(limitScope['target'])) checkTarget(scope, limitScope['target'], `${where}.limits '${id}'`);
    else if (isRecord(limitScope) && typeof limitScope['entityId'] === 'string' && !Object.hasOwn(scope.entities, limitScope['entityId']))
      scope.errors.push(`${where}.limits '${id}': entity '${limitScope['entityId']}' does not exist`);
  });
  for (const field of ['amplitudes', 'cavities', 'contacts', 'dispositions', 'step'])
    if (!isRecord(thermal[field])) scope.errors.push(`${where}: ${field} must be a record`);
}

function checkMesh(scope: Scope, mesh: unknown, where: string): void {
  if (!isRecord(mesh)) return void scope.errors.push(`${where}: mesh controls missing`);
  const size = mesh['globalSize'];
  if (typeof size !== 'number' || !(size > 0)) scope.errors.push(`${where}: mesh.globalSize must be > 0`);
  if (mesh['order'] !== 1 && mesh['order'] !== 2) scope.errors.push(`${where}: mesh.order must be 1 or 2`);
  if (mesh['bonding'] !== undefined && mesh['bonding'] !== 'conformal')
    scope.errors.push(`${where}: mesh.bonding must be 'conformal' when present`);
  const refinements = mesh['refinements'];
  if (!Array.isArray(refinements)) return void scope.errors.push(`${where}: mesh.refinements must be a list`);
  refinements.forEach((refinement, index) => {
    if (!isRecord(refinement) || typeof refinement['size'] !== 'number' || !(refinement['size'] > 0))
      scope.errors.push(`${where}: mesh.refinements[${index}] needs size > 0`);
    else checkTarget(scope, refinement['target'], `${where}: mesh.refinements[${index}]`);
  });
}

function checkNonlinear(scope: Scope, analysisCase: Record<string, unknown>, where: string): void {
  const nonlinear = analysisCase['nonlinear'];
  if (analysisCase['type'] !== 'nonlinear_static')
    return void scope.errors.push(`${where}: only nonlinear_static cases carry nonlinear settings`);
  if (!isRecord(nonlinear)) return void scope.errors.push(`${where}: expected a settings record`);
  if (nonlinear['nlgeom'] !== undefined && typeof nonlinear['nlgeom'] !== 'boolean')
    scope.errors.push(`${where}: nlgeom must be true or false`);
  checkBag(scope, `${where}.steps`, nonlinear['steps'], nonlinear['stepOrder'], (id, step) => {
    const control = step['control'];
    if (!isRecord(control) || !oneOf(['load', 'displacement', 'arc_length'], control['kind']))
      scope.errors.push(`${where}.steps: '${id}' has no valid control`);
    else if (control['kind'] === 'displacement') checkTarget(scope, control['target'], `${where}.steps '${id}'`);
    if (!isRecord(step['multipliers'])) scope.errors.push(`${where}.steps: '${id}' needs multipliers`);
  });
  checkBag(scope, `${where}.probes`, nonlinear['probes'], nonlinear['probeOrder'], (id, probe) => {
    const displacement = probe['displacement'];
    if (!isRecord(probe['load']) || !isRecord(displacement) || !isVec3(displacement['point']))
      scope.errors.push(`${where}.probes: '${id}' is malformed`);
  });
  const sets = nonlinear['constitutiveSets'];
  if (!isRecord(sets)) return void scope.errors.push(`${where}: constitutiveSets must be a record`);
  for (const [entityId, setId] of Object.entries(sets))
    if (!Object.hasOwn(scope.entities, entityId) || typeof setId !== 'string')
      scope.errors.push(`${where}.constitutiveSets: '${entityId}' is invalid`);
}

function checkCase(scope: Scope, id: string, analysisCase: Record<string, unknown>): void {
  const where = `analysis case '${id}'`;
  const { errors } = scope;
  if (!oneOf(TYPES, analysisCase['type'])) errors.push(`${where}: unknown type`);
  if (!oneOf(UNIT_SYSTEMS, analysisCase['unitSystem'])) errors.push(`${where}: unknown unitSystem`);
  if (typeof analysisCase['name'] !== 'string') errors.push(`${where}: name must be text`);
  const parts = analysisCase['parts'];
  if (!isRecord(parts)) errors.push(`${where}: parts must be a record`);
  else
    for (const [entityId, idealization] of Object.entries(parts)) {
      if (!Object.hasOwn(scope.entities, entityId)) errors.push(`${where}: part '${entityId}' does not exist`);
      if (!isRecord(idealization) || !oneOf(IDEALIZATION_KINDS, idealization['kind']))
        errors.push(`${where}: part '${entityId}' has an invalid idealization`);
    }
  checkBag(scope, `${where}.constraints`, analysisCase['constraints'], analysisCase['constraintOrder'], (cid, constraint) => {
    if (!oneOf(CONSTRAINT_KINDS, constraint['kind'])) errors.push(`${where}: constraint '${cid}' has an unknown kind`);
    checkTarget(scope, constraint['target'], `${where}: constraint '${cid}'`);
  });
  checkBag(scope, `${where}.loads`, analysisCase['loads'], analysisCase['loadOrder'], (lid, load) => {
    if (!oneOf(LOAD_KINDS, load['kind'])) errors.push(`${where}: load '${lid}' has an unknown kind`);
    if (!oneOf(CATEGORIES, load['category'])) errors.push(`${where}: load '${lid}' has an unknown category`);
    if (load['target'] !== undefined) checkTarget(scope, load['target'], `${where}: load '${lid}'`);
    if (load['vector'] !== undefined && !isVec3(load['vector'])) errors.push(`${where}: load '${lid}' vector must be three finite numbers`);
  });
  checkMesh(scope, analysisCase['mesh'], where);
  const probes = analysisCase['probes'];
  if (!isRecord(probes)) errors.push(`${where}: probes must be a record`);
  else
    for (const [pid, probe] of Object.entries(probes))
      if (!isRecord(probe) || !isVec3(probe['point']) || !oneOf(QUANTITIES, probe['quantity']))
        errors.push(`${where}: probe '${pid}' is malformed`);
      else if (
        (probe['axisPoint'] !== undefined && !isVec3(probe['axisPoint'])) ||
        (probe['axisDirection'] !== undefined &&
          !(isVec3(probe['axisDirection']) && (probe['axisDirection'] as number[]).some((c) => c !== 0)))
      )
        errors.push(`${where}: probe '${pid}' has a malformed axis`);
  const heat = analysisCase['type'] === 'heat_steady' || analysisCase['type'] === 'heat_transient';
  if (heat !== (analysisCase['thermal'] !== undefined))
    errors.push(`${where}: a thermal set-up is required for heat_* cases and only for them`);
  if (analysisCase['thermal'] !== undefined) checkThermal(scope, analysisCase['thermal'], `${where}.thermal`);
  const thermomech = analysisCase['thermomech'];
  const coupled = analysisCase['type'] === 'coupled_temperature_displacement';
  if ((analysisCase['type'] === 'thermo_static' || coupled) !== (thermomech !== undefined))
    errors.push(`${where}: a thermomech set-up is required for thermo_static and coupled cases and only for them`);
  if (isRecord(thermomech)) {
    if (!isRecord(thermomech['referenceTemperature'])) errors.push(`${where}: thermomech.referenceTemperature is required`);
    if (coupled && thermomech['thermal'] === undefined) errors.push(`${where}: thermomech.thermal is required for coupled cases`);
    if (thermomech['thermal'] !== undefined) checkThermal(scope, thermomech['thermal'], `${where}.thermomech.thermal`);
  }
  if (analysisCase['nonlinear'] !== undefined) checkNonlinear(scope, analysisCase, `${where}.nonlinear`);
  for (const summary of ['meshSummary', 'results'])
    if (
      analysisCase[summary] !== undefined &&
      !(isRecord(analysisCase[summary]) && typeof analysisCase[summary]?.['inputHash'] === 'string')
    )
      errors.push(`${where}: ${summary} is malformed`);
}

/** Errors of the `analysis` slice of a raw document: ids unique and consistent, references existing, numbers finite, types well formed. */
export function analysisErrors(raw: Record<string, unknown>): string[] {
  const analysis = raw['analysis'];
  if (analysis === undefined) return [];
  if (!isRecord(analysis) || !isRecord(analysis['cases']) || !Array.isArray(analysis['caseOrder']))
    return ['analysis: expected { cases, caseOrder }'];
  const scope: Scope = { entities: isRecord(raw['entities']) ? raw['entities'] : {}, errors: [] };
  const paths: string[] = [];
  nonFinitePaths(analysis, 'analysis', paths);
  scope.errors.push(...paths.map((path) => `${path} is not a finite number`));
  const order = analysis['caseOrder'] as unknown[];
  checkBag(scope, 'analysis.cases', analysis['cases'], order, (id, analysisCase) => checkCase(scope, id, analysisCase));
  return [...scope.errors, ...durabilityErrors(raw)];
}
