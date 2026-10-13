/** `meshStandardMaterial` props for the display mode (shaded / wireframe / x-ray) + selection, memoized (R9). */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { Material } from '@core/model/types';
import { type DisplayMode, useViewportStore } from '@ui/store';
import { SELECTION_EMISSIVE, SELECTION_EMISSIVE_INTENSITY, XRAY_EMISSIVE, XRAY_EMISSIVE_INTENSITY, XRAY_OPACITY } from '../viewportPalette';

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
  color: string;
  selected: boolean;
  roughness?: number;
  metalness?: number;
  envMapIntensity?: number;
  /** Document material: replaces color/roughness/metalness in shaded mode only (wireframe/x-ray keep their look). */
  pbrOverride?: PbrMaterial | undefined;
}

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
    const base: MaterialProps = {
      color,
      emissive: selected ? SELECTION_EMISSIVE : '#000000',
      emissiveIntensity: selected ? SELECTION_EMISSIVE_INTENSITY : 0,
      roughness,
      metalness,
      envMapIntensity,
      wireframe: false,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      side: THREE.FrontSide,
    };
    if (displayMode === 'wireframe') return { ...base, wireframe: true };
    if (displayMode === 'xray') {
      const state = selected ? 'selected' : 'idle';
      return {
        ...base,
        emissive: XRAY_EMISSIVE,
        emissiveIntensity: XRAY_EMISSIVE_INTENSITY[state],
        envMapIntensity: 0,
        transparent: true,
        opacity: XRAY_OPACITY[state],
        depthWrite: false,
        side: THREE.DoubleSide,
      };
    }
    // Selection emissive still wins over a material color.
    return pbrOverride ? { ...base, color: pbrOverride.color, roughness: pbrOverride.roughness, metalness: pbrOverride.metalness } : base;
  }, [displayMode, selected, color, roughness, metalness, envMapIntensity, pbrOverride]);
}
