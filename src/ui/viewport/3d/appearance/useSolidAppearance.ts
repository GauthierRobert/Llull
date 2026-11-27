// The appearance a solid draws with: entity override over the document material's, resolved against the document's texture table,
// with the image maps loaded through the shared cache. Null when the solid has no appearance (it keeps the plain / finish path).

import { useMemo } from 'react';
import type { Appearance } from '@core/model/appearance';
import { useStore } from '@ui/store';
import type { PbrMaterial } from '../useMaterialProps';
import { mapRequests, resolveAppearance, surfacePlan, type MapChannel, type SurfaceFallback, type SurfacePlan } from './surfacePlan';
import { useAppearanceMaps, type AppearanceMaps } from './useAppearanceMaps';

export interface SolidAppearance {
  readonly plan: SurfacePlan;
  readonly maps: AppearanceMaps;
  /** An image map is referenced: the geometry needs UVs (stored or box-projected). */
  readonly needsUvs: boolean;
}

export function useSolidAppearance(
  entity: { readonly appearance?: Appearance | undefined },
  pbrMaterial: PbrMaterial | undefined,
  fallback: SurfaceFallback,
): SolidAppearance | null {
  const textures = useStore((s) => s.document.appearance?.textures);
  const appearance = resolveAppearance(entity, pbrMaterial);
  const requests = useMemo(() => (appearance === undefined ? [] : mapRequests(appearance, textures ?? {})), [appearance, textures]);
  const maps = useAppearanceMaps(requests);
  const { color, metalness, roughness } = fallback;
  return useMemo((): SolidAppearance | null => {
    if (appearance === undefined) return null;
    const loaded = new Set(Object.keys(maps) as MapChannel[]);
    return { plan: surfacePlan(appearance, { color, metalness, roughness }, loaded), maps, needsUvs: requests.length > 0 };
  }, [appearance, maps, requests, color, metalness, roughness]);
}
