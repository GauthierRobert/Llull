/** Column internals and attachments (`add_process_column`): tray stack layout and platform clips. */

import { z } from '@core/commands/schema';
import type { PlatformClip, TraySpec } from '../plantData';
import { toNorthClockwise, type AngleConvention } from './angles';

export const traysSchema = z
  .object({
    count: z.number().int().positive().max(200).describe('Number of trays.'),
    spacing: z.number().positive().describe('Tray spacing, document units.'),
    firstElevation: z.number().min(0).describe('Elevation of the first tray above the bottom tangent line, document units.'),
    type: z.string().optional().describe('Tray type label, e.g. "sieve", "valve". Informational.'),
  })
  .describe('Tray stack. Tray i is at firstElevation + (i - 1) x spacing above the bottom tangent line and must not exceed tangentLength.');

export const platformClipsSchema = z
  .array(
    z.object({
      elevation: z.number().min(0).describe('Clip elevation above the bottom tangent line, document units.'),
      fromDeg: z.number().describe('Start angle of the clip arc around the column, read with angleConvention.'),
      toDeg: z.number().describe('End angle of the clip arc; the arc runs from fromDeg to toDeg in the direction the convention grows.'),
      depth: z.number().positive().optional().describe('Radial projection of the clip. Default 100 mm.'),
      height: z.number().positive().optional().describe('Clip height. Default 100 mm.'),
    }),
  )
  .max(50)
  .describe('Platform support clips on the shell (read by the structures plugin for platform layout).');

export type PlatformClipInput = z.infer<typeof platformClipsSchema>[number];

export interface TrayRow {
  readonly index: number;
  readonly elevation: number;
}

/** Tray elevations above the bottom tangent line, 1-based index. */
export const trayRows = (trays: Pick<TraySpec, 'count' | 'spacing' | 'firstElevation'>): TrayRow[] =>
  Array.from({ length: trays.count }, (_unused, index) => ({ index: index + 1, elevation: trays.firstElevation + index * trays.spacing }));

/** The elevation of the last tray when the stack exceeds the tangent length (EQP_TRAYS_DONT_FIT), else null. */
export function trayOverflow(trays: Pick<TraySpec, 'count' | 'spacing' | 'firstElevation'>, tangentLength: number): number | null {
  const last = trays.firstElevation + (trays.count - 1) * trays.spacing;
  return last > tangentLength + 1e-9 ? last : null;
}

/**
 * Stored platform clips (north_cw, clockwise from `fromDeg` to `toDeg`), or the first problem as `{ message, path }`.
 * @failure elevation above the tangent length, or a zero-length arc
 */
export function resolveClips(
  clips: readonly PlatformClipInput[],
  convention: AngleConvention,
  tangentLength: number,
  defaults: { readonly depth: number; readonly height: number },
): PlatformClip[] | { readonly message: string; readonly path: string } {
  const stored: PlatformClip[] = [];
  for (const [index, clip] of clips.entries()) {
    if (clip.elevation > tangentLength)
      return {
        message: `clip elevation ${clip.elevation} is above the tangent length ${tangentLength}`,
        path: `platformClips.${index}.elevation`,
      };
    const [first, second] = [toNorthClockwise(clip.fromDeg, convention), toNorthClockwise(clip.toDeg, convention)];
    // east_ccw reverses the sense: the arc from -> to counter-clockwise is the clockwise arc to' -> from'.
    const [fromDeg, toDeg] = convention === 'north_cw' ? [first, second] : [second, first];
    if (Math.abs(toDeg - fromDeg) < 1e-9)
      return { message: 'fromDeg and toDeg give an empty (or full-circle) arc', path: `platformClips.${index}.toDeg` };
    stored.push({ elevation: clip.elevation, fromDeg, toDeg, depth: clip.depth ?? defaults.depth, height: clip.height ?? defaults.height });
  }
  return stored;
}
