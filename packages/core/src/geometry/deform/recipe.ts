/** Key text and structural validation of a `{ op: 'deform' }` recipe node (01 DEF §3), for `recipeKey` and `validateShapeRecipe`. */

import { DEFORM_LAW_KINDS } from '../../model/deform';
import { canonicalJson } from '../../lib/canonicalJson';
import { isFiniteNumber, isPositiveNumber } from '../../lib/isFiniteNumber';
import { isRecord } from '../../lib/isRecord';
import { isVec3 } from '../../lib/vec3';
import type { DeformNode } from './laws';

/** `recipeKey` text: the whole node but its source, whose key the caller supplies. */
export function deformKeyText(node: DeformNode, sourceKey: string): string {
  const { law, frame, region, output } = node;
  return `deform(${sourceKey},${canonicalJson({ law, frame, region: region ?? null, output })})`;
}

const isRows = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(isVec3);

function lawProblem(law: Record<string, unknown>): string | null {
  switch (law['kind']) {
    case 'affine':
      return isRows(law['matrix']) && isVec3(law['translation'])
        ? null
        : 'affine: matrix must be 3 finite rows and translation a finite Vec3';
    case 'twist':
      return isFiniteNumber(law['angleRad']) ? null : 'twist: angleRad must be finite';
    case 'taper':
      return isPositiveNumber(law['scaleEnd']) && typeof law['flat'] === 'boolean'
        ? null
        : 'taper: scaleEnd must be > 0 and flat a boolean';
    case 'stretch':
      return isPositiveNumber(law['factor']) ? null : 'stretch: factor must be > 0';
    case 'bend':
      return isPositiveNumber(law['radius']) && typeof law['symmetric'] === 'boolean'
        ? null
        : 'bend: radius must be > 0 and symmetric a boolean';
    default:
      return `unknown law kind '${String(law['kind'])}' (expected ${DEFORM_LAW_KINDS.join(', ')})`;
  }
}

function regionProblem(region: unknown, kind: unknown): string | null {
  if (!isRecord(region)) return 'region must be an object';
  const { start, end } = region;
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || !(end > start)) return 'region: start and end must be finite with end > start';
  // a step is the stretch law only; a ramp that jumped would tear the body
  const allowed = kind === 'stretch' ? ['none'] : ['linear', 'smooth'];
  if (!allowed.includes(String(region['falloff']))) return `region: falloff must be ${allowed.join(' or ')} for a ${String(kind)} law`;
  return region['beyond'] === 'rigid' ? null : 'region: beyond must be rigid';
}

/** Why an untrusted deform node (source excluded) is unusable, or null (DEF_RECIPE_INVALID). */
export function deformProblem(node: Readonly<Record<string, unknown>>): string | null {
  const law = node['law'];
  if (!isRecord(law)) return 'deform: law must be an object';
  const problem = lawProblem(law);
  if (problem !== null) return `deform ${problem}`;
  const frame = node['frame'];
  if (!isRecord(frame) || !isVec3(frame['origin']) || !isVec3(frame['axis']) || !isVec3(frame['reference']))
    return 'deform: frame needs finite origin, axis and reference Vec3';
  if (law['kind'] !== 'affine' || node['region'] !== undefined) {
    const regionFault = node['region'] === undefined ? 'region is required' : regionProblem(node['region'], law['kind']);
    if (regionFault !== null) return `deform: ${regionFault}`;
  }
  const output = node['output'];
  if (!isRecord(output) || !['auto', 'exact', 'mesh'].includes(String(output['mode'])) || !isPositiveNumber(output['tolerance']))
    return 'deform: output needs mode auto, exact or mesh and tolerance > 0';
  return typeof output['preserveAnalytic'] === 'boolean' ? null : 'deform: output.preserveAnalytic must be a boolean';
}
