/** Applies sampled values of random variables to an in-memory copy of the document: document parameters (set_parameter) and the scalar density of a material. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { momentsOf } from './distributions';
import { withParameters } from './responseEval';
import type { RandomVariable } from '@cae/reliability/types';

/** Whether a response-backed study can feed this variable into the document: a parameter binding, or a material density. */
export const isDocumentInput = (variable: RandomVariable): boolean =>
  variable.binding.kind === 'parameter' || (variable.binding.kind === 'materialProperty' && variable.binding.property === 'density');

/**
 * `doc` with each variable's value `x[i]` applied: set_parameter for a parameter binding; for a material density the scalar density is scaled by x / mean of the
 * variable (the unit-free relative scatter of the model value). Null when a set_parameter is refused or a material is missing.
 * @invariant an in-memory copy for one evaluation (TR-PRB-08); the original document is never touched
 */
export function withVariableValues(
  doc: CadDocument,
  variables: readonly RandomVariable[],
  x: readonly number[],
  ctx: ExecutionContext | undefined,
): CadDocument | null {
  const parameters: Record<string, number> = {};
  const factors: Array<readonly [string, number]> = [];
  variables.forEach((variable, i) => {
    const value = x[i] ?? Number.NaN;
    if (variable.binding.kind === 'parameter') parameters[variable.binding.parameter] = value;
    else if (variable.binding.kind === 'materialProperty' && variable.binding.property === 'density')
      factors.push([variable.binding.material, value / momentsOf(variable.distribution).mean]);
  });
  const withParams = withParameters(doc, parameters, ctx);
  if (withParams === null) return null;
  let materials = withParams.materials;
  for (const [name, factor] of factors) {
    const material = Object.hasOwn(materials, name) ? materials[name] : undefined;
    if (material === undefined || !Number.isFinite(factor)) return null;
    materials = { ...materials, [name]: { ...material, density: material.density * factor } };
  }
  return factors.length === 0 ? withParams : { ...withParams, materials };
}
