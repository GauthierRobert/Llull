/** Key text and structural validation of a `{ op: 'deform' }` recipe node (01 DEF §3), for `recipeKey` and `validateShapeRecipe`. */

import { AXIS_LAW_KINDS, DEFORM_LAW_KINDS, type DeformLawKind } from '../../model/deform';
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

const isIntegerIn = (value: unknown, low: number, high: number): boolean =>
  Number.isInteger(value) && (value as number) >= low && (value as number) <= high;

function latticeProblem(law: Record<string, unknown>): string | null {
  const { box, degrees, offsets } = law;
  if (
    !isRecord(box) ||
    !isVec3(box['min']) ||
    !isVec3(box['max']) ||
    !box['min'].every((low, a) => low < ((box['max'] as number[])[a] as number))
  )
    return 'lattice: box needs finite min < max on every axis';
  if (!Array.isArray(degrees) || degrees.length !== 3 || !degrees.every((degree) => isIntegerIn(degree, 1, 8)))
    return 'lattice: degrees must be 3 integers in 1..8';
  if (!Array.isArray(offsets)) return 'lattice: offsets must be an array';
  for (const entry of offsets) {
    if (!isRecord(entry) || !isVec3(entry['delta']) || !Array.isArray(entry['index']) || entry['index'].length !== 3)
      return 'lattice: an offset needs index [i, j, k] and a finite delta Vec3';
    if (!entry['index'].every((at, a) => isIntegerIn(at, 0, (degrees as number[])[a] as number)))
      return 'lattice: an offset index lies outside the control net';
  }
  return null;
}

function flowProblem(law: Record<string, unknown>): string | null {
  const { stations, step } = law;
  if (!isFiniteNumber(law['z0']) || !isPositiveNumber(law['ratio']) || !isPositiveNumber(step))
    return 'flowCurve: z0 finite, ratio and step > 0';
  return Array.isArray(stations) && stations.length >= 24 && stations.length % 12 === 0 && stations.every(isFiniteNumber)
    ? null
    : 'flowCurve: stations must be finite numbers, 12 per station, at least 2 stations';
}

function surfaceFlowProblem(law: Record<string, unknown>): string | null {
  const { nx, ny, nodes } = law;
  if (!isFiniteNumber(law['x0']) || !isFiniteNumber(law['y0']) || !isPositiveNumber(law['hx']) || !isPositiveNumber(law['hy']))
    return 'flowSurface: x0, y0 finite and hx, hy > 0';
  return isIntegerIn(nx, 2, 1000) &&
    isIntegerIn(ny, 2, 1000) &&
    Array.isArray(nodes) &&
    nodes.length === 6 * (nx as number) * (ny as number) &&
    nodes.every(isFiniteNumber)
    ? null
    : 'flowSurface: nodes must be 6 finite numbers for each of the nx by ny nodes';
}

function rbfProblem(law: Record<string, unknown>): string | null {
  const { centres, weights, affine } = law;
  const numbers = (value: unknown, length?: number): boolean =>
    Array.isArray(value) && value.every(isFiniteNumber) && (length === undefined || value.length === length);
  return numbers(centres) &&
    (centres as unknown[]).length % 3 === 0 &&
    (centres as unknown[]).length >= 3 &&
    numbers(weights, (centres as unknown[]).length) &&
    numbers(affine, 12)
    ? null
    : 'rbf: centres and weights must be finite numbers, three per centre (at least one), and affine twelve numbers';
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
    case 'lattice':
      return latticeProblem(law);
    case 'point':
      return isVec3(law['center']) &&
        isVec3(law['direction']) &&
        isFiniteNumber(law['distance']) &&
        isPositiveNumber(law['radius']) &&
        ['smooth_c2', 'cubic'].includes(String(law['falloff']))
        ? null
        : 'point: center and direction finite Vec3, distance finite, radius > 0, falloff smooth_c2 or cubic';
    case 'flowCurve':
      return flowProblem(law);
    case 'flowSurface':
      return surfaceFlowProblem(law);
    case 'rbf':
      return rbfProblem(law);
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
  if (region['beyond'] !== 'rigid') return 'region: beyond must be rigid';
  if (region['infinite'] === undefined) return null;
  if (region['infinite'] !== true) return 'region: infinite must be true when present';
  if (!AXIS_LAW_KINDS.includes(kind as DeformLawKind))
    return `region: infinite applies to twist, taper, stretch and bend, not a ${String(kind)} law`;
  return region['falloff'] === 'smooth' ? 'region: an infinite region has a linear ramp (falloff linear, or none for a stretch)' : null;
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
  if (AXIS_LAW_KINDS.includes(law['kind'] as DeformLawKind) || node['region'] !== undefined) {
    const regionFault = node['region'] === undefined ? 'region is required' : regionProblem(node['region'], law['kind']);
    if (regionFault !== null) return `deform: ${regionFault}`;
  }
  const output = node['output'];
  if (!isRecord(output) || !['auto', 'exact', 'mesh'].includes(String(output['mode'])) || !isPositiveNumber(output['tolerance']))
    return 'deform: output needs mode auto, exact or mesh and tolerance > 0';
  return typeof output['preserveAnalytic'] === 'boolean' ? null : 'deform: output.preserveAnalytic must be a boolean';
}
