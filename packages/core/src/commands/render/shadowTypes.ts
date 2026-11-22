/** Types of the raster sun-shadow pass (`sunShadows.ts`), kept apart so `RenderLight` can carry a plan without an import cycle. */

import type { Vec3 } from '../../model/types';

export interface ShadowMap {
  readonly toSun: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly minU: number;
  readonly minV: number;
  readonly texelU: number;
  readonly texelV: number;
  /** Largest depth along `toSun` per texel (-Infinity = nothing). */
  readonly depth: Float64Array;
  /** Max / min depth pyramids of `depth` (`shadowMips.ts`). */
  readonly maxMips: readonly Float64Array[];
  readonly minMips: readonly Float64Array[];
}

/** What the shadow pass did: a map, nothing to cast, or skipped above `SHADOW_MAX_WORK`. */
export type ShadowPlan =
  | { readonly kind: 'map'; readonly map: ShadowMap; readonly work: number }
  | { readonly kind: 'empty'; readonly work: 0 }
  | { readonly kind: 'skipped'; readonly work: number };

/** What the shadow pass of a render did (`RenderViewData.sunShadows`): `drawn`, `skipped` (work above `SHADOW_MAX_WORK`) or `empty` (nothing casts). */
export interface SunShadowReport {
  readonly state: 'drawn' | 'skipped' | 'empty';
  /** Texels the casters cover plus the rows they span (the cost model of the pass). */
  readonly work: number;
}
