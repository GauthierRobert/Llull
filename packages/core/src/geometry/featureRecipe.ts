/**
 * The `feature` recipe node (07 FTR §3.1): its content-hash text and the check of an untrusted node (loaded file, live snapshot).
 * @invariant the key text covers every geometric field and EXCLUDES the non-geometric `thread` and `fastener` of a hole
 */

import { HOLE_KINDS, THREAD_FAMILIES } from '../model/features';
import { isFiniteNumber } from '../lib/isFiniteNumber';
import { isRecord } from '../lib/isRecord';
import { isVec3 } from '../lib/vec3';
import type { FeatureRecipe } from './featureLowering';

/** Hash input of a feature node; `sourceKey` is the `recipeKey` of its source. */
export function featureKeyText(node: FeatureRecipe, sourceKey: string): string {
  const frame = JSON.stringify([node.frame.origin, node.frame.normal, node.frame.xDir]);
  if (node.feature === 'pocket') {
    const { outline, depth, cornerRadius, floorFillet } = node.pocket;
    return `feature(${sourceKey},pocket,${frame},${JSON.stringify([outline, depth, cornerRadius, floorFillet])})`;
  }
  const { kind, diameter, cboreDiameter, cboreDepth, cskDiameter, cskAngle } = node.hole;
  const spec = [kind, diameter, cboreDiameter ?? null, cboreDepth ?? null, cskDiameter ?? null, cskAngle ?? null];
  const extent = node.extent.kind === 'blind' ? ['blind', node.extent.depth, node.extent.drillPointAngle ?? null] : ['through_all'];
  return `feature(${sourceKey},hole,${frame},${JSON.stringify(node.points)},${JSON.stringify(spec)},${JSON.stringify(extent)})`;
}

const isPoint2 = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
const positive = (value: unknown): boolean => isFiniteNumber(value) && value > 0;
const optionalPositive = (value: unknown): boolean => value === undefined || positive(value);

function holeError(node: Record<string, unknown>): string | null {
  const { points, hole, extent } = node;
  if (!Array.isArray(points) || points.length === 0 || !points.every(isPoint2))
    return 'feature hole: points must be a non-empty list of finite [u, v]';
  if (!isRecord(hole) || !(HOLE_KINDS as readonly unknown[]).includes(hole['kind']))
    return `feature hole: unknown hole kind '${String(isRecord(hole) ? hole['kind'] : hole)}'`;
  if (![hole['diameter']].every(positive) || !['cboreDiameter', 'cboreDepth', 'cskDiameter'].every((key) => optionalPositive(hole[key])))
    return 'feature hole: diameters and depths must be > 0';
  const angle = hole['cskAngle'];
  if (angle !== undefined && !(isFiniteNumber(angle) && angle > 0 && angle < 180))
    return 'feature hole: cskAngle must be in (0, 180) degrees';
  const thread = hole['thread'];
  if (thread !== undefined) {
    const valid =
      isRecord(thread) && typeof thread['designation'] === 'string' && (THREAD_FAMILIES as readonly unknown[]).includes(thread['family']);
    if (!valid) return 'feature hole: thread needs a designation and a known family';
  }
  if (!isRecord(extent)) return 'feature hole: extent is required';
  if (extent['kind'] === 'through_all') return null;
  if (extent['kind'] !== 'blind') return `feature hole: unknown extent '${String(extent['kind'])}'`;
  const tip = extent['drillPointAngle'];
  if (!positive(extent['depth'])) return 'feature hole: blind depth must be > 0';
  return tip === undefined || (isFiniteNumber(tip) && tip > 0 && tip < 180)
    ? null
    : 'feature hole: drillPointAngle must be in (0, 180) degrees';
}

function pocketError(node: Record<string, unknown>): string | null {
  const pocket = node['pocket'];
  if (!isRecord(pocket)) return 'feature pocket: pocket is required';
  const { outline, depth, cornerRadius, floorFillet } = pocket;
  if (!Array.isArray(outline) || outline.length < 3 || !outline.every(isPoint2))
    return 'feature pocket: outline needs >= 3 finite [u, v] vertices';
  if (depth !== 'through' && !positive(depth)) return "feature pocket: depth must be > 0 or 'through'";
  if (!isFiniteNumber(cornerRadius) || cornerRadius < 0) return 'feature pocket: cornerRadius must be >= 0';
  if (!isFiniteNumber(floorFillet) || floorFillet < 0 || floorFillet > cornerRadius)
    return 'feature pocket: floorFillet must be in [0, cornerRadius]';
  return optionalPositive(pocket['toolDiameter']) ? null : 'feature pocket: toolDiameter must be > 0';
}

/** Error text of a malformed `feature` node (everything but `source`), or null. */
export function featureError(node: Record<string, unknown>): string | null {
  const frame = node['frame'];
  if (!isRecord(frame) || !isVec3(frame['origin']) || !isVec3(frame['normal']) || !isVec3(frame['xDir']))
    return 'feature: frame needs finite origin, normal and xDir';
  if (node['feature'] === 'hole') return holeError(node);
  if (node['feature'] === 'pocket') return pocketError(node);
  return `feature: unknown feature '${String(node['feature'])}'`;
}
