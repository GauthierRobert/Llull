/** Ply angles between a ply's own rosette and the part rosette (the frame ply orientations are stored in). */

import type { CommandResult } from '@core/commands/types';
import type { CompositePart, Rosette } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import { dot3 } from '@lib/vec3';
import { refuseCmp } from './codes';

/** Rotation (degrees) of a rosette's 0-degree axis against the part frame x axis: 'degenerate' when normal to the face, 'unsupported' on curved faces. */
function rosetteRotation(part: CompositePart, rosette: Rosette): number | 'degenerate' | 'unsupported' {
  if (rosette.id === part.rosetteId) return 0;
  if (part.surface.type !== 'plane') return 'unsupported';
  const { xDir, yDir } = part.surface;
  const [x, y] = [dot3(rosette.axis0, xDir), dot3(rosette.axis0, yDir)];
  return Math.hypot(x, y) < 1e-9 ? 'degenerate' : (Math.atan2(y, x) * 180) / Math.PI;
}

/** The angle measured from \`rosette\`, expressed from the part rosette (what plies store). */
export function orientationInPartFrame(
  part: CompositePart,
  rosette: Rosette,
  orientation: number,
): { orientation: number } | 'degenerate' | 'unsupported' {
  const rotation = rosetteRotation(part, rosette);
  return typeof rotation === 'string' ? rotation : { orientation: orientation + rotation };
}

/** A stored (part-frame) angle expressed from \`rosette\`; the stored angle itself when the rosette is unusable. */
export function orientationInRosette(part: CompositePart, rosette: Rosette | undefined, stored: number): number {
  if (rosette === undefined) return stored;
  const rotation = rosetteRotation(part, rosette);
  return typeof rotation === 'string' ? stored : stored - rotation;
}

/** The refusal for a frame conversion that failed, or null when it succeeded. */
export function frameRefusal(
  doc: CadDocument,
  command: string,
  frame: { orientation: number } | 'degenerate' | 'unsupported',
  part: CompositePart,
  path: string,
): CommandResult | null {
  if (typeof frame !== 'string') return null;
  return refuseCmp(
    doc,
    command,
    frame === 'degenerate' ? 'CMP_ROSETTE_DEGENERATE' : 'CMP_PARAM_INVALID',
    frame === 'degenerate'
      ? 'the ply rosette 0-degree axis is parallel to the tool face normal'
      : 'a ply rosette other than the part rosette is only supported on plane tool faces',
    [part.id],
    [path],
  );
}
