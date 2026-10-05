/**
 * @layer ui/viewport/3d
 *
 * useRenderQuality — the render quality tier (per-frame shadow cost) from the entity count and the
 * user's override in the viewport store. 'auto' derives the tier from the count; an explicit
 * override pins it.
 *
 *   High   (≤ 50 entities)   : PCSS 16 samples, 2048² shadow map, ContactShadows on.
 *   Medium (51–200 entities) : PCSS 8 samples, 1024² shadow map, ContactShadows on.
 *   Low    (> 200 entities)  : SoftShadows off, 1024² shadow map, ContactShadows off.
 *
 * Budget: ≤ 16 ms median frame at 500 entities on a mid-range laptop GPU, which Low reaches by
 * dropping PCSS and contact shadows.
 */

import { useStore, useViewportStore } from '@ui/store';
import type { QualityTier, QualityOverride } from '@ui/store';

/** Thresholds that map entity count to a quality tier (auto mode). */
const HIGH_THRESHOLD = 50;
const MEDIUM_THRESHOLD = 200;

/**
 * Derive the quality tier from entity count.
 * Pure function — no side effects; exported for unit testing.
 *
 * @pure
 * @layer ui/viewport/3d
 */
export function deriveQualityTier(entityCount: number): QualityTier {
  if (entityCount <= HIGH_THRESHOLD) return 'high';
  if (entityCount <= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Resolve the effective quality tier from override + entity count.
 * Pure function — exported for unit testing.
 *
 * @pure
 * @layer ui/viewport/3d
 */
export function resolveQualityTier(override: QualityOverride, entityCount: number): QualityTier {
  if (override !== 'auto') return override;
  return deriveQualityTier(entityCount);
}

/** Render settings derived from a quality tier. */
export interface RenderQualitySettings {
  /** Active quality tier (resolved from override + entity count). */
  tier: QualityTier;
  /** PCSS sample count for <SoftShadows>; 0 means SoftShadows is disabled. */
  softShadowSamples: number;
  /** Shadow map resolution (square) for the key directional light. */
  shadowMapSize: number;
  /** Whether <ContactShadows> is rendered. */
  contactShadowsEnabled: boolean;
  /** Whether <Environment> IBL preset is loaded. */
  environmentEnabled: boolean;
}

const QUALITY_SETTINGS: Record<QualityTier, RenderQualitySettings> = {
  high: {
    tier: 'high',
    softShadowSamples: 16,
    shadowMapSize: 2048,
    contactShadowsEnabled: true,
    environmentEnabled: true,
  },
  medium: {
    tier: 'medium',
    softShadowSamples: 8,
    shadowMapSize: 1024,
    contactShadowsEnabled: true,
    environmentEnabled: true,
  },
  low: {
    tier: 'low',
    softShadowSamples: 0, // 0 → SoftShadows component not rendered
    shadowMapSize: 1024,
    contactShadowsEnabled: false,
    environmentEnabled: true, // keep IBL on in low — it's a texture sample, not PCSS
  },
};

/**
 * Returns the render quality settings for the current scene.
 *
 * Reads two narrow selectors (R3):
 *   - document.order.length — entity count proxy
 *   - viewportStore.qualityOverride — user preference
 *
 * Returns the stable per-tier settings object, so the reference only changes with the tier.
 */
export function useRenderQuality(): RenderQualitySettings {
  const entityCount = useStore((s) => s.document.order.length);
  const qualityOverride = useViewportStore((s) => s.qualityOverride);

  return QUALITY_SETTINGS[resolveQualityTier(qualityOverride, entityCount)];
}
