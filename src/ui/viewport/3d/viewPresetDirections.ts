/**
 * @layer ui/viewport/3d
 * Pure +Z-up CAD view directions (unit-agnostic eye offset from the target).
 * Front: eye at -Y looking +Y. Right: eye at +X. Top: eye at +Z looking down, with a
 * tiny -Y tilt so lookAt with camera.up=+Z is never parallel (screen up = +Y, right = +X).
 */

export type PresetName = 'front' | 'top' | 'right' | 'iso';
export type PresetDirection = readonly [number, number, number];

const TOP_TILT = 1e-3;

export const PRESET_DIRECTIONS: Record<PresetName, PresetDirection> = {
  front: [0, -1, 0],
  top: [0, -TOP_TILT, 1],
  right: [1, 0, 0],
  iso: [1, -1, 1],
};
