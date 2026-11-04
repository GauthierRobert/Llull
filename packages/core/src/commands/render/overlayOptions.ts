/** render_view `overlayOptions`: per-kind options of plugin overlays, validated against the kind's `paramsSchema`; and the cut predicate handed to overlays. */

import type { Vec3 } from '../../model/types';
import type { CadDocument } from '../../model/types';
import { dot3 } from '../../lib/vec3';
import { pluginRenderOverlays } from '../../plugins/host';
import { z } from '../schema';
import { codedRejection } from '../noop';
import type { CommandResult } from '../types';
import { isValidCut, unitPlanes } from './clip';
import type { CutSpec } from './types';

export const overlayOptionsParams = {
  overlayOptions: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Options of plugin overlay kinds, keyed by kind: { <kind>: { …options } }. Each key must be a kind also listed in `overlay` and one whose plugin declares options; ' +
        "the entry is validated against that kind's schema (unknown kind or invalid options: CMD_INVALID_PARAMS with the path). ",
    ),
};

const FIX =
  'give overlayOptions as { <kind>: options } for kinds listed in `overlay` whose plugin declares options; see the plugin tool docs';

/** The validated options per kind, or the coded refusal (CMD_INVALID_PARAMS, path `overlayOptions.<kind>[.<field>]`). */
export function resolveOverlayOptions(
  doc: CadDocument,
  raw: Readonly<Record<string, unknown>> | undefined,
  requested: ReadonlyArray<string>,
): { readonly options: Readonly<Record<string, unknown>> } | CommandResult {
  const options: Record<string, unknown> = {};
  if (raw === undefined) return { options };
  const refuse = (message: string, paths: string[]): CommandResult =>
    codedRejection(doc, 'render_view', 'CMD_INVALID_PARAMS', message, FIX, [], paths);
  for (const [kind, value] of Object.entries(raw)) {
    const overlay = pluginRenderOverlays().find((entry) => entry.kind === kind);
    const path = `overlayOptions.${kind}`;
    if (overlay === undefined) return refuse(`unknown overlay kind '${kind}' in overlayOptions`, [path]);
    if (overlay.paramsSchema === undefined) return refuse(`overlay kind '${kind}' takes no options`, [path]);
    if (!requested.includes(kind)) return refuse(`overlayOptions.${kind} is given but '${kind}' is not in overlay`, [path]);
    const checked = overlay.paramsSchema.safeParse(value);
    if (!checked.success) {
      const paths = [...new Set(checked.error.issues.map((issue) => [path, ...issue.path].join('.')))];
      const first = checked.error.issues[0];
      return refuse(`${paths[0] ?? path}: ${first?.message ?? 'invalid'}`, paths);
    }
    options[kind] = checked.data;
  }
  return { options };
}

/** "This world point survives the cut" for `cut` (a cut limited to entity ids does not touch overlays); undefined = no cut. */
export function cutKeep(cut: CutSpec | undefined): ((p: Vec3) => boolean) | undefined {
  if (cut === undefined || cut.entityIds !== undefined || !isValidCut(cut)) return undefined;
  const planes = unitPlanes(cut);
  return (p) => {
    const removed = planes.map((plane) => dot3(plane.normal, p) > plane.offset);
    return !(cut.mode === 'union' ? removed.some(Boolean) : removed.every(Boolean));
  };
}
