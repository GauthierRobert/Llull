/**
 * Value rules of the `nonlinear` slice, shared by the persistence validation (a loaded file is untrusted) and the deck writer (defence in
 * depth): every number that reaches a deck line is a finite number in range, every keyword-like value is one of its literals.
 */

import { isRecord } from '@lib/isRecord';

export const FIELD_KEYS = ['Rn', 'Cn', 'q0', 'qu', 'Rp', 'eps', 'Ceps', 'Rl'] as const;
export const TIME_KEYS = ['I0', 'IR', 'IP', 'IC', 'IL', 'IG', 'IS', 'IA', 'IJ', 'IT'] as const;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const wholeAtLeastOne = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 1;
const oneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

/** Problems of a convergence preset: name, known keys, positive finite values (integers for the time-incrementation parameters). */
export function convergenceValueProblems(preset: unknown, where: string): string[] {
  if (!isRecord(preset) || !oneOf(['ccx_default', 'custom'], preset['name'])) return [`${where}: name must be ccx_default or custom`];
  const problems: string[] = [];
  const bags = [
    ['field', FIELD_KEYS, false],
    ['timeIncrementation', TIME_KEYS, true],
  ] as const;
  let count = 0;
  for (const [bag, keys, integers] of bags) {
    const values = preset[bag];
    if (values === undefined) continue;
    if (!isRecord(values)) {
      problems.push(`${where}.${bag}: expected a record of numbers`);
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      count++;
      if (!keys.some((known) => known === key)) problems.push(`${where}.${bag}: unknown key '${key.slice(0, 40)}'`);
      else if (!finite(value) || !(value > 0) || (integers && !Number.isInteger(value)))
        problems.push(`${where}.${bag}.${key}: must be a finite number > 0${integers ? ' (integer)' : ''}`);
    }
  }
  if (preset['name'] === 'ccx_default' && count > 0) problems.push(`${where}: ccx_default takes no values`);
  if (preset['name'] === 'custom' && count === 0) problems.push(`${where}: custom needs at least one value in field or timeIncrementation`);
  return problems;
}

/** Problems of one step: amplitude, multipliers, control kind / increments / displacement dof and value. */
function stepValueProblems(id: string, step: Record<string, unknown>, where: string): string[] {
  const at = `${where}.steps '${id.slice(0, 40)}'`;
  const problems: string[] = [];
  if (typeof step['name'] !== 'string') problems.push(`${at}: name must be text`);
  if (!oneOf(['ramp', 'step'], step['amplitude'])) problems.push(`${at}: amplitude must be ramp or step`);
  const multipliers = step['multipliers'];
  if (!isRecord(multipliers)) problems.push(`${at}: multipliers must be a record`);
  else
    for (const [loadCase, value] of Object.entries(multipliers))
      if (!finite(value)) problems.push(`${at}: multiplier of '${loadCase.slice(0, 40)}' must be finite`);
  const control = step['control'];
  if (!isRecord(control) || !oneOf(['load', 'displacement', 'arc_length'], control['kind']))
    return [...problems, `${at}: control kind is invalid`];
  if (control['kind'] === 'arc_length') {
    if (!finite(control['initialArcLength']) || !wholeAtLeastOne(control['maxSteps']))
      problems.push(`${at}: arc-length control values are invalid`);
    return problems;
  }
  const { initialIncrement: initial, minIncrement: min, maxIncrement: max } = control;
  if (!finite(initial) || !finite(min) || !finite(max) || !(min > 0 && min <= initial && initial <= max && max <= 1))
    problems.push(`${at}: increments must be finite with 0 < minIncrement <= initialIncrement <= maxIncrement <= 1`);
  if (!wholeAtLeastOne(control['maxIncrements'])) problems.push(`${at}: maxIncrements must be an integer >= 1`);
  if (control['kind'] === 'displacement') {
    if (!oneOf(['ux', 'uy', 'uz'], control['dof'])) problems.push(`${at}: dof must be ux, uy or uz`);
    if (!finite(control['value'])) problems.push(`${at}: displacement value must be finite`);
  }
  return problems;
}

function probeValueProblems(id: string, probe: Record<string, unknown>, where: string): string[] {
  const at = `${where}.probes '${id.slice(0, 40)}'`;
  const problems: string[] = [];
  if (typeof probe['name'] !== 'string') problems.push(`${at}: name must be text`);
  const load = probe['load'];
  if (!isRecord(load)) problems.push(`${at}: load must be a record`);
  else if (load['kind'] === 'load') {
    if (typeof load['loadId'] !== 'string') problems.push(`${at}: loadId must be text`);
  } else if (load['kind'] === 'reaction') {
    if (typeof load['constraintId'] !== 'string') problems.push(`${at}: constraintId must be text`);
    if (!oneOf(['x', 'y', 'z', 'magnitude'], load['component'])) problems.push(`${at}: component must be x, y, z or magnitude`);
  } else problems.push(`${at}: load kind must be load or reaction`);
  const displacement = probe['displacement'];
  if (!isRecord(displacement)) return [...problems, `${at}: displacement must be a record`];
  const point = displacement['point'];
  if (!Array.isArray(point) || point.length !== 3 || !point.every(finite)) problems.push(`${at}: point must be three finite numbers`);
  if (!oneOf(['ux', 'uy', 'uz', 'magnitude'], displacement['dof']))
    problems.push(`${at}: displacement dof must be ux, uy, uz or magnitude`);
  return problems;
}

/** Every value problem of a raw `nonlinear` slice (nlgeom, convergence, output, steps, probes). Structure of the bags is checked elsewhere. */
export function nonlinearValueProblems(nonlinear: unknown, where: string): string[] {
  if (!isRecord(nonlinear)) return [`${where}: expected a settings record`];
  const problems: string[] = [];
  if (nonlinear['nlgeom'] !== undefined && typeof nonlinear['nlgeom'] !== 'boolean')
    problems.push(`${where}: nlgeom must be true or false`);
  problems.push(...convergenceValueProblems(nonlinear['convergence'], `${where}.convergence`));
  const output = nonlinear['outputIncrements'];
  if (!(output === 'all' || output === 'last_per_step' || (isRecord(output) && wholeAtLeastOne(output['every']))))
    problems.push(`${where}: outputIncrements must be all, last_per_step or { every: integer >= 1 }`);
  for (const [bag, check] of [
    ['steps', stepValueProblems],
    ['probes', probeValueProblems],
  ] as const) {
    const entries = nonlinear[bag];
    if (!isRecord(entries)) continue;
    for (const [id, entry] of Object.entries(entries)) if (isRecord(entry)) problems.push(...check(id, entry, where));
  }
  return problems;
}
