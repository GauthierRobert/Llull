// +Z-up view directions (eye offset from target): Front eye at -Y, Right at +X, Top at +Z with a tiny -Y tilt so lookAt
// with up=+Z is never parallel.

export type PresetName = 'front' | 'top' | 'right' | 'iso';
export type PresetDirection = readonly [number, number, number];

const TOP_TILT = 1e-3;

export const PRESET_DIRECTIONS: Record<PresetName, PresetDirection> = {
  front: [0, -1, 0],
  top: [0, -TOP_TILT, 1],
  right: [1, 0, 0],
  iso: [1, -1, 1],
};
