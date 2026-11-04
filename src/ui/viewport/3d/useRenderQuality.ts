// Render quality tier (per-frame shadow cost) from the entity count, unless the viewport store pins one.
// Budget: ≤ 16 ms median frame at 500 entities on a mid-range laptop GPU, which Low reaches by dropping PCSS + contact shadows.

import { type QualityTier, type QualityOverride, useStore, useViewportStore } from '@ui/store';
import { type EdgePreference, type RealismTier, useRealismStore } from '@ui/store/realismStore';

export function deriveQualityTier(entityCount: number): QualityTier {
  return entityCount <= 50 ? 'high' : entityCount <= 200 ? 'medium' : 'low';
}

export function resolveQualityTier(override: QualityOverride, entityCount: number): QualityTier {
  return override !== 'auto' ? override : deriveQualityTier(entityCount);
}

export interface RenderQualitySettings {
  tier: QualityTier;
  /** PCSS samples for <SoftShadows>; 0 = not rendered. */
  softShadowSamples: number;
  /** Square shadow map of the key light. */
  shadowMapSize: number;
  contactShadowsEnabled: boolean;
  /** IBL stays on in low: a texture sample, not PCSS. */
  environmentEnabled: boolean;
  /** The key light casts shadows (Draft turns them off). */
  keyShadows: boolean;
  /** Plant batch buckets of LOD <= this cast shadows (-1 = none); 0 is the nearest LOD. */
  plantShadowMaxLod: -1 | 0 | 1 | 2;
  /** Feature edges (screen-space normal/depth pass) by default: High only; the Edges toggle overrides. */
  edgeLines: boolean;
}

const QUALITY_SETTINGS: Record<QualityTier, RenderQualitySettings> = {
  high: {
    tier: 'high',
    softShadowSamples: 16,
    shadowMapSize: 2048,
    contactShadowsEnabled: true,
    environmentEnabled: true,
    keyShadows: true,
    plantShadowMaxLod: 1,
    edgeLines: false,
  },
  medium: {
    tier: 'medium',
    softShadowSamples: 8,
    shadowMapSize: 1024,
    contactShadowsEnabled: true,
    environmentEnabled: true,
    keyShadows: true,
    plantShadowMaxLod: 1,
    edgeLines: false,
  },
  low: {
    tier: 'low',
    softShadowSamples: 0,
    shadowMapSize: 1024,
    contactShadowsEnabled: false,
    environmentEnabled: true,
    keyShadows: true,
    plantShadowMaxLod: 1,
    edgeLines: false,
  },
};

/** Realism tiers sit on top of the quality tier: Standard keeps it, Draft drops every shadow, High forces the richest set whatever the scene size. */
const REALISM_SETTINGS: Record<Exclude<RealismTier, 'standard'>, RenderQualitySettings> = {
  draft: { ...QUALITY_SETTINGS.low, keyShadows: false, plantShadowMaxLod: -1, edgeLines: false },
  high: { ...QUALITY_SETTINGS.high, softShadowSamples: 24, shadowMapSize: 4096, plantShadowMaxLod: 2, edgeLines: true },
};

/** Final settings of a quality tier under a realism tier. Stable references (per tier pair). */
export function settingsFor(tier: QualityTier, realism: RealismTier): RenderQualitySettings {
  return realism === 'standard' ? QUALITY_SETTINGS[tier] : REALISM_SETTINGS[realism];
}

/** Stable per-tier object: the reference changes only with the tier. */
export function useRenderQuality(): RenderQualitySettings {
  const entityCount = useStore((s) => s.document.order.length);
  const qualityOverride = useViewportStore((s) => s.qualityOverride);
  const realism = useRealismStore((s) => s.realism);
  return settingsFor(resolveQualityTier(qualityOverride, entityCount), realism);
}

/** The tier's edge default under the user's override. */
export function resolveEdgeLines(settings: RenderQualitySettings, preference: EdgePreference): boolean {
  return preference === 'auto' ? settings.edgeLines : preference === 'on';
}

export function useEdgeLines(): boolean {
  const settings = useRenderQuality();
  const preference = useRealismStore((s) => s.edges);
  return resolveEdgeLines(settings, preference);
}
