// Preset primitive dropped at the nearest free spot, selected, shown in 3D with the move gizmo ready.

import type { Vec3 } from '@core/model/types';
import { useStore, useToolStore } from '@ui/store';
import { keepModelInView } from './viewActions';
import { type SolidPreset, nextPlacement, solidCommandParams } from '@ui/components/toolbar/solidPresets';

/** How long a drop point stays reserved while its entity travels through the server round trip. */
const RESERVATION_MS = 3000;

/** Recent drop points, so rapid clicks in server mode never stack solids in one slot. */
let reservations: Array<{ position: Vec3; expiresAt: number }> = [];

export function createSolid(preset: SolidPreset): void {
  const state = useStore.getState();
  const now = Date.now();
  reservations = reservations.filter((reservation) => reservation.expiresAt > now);
  const position = nextPlacement(
    state.document,
    reservations.map((reservation) => reservation.position),
  );
  reservations.push({ position, expiresAt: now + RESERVATION_MS });
  const hadGeometry = state.document.order.length > 0;
  state.dispatch(preset.command, solidCommandParams(preset, position), { selectAffected: true });
  // The first solid is framed by useAutoFrame (iso); later ones may drop outside the current view.
  if (hadGeometry) keepModelInView();
  const tools = useToolStore.getState();
  tools.setViewMode('3d');
  tools.setGizmoMode('translate');
}
