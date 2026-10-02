/**
 * @layer ui/components/toolbar
 *
 * Create a primitive from a preset: drop it at the nearest free spot, select it, and show it in
 * the 3D view with the move gizmo ready. Dispatch only (PRIME DIRECTIVE).
 */

import { useStore, useToolStore } from '@ui/store';
import { nextPlacement, solidCommandParams } from './solidPresets';
import type { SolidPreset } from './solidPresets';

export function createSolid(preset: SolidPreset): void {
  const state = useStore.getState();
  const position = nextPlacement(state.document);
  state.dispatch(preset.command, solidCommandParams(preset, position), { selectAffected: true });
  const tools = useToolStore.getState();
  tools.setViewMode('3d');
  tools.setGizmoMode('translate');
}
