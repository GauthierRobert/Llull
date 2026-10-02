/**
 * @layer ui/actions
 *
 * Create a primitive from a preset: drop it at the nearest free spot, select it, and show it in
 * the 3D view with the move gizmo ready. Dispatch only (PRIME DIRECTIVE).
 */

import type { Vec3 } from '@core/model/types';
import { useStore, useToolStore } from '@ui/store';
import { nextPlacement, solidCommandParams } from '@ui/components/toolbar/solidPresets';
import type { SolidPreset } from '@ui/components/toolbar/solidPresets';

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
  state.dispatch(preset.command, solidCommandParams(preset, position), { selectAffected: true });
  const tools = useToolStore.getState();
  tools.setViewMode('3d');
  tools.setGizmoMode('translate');
}
