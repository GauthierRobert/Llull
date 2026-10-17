/** convert_quantity (08 MAT M1 grammar, VC-MAT-03): a unit conversion an agent can check. */

import { convertValue, isUnitFailure, parseUnit } from '../../lib/quantity';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { refuseMaterial } from './refusal';

/**
 * @affects nothing — read-only; data { value, unit, factor, offset }
 * @invariant exact constants (in = 25.4 mm, lb = 453.59237 g, lbf = 4.4482216152605 N); relative error <= 1e-12; factor = d(result)/d(value)
 * @failure unparsable unit MAT_UNIT_INVALID; different dimensions MAT_UNIT_DIMENSION (rejection)
 */
export const convertQuantity = defineCommand({
  name: 'convert_quantity',
  annotations: { readOnly: true, idempotent: true },
  description:
    "Convert a value between units of the same dimension: density ('lb/in^3' → 'g/cm^3'), stress ('ksi' → 'MPa'), length, mass, temperature " +
    "('degF' → 'K'). Units: SI prefixes on m, g, N, Pa, K; in, ft, lb, lbf, psi, ksi, Msi, MPa, GPa, degC, degF, %; products with '*', quotients " +
    "with '/', powers with '^' (e.g. 'W/(m*K)', 'kg/m^3'). Returns data.value in `to`, the multiplicative factor and the offset (non-zero only for degC / degF).",
  params: z.object({
    value: z.number().describe('The value to convert.'),
    from: z.string().describe("Unit of `value`, e.g. 'lb/in^3'."),
    to: z.string().describe("Target unit of the same dimension, e.g. 'g/cm^3'."),
  }),
  run: (doc, { value, from, to }): CommandResult => {
    const converted = convertValue(value, from, to);
    if (isUnitFailure(converted))
      return refuseMaterial(doc, 'convert_quantity', converted.code, converted.message, {
        path: isUnitFailure(parseUnit(from)) ? 'from' : 'to',
      });
    const zero = convertValue(0, from, to);
    const one = convertValue(1, from, to);
    const offset = isUnitFailure(zero) ? 0 : zero.value;
    const factor = isUnitFailure(one) ? 1 : one.value - offset;
    return report(doc, `convert_quantity: ${value} ${from} = ${converted.value} ${to}.`, {
      value: converted.value,
      unit: to,
      factor,
      offset,
    });
  },
});
