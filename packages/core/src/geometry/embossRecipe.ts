/** Structural checks and the cache key of an `{ op: 'emboss' }` recipe node (03 WRP, `model/wrap`), for `validateShapeRecipe` and `recipeKey`. */

import type { EmbossParams, NurbsCurve2Data, UvLoop } from '../model/wrap';
import type { ShapeRecipe } from '../model/types';
import { isFiniteNumber } from '../lib/isFiniteNumber';
import { isRecord } from '../lib/isRecord';
import { isVec2 } from '../lib/vec2';
import { isVec3 } from '../lib/vec3';
import { surfaceDataProblem } from './surfaceWire';

type EmbossNode = Extract<ShapeRecipe, { op: 'emboss' }>;

/** Most regions / segments / poles a stored node may declare: far above any real text, far below an allocation attack. */
const MAX_REGIONS = 20_000;
const MAX_SEGMENTS = 400_000;
const MAX_POLES = 2000;

/** Every `emboss` node of the recipe, source-most first. */
export function embossNodes(recipe: ShapeRecipe): EmbossNode[] {
  switch (recipe.op) {
    case 'emboss':
      return [...embossNodes(recipe.source), recipe];
    case 'boolean':
      return [...embossNodes(recipe.a), ...embossNodes(recipe.b)];
    case 'blend':
      return recipe.sources.flatMap(embossNodes);
    case 'solid':
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return [];
    default:
      return embossNodes(recipe.source);
  }
}

/** The node's parameters without `op` and `source`. */
export function embossParamsOf(node: EmbossNode): EmbossParams {
  const { face, surface, regions, chains, mode, depth, direction, tolerance } = node;
  return { face, surface, regions, ...(chains === undefined ? {} : { chains }), mode, depth, direction, tolerance };
}

/** Cache-key text of the node given the key of its source. */
export const embossKeyText = (node: EmbossNode, sourceKey: string): string =>
  `emboss(${sourceKey},${JSON.stringify(embossParamsOf(node))})`;

function curveProblem(curve: unknown): string | null {
  if (!isRecord(curve)) return 'a nurbs segment needs a curve';
  const { degree, poles, weights, knots, multiplicities } = curve as Partial<Record<keyof NurbsCurve2Data, unknown>>;
  if (!Number.isInteger(degree) || (degree as number) < 1 || (degree as number) > 25) return 'curve degree must be an integer in 1..25';
  if (!Array.isArray(poles) || poles.length < 2 || poles.length > MAX_POLES || !poles.every(isVec2))
    return `curve poles must be 2..${MAX_POLES} [u, v] points`;
  if (
    weights !== undefined &&
    (!Array.isArray(weights) || weights.length !== poles.length || !weights.every((w) => isFiniteNumber(w) && w > 0))
  )
    return 'curve weights must be one positive number per pole';
  if (!Array.isArray(knots) || !Array.isArray(multiplicities) || knots.length !== multiplicities.length || knots.length < 2)
    return 'curve knots and multiplicities must be lists of the same length';
  if (!knots.every(isFiniteNumber) || knots.some((knot, k) => k > 0 && !(knot > (knots[k - 1] as number))))
    return 'curve knots must increase strictly';
  if (!multiplicities.every((m) => Number.isInteger(m) && (m as number) >= 1)) return 'curve multiplicities must be positive integers';
  const total = (multiplicities as number[]).reduce((sum, m) => sum + m, 0);
  return total === poles.length + (degree as number) + 1 ? null : 'curve multiplicities must sum to poles + degree + 1';
}

function loopProblem(loop: unknown, budget: { segments: number }): string | null {
  if (!isRecord(loop) || !isVec2(loop['start']) || !Array.isArray(loop['segments']) || loop['segments'].length === 0)
    return 'a loop needs a start and segments';
  for (const segment of loop['segments'] as unknown[]) {
    if (++budget.segments > MAX_SEGMENTS) return `more than ${MAX_SEGMENTS} loop segments`;
    if (!isRecord(segment)) return 'a loop segment must be an object';
    if (segment['kind'] === 'line') {
      if (!isVec2(segment['to'])) return 'a line segment needs a [u, v] end point';
    } else if (segment['kind'] === 'nurbs') {
      const problem = curveProblem(segment['curve']);
      if (problem !== null) return problem;
    } else return `unknown loop segment kind '${String(segment['kind'])}'`;
  }
  return null;
}

/** Why an untrusted `emboss` node is unusable (not including its source), or null. */
export function embossProblem(node: Record<string, unknown>): string | null {
  const fail = (why: string): string => `emboss: ${why}`;
  if (!Number.isInteger(node['face']) || (node['face'] as number) < 0) return fail('face must be a non-negative integer');
  const surface = node['surface'];
  if (!isRecord(surface) || !['plane', 'cylinder', 'cone', 'sphere', 'torus', 'face'].includes(String(surface['type'])))
    return fail('surface.type must be plane, cylinder, cone, sphere, torus or face');
  if (!Array.isArray(surface['data']) || !surface['data'].every(isFiniteNumber))
    return fail('surface.data must be a list of finite numbers');
  const layout = surfaceDataProblem(surface['type'] as 'plane', surface['data'] as number[]);
  if (layout !== null) return fail(layout);
  const mode = node['mode'];
  if (mode !== 'emboss' && mode !== 'deboss' && mode !== 'scribe' && mode !== 'split')
    return fail('mode must be emboss, deboss, scribe or split');
  if ((surface['type'] === 'face') !== (mode === 'split')) return fail("surface.type 'face' goes with mode split, and only with it");
  const depth = node['depth'];
  const flat = mode === 'scribe' || mode === 'split';
  if (!isFiniteNumber(depth) || depth < 0 || (!flat && !(depth > 0)))
    return fail('depth must be finite, > 0 (0 only for scribe and split)');
  if (!isVec3(node['direction'])) return fail('direction must be a finite Vec3');
  if (!isFiniteNumber(node['tolerance']) || !(node['tolerance'] > 0)) return fail('tolerance must be > 0');
  const budget = { segments: 0 };
  if (mode === 'split') {
    const chains = node['chains'];
    if (!Array.isArray(chains) || chains.length === 0 || chains.length > MAX_REGIONS)
      return fail(`chains must be a list of 1..${MAX_REGIONS}`);
    const problem = (chains as unknown[]).map((chain) => loopProblem(chain as UvLoop, budget)).find((why) => why !== null);
    return problem === undefined || problem === null ? null : fail(problem);
  }
  const regions = node['regions'];
  if (!Array.isArray(regions) || regions.length === 0 || regions.length > MAX_REGIONS)
    return fail(`regions must be a list of 1..${MAX_REGIONS}`);
  for (const region of regions as unknown[]) {
    if (!isRecord(region) || !Array.isArray(region['holes'])) return fail('a region needs an outer loop and a holes list');
    const problem = [region['outer'], ...(region['holes'] as unknown[])]
      .map((loop) => loopProblem(loop as UvLoop, budget))
      .find((why) => why !== null);
    if (problem !== undefined && problem !== null) return fail(problem);
  }
  return null;
}
