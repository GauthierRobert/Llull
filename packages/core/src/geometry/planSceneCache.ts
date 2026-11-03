/**
 * Memo of the render-plan scene and its instance BVH per document object (plant 09 VIS-M7): `render_stats` on an unchanged document in one host
 * process rebuilds neither `planScene` nor the BVH. Pure memo: documents are immutable, so a cache hit equals a recompute.
 * @invariant `planSceneOf(doc).scene` deep-equals `planScene(doc)`; the BVH query returns the brute-force result, ascending (VC-VIS-60)
 */

import type { CadDocument } from '../model/types';
import { buildInstanceBvh, packBoxes, type InstanceBvh } from './instanceBvh';
import { type InstanceQuery, type PlanScene, planScene } from './renderPlan';

/**
 * Instance count from which a document asked about twice gets the BVH frustum query (VIS-M7, 09 spec §12.11). The brute-force scan costs
 * ~50 ms at 10^6 and the TS build 1.3-2.3 s, so the tree only pays for a document queried many times; below this count it never does.
 */
const BVH_QUERY_THRESHOLD = 500_000;

interface SceneEntry {
  readonly scene: PlanScene;
  calls: number;
  bvh?: InstanceBvh;
}

const entries = new WeakMap<CadDocument, SceneEntry>();

/**
 * The plan scene of `doc` (memoized per document object) and the frustum query to give `planRender` (undefined: use the brute-force scan).
 * @invariant the BVH is built on the second call for the same document object, never on the first
 */
export function planSceneOf(
  doc: CadDocument,
  threshold: number = BVH_QUERY_THRESHOLD,
): { readonly scene: PlanScene; readonly query: InstanceQuery | undefined } {
  let entry = entries.get(doc);
  if (entry === undefined) {
    entry = { scene: planScene(doc), calls: 0 };
    entries.set(doc, entry);
  }
  entry.calls++;
  const { scene } = entry;
  if (scene.instances.length < threshold || (entry.bvh === undefined && entry.calls < 2)) return { scene, query: undefined };
  const bvh = (entry.bvh ??= buildInstanceBvh(packBoxes(scene.instances.map((instance) => instance.aabb))));
  return { scene, query: (planes) => bvh.frustumQuery(planes) };
}
