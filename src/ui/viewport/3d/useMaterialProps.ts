/**
 * @layer ui/viewport/3d
 *
 * Returns memoized `meshStandardMaterial` prop overrides for the active
 * display mode and selection state.
 *
 * - shaded  : standard PBR (current default, no override).
 * - wireframe: `wireframe: true`; no lighting changes needed.
 * - xray    : transparent, low opacity, depthWrite off, side DoubleSide
 *             so that back-faces are visible when looking through the mesh.
 *
 * Memoized on (displayMode, selected, baseColor) so materials are stable
 * across renders where none of those change — avoids per-frame rebuilds
 * (react R9).
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { Material } from '@core/model/types';
import { type DisplayMode, useViewportStore } from '@ui/store';
import {
  SELECTION_EMISSIVE,
  SELECTION_EMISSIVE_INTENSITY,
  XRAY_EMISSIVE,
  XRAY_EMISSIVE_INTENSITY,
  XRAY_OPACITY,
} from '../viewportPalette';

/** Document-material fields that drive a mesh's PBR surface. */
export type PbrMaterial = Pick<Material, 'color' | 'metalness' | 'roughness' | 'finish'>;

interface MaterialProps {
  color: string;
  emissive: string;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
  envMapIntensity: number;
  wireframe: boolean;
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
  side: THREE.Side;
}

interface UseMaterialPropsInput {
  /** Entity hex color, e.g. '#c8553d'. */
  color: string;
  /** Whether the entity is currently selected. */
  selected: boolean;
  /** Base roughness for the material. */
  roughness?: number;
  /** Base metalness for the material. */
  metalness?: number;
  /** Base envMapIntensity for the material. */
  envMapIntensity?: number;
  /**
   * Optional PBR overrides from an assigned document material.
   * When provided, replaces color/roughness/metalness for the shaded display mode.
   * Wireframe and x-ray modes ignore these to preserve their visual intent.
   */
  pbrOverride?: PbrMaterial | undefined;
}

/**
 * Returns material props for the given entity appearance inputs,
 * adjusted for the active display mode from the viewport store.
 *
 * @pure (aside from reading the store) — no mutations.
 */
export function useMaterialProps({
  color,
  selected,
  roughness = 0.45,
  metalness = 0.08,
  envMapIntensity = 0.8,
  pbrOverride,
}: UseMaterialPropsInput): MaterialProps {
  const displayMode: DisplayMode = useViewportStore((s) => s.displayMode);

  return useMemo((): MaterialProps => {
    const emissive = selected ? SELECTION_EMISSIVE : '#000000';
    const emissiveIntensity = selected ? SELECTION_EMISSIVE_INTENSITY : 0;

    switch (displayMode) {
      case 'wireframe':
        // Wireframe ignores PBR material override — keep uniform appearance.
        return {
          color,
          emissive,
          emissiveIntensity,
          roughness,
          metalness,
          envMapIntensity,
          wireframe: true,
          transparent: false,
          opacity: 1,
          depthWrite: true,
          side: THREE.FrontSide,
        };

      case 'xray':
        // X-ray ignores PBR material override — keep transparent appearance.
        return {
          color,
          emissive: XRAY_EMISSIVE,
          emissiveIntensity: XRAY_EMISSIVE_INTENSITY[selected ? 'selected' : 'idle'],
          roughness,
          metalness,
          envMapIntensity: 0,
          wireframe: false,
          transparent: true,
          opacity: XRAY_OPACITY[selected ? 'selected' : 'idle'],
          depthWrite: false,
          side: THREE.DoubleSide,
        };

      case 'shaded':
      default: {
        // In shaded mode, PBR override wins for base color/roughness/metalness.
        // Selection highlight (emissive) still wins on top of any material color.
        const shadedColor = pbrOverride ? pbrOverride.color : color;
        const shadedRoughness = pbrOverride ? pbrOverride.roughness : roughness;
        const shadedMetalness = pbrOverride ? pbrOverride.metalness : metalness;
        return {
          color: shadedColor,
          emissive,
          emissiveIntensity,
          roughness: shadedRoughness,
          metalness: shadedMetalness,
          envMapIntensity,
          wireframe: false,
          transparent: false,
          opacity: 1,
          depthWrite: true,
          side: THREE.FrontSide,
        };
      }
    }
  }, [displayMode, selected, color, roughness, metalness, envMapIntensity, pbrOverride]);
}
