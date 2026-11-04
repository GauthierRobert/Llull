/**
 * Memo of the render-plan scene and its instance BVH per document object (plant 09 VIS-M7): `render_stats` on an unchanged document in one host
 * process rebuilds neither `planScene` nor the BVH. Pure memo: documents are immutable, so a cache hit equals a recompute.
 * Memory: scenes live in a `WeakMap` (collected with their document); the BVH of a 10^6-instance scene is large, so ONE strong slot holds the BVH of the
 * most recent document and a newer BVH replaces it (undo history never piles up BVHs).
 * `planScene` reads no injected global (no kernel, library or mesh-asset port), so the memo needs no other key.
 * @invariant `planSceneOf(doc).scene` deep-equals `planScene(doc)`; the BVH query returns the brute-force result, ascending (VC-VIS-60)
 */

import type { CadDocument } from '../model/types';
import { packBoxes, type InstanceBvh } from './instanceBvh';
import { type InstanceQuery, type PlanScene, planScene } from './renderPlan';
import { type SpatialIndexPort, resolveSpatialIndex } from './spatialIndex';

/**
 * Instance count from which a document asked about twice gets the BVH frustum query (VIS-M7, 09 spec §12.13). The brute-force scan costs
 * ~50 ms at 10^6 and the TS build 1.3-2.3 s, so the tree only pays for a document queried many times; below this count it never does.
 */
const BVH_QUERY_THRESHOLD = 500_000;

interface SceneEntry {
  readonly scene: PlanScene;
  calls: number;
}

const entries = new WeakMap<CadDocument, SceneEntry>();
let bvhSlot: { readonly entry: SceneEntry; readonly bvh: InstanceBvh } | null = null;

/**
 * The plan scene of `doc` (memoized per document object) and the frustum query to give `planRender` (undefined: use the brute-force scan).
 * @invariant the BVH is built on the second call for the same document object, never on the first, and kept only for the latest such document
 */
export function planSceneOf(
  doc: CadDocument,
  threshold: number = BVH_QUERY_THRESHOLD,
  spatialIndex?: SpatialIndexPort | null,
): { readonly scene: PlanScene; readonly query: InstanceQuery | undefined } {
  let entry = entries.get(doc);
  if (entry === undefined) {
    entry = { scene: planScene(doc), calls: 0 };
    entries.set(doc, entry);
  }
  entry.calls++;
  const { scene } = entry;
  if (scene.instances.length < threshold || (bvhSlot?.entry !== entry && entry.calls < 2)) return { scene, query: undefined };
  if (bvhSlot?.entry !== entry)
    bvhSlot = { entry, bvh: resolveSpatialIndex(spatialIndex).build(packBoxes(scene.instances.map((instance) => instance.aabb))) };
  const { bvh } = bvhSlot;
  return { scene, query: (planes) => bvh.frustumQuery(planes) };
}
