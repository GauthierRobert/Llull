// Render quality tier (per-frame shadow cost) from the entity count, unless the viewport store pins one.
// Budget: ≤ 16 ms median frame at 500 entities on a mid-range laptop GPU, which Low reaches by dropping PCSS + contact shadows.

import { type QualityTier, type QualityOverride, useStore, useViewportStore } from '@ui/store';

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
}

const QUALITY_SETTINGS: Record<QualityTier, RenderQualitySettings> = {
  high: { tier: 'high', softShadowSamples: 16, shadowMapSize: 2048, contactShadowsEnabled: true, environmentEnabled: true },
  medium: { tier: 'medium', softShadowSamples: 8, shadowMapSize: 1024, contactShadowsEnabled: true, environmentEnabled: true },
  low: { tier: 'low', softShadowSamples: 0, shadowMapSize: 1024, contactShadowsEnabled: false, environmentEnabled: true },
};

/** Stable per-tier object: the reference changes only with the tier. */
export function useRenderQuality(): RenderQualitySettings {
  const entityCount = useStore((s) => s.document.order.length);
  const qualityOverride = useViewportStore((s) => s.qualityOverride);
  return QUALITY_SETTINGS[resolveQualityTier(qualityOverride, entityCount)];
}
