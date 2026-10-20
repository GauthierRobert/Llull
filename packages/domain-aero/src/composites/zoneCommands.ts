/** define_zone, edit_zone, delete_zone: regions of the tool face with a stacking string (the zone-based layup of 06 CMP FR-CMP-10). */

import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { CompositePart, CompositesModel, Zone } from '@core/model/composites';
import type { CadDocument, Vec2 } from '@core/model/types';
import { nextId } from '@lib/id';
import { polygonArea, selfIntersects, toCounterClockwise } from '@lib/polygon';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { insideOrOn } from './geometry2d';
import { parseNotation } from './notation';
import { compositesOf, findPart, findZone, withComposites } from './state';

/** A refusal summary when `boundary` is not a simple polygon inside the part outline, else null. */
function boundaryProblem(boundary: readonly Vec2[], part: CompositePart): string | null {
  if (boundary.length < 3) return 'a zone boundary needs at least 3 vertices';
  if (polygonArea(boundary) < 1e-9) return 'the zone boundary has zero area';
  if (selfIntersects(boundary)) return 'the zone boundary crosses itself';
  const outside = boundary.findIndex((vertex) => !insideOrOn(vertex, part.outline));
  return outside >= 0 ? `vertex ${outside} [${boundary[outside]?.join(', ')}] lies outside the part outline` : null;
}

const boundaryParam = z
  .array(vec2('A vertex [x, y] in the part frame (document units).'))
  .describe('Zone polygon in the part frame (the developed face frame, document units), at least 3 vertices, simple.');

const nameTaken = (model: CompositesModel, partId: string, name: string, except?: string): boolean =>
  Object.values(model.zones).some((zone) => zone.partId === partId && zone.name === name && zone.id !== except);

function withZone(doc: CadDocument, model: CompositesModel, zone: Zone): CadDocument {
  return withComposites(doc, { zones: { ...model.zones, [zone.id]: zone } });
}

/**
 * @affects creates doc.composites.zones[zone-<step>.<k>]
 * @invariant the boundary is stored counter-clockwise; the stack is stored expanded bottom to top, angles in (-90, 90]
 * @failure unknown part -> CMP_REF_MISSING; unparsable stack -> CMP_NOTATION_PARSE; self-intersecting / outside boundary -> CMP_ZONE_BOUNDARY_INVALID
 */
export const defineZone = defineCommand({
  name: 'define_zone',
  description:
    'Define a laminate zone of a composite part: a closed polygon in the part frame (the developed tool-face frame, document units) with a ' +
    'stacking string listed bottom (tool side) to top, e.g. "[45/-45/0/90]s" (+-a pairs, a_n repeats, (group)_n, trailing s symmetric, ' +
    'Ns, T total, ~ unduplicated middle ply). `priority` orders overlapping zones (higher wins where zones overlap; the thickest nested ' +
    'zone normally has the highest). The boundary must be a simple polygon inside the part outline. Zones do not create plies: run ' +
    'generate_plies_from_zones. Returns the zone id and its expanded angles. Refused: unparsable stack (the token is named), boundary ' +
    'self-intersecting or outside the face.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    name: z.string().min(1).describe('Zone name, unique in the part.'),
    boundary: boundaryParam,
    laminate: z.string().describe('Stacking string, bottom to top, e.g. "[0/+-45/90]s".'),
    priority: z.number().describe('Overlap priority (integer; default 0).').optional(),
  }),
  run: (doc, { part: ref, name, boundary, laminate, priority = 0 }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, ref);
    if (part === null) return refuseCmp(doc, 'define_zone', 'CMP_REF_MISSING', `no part '${ref}'`, [], ['params.part']);
    const stack = parseNotation(laminate);
    if (!stack.ok)
      return refuseCmp(
        doc,
        'define_zone',
        'CMP_NOTATION_PARSE',
        `${stack.message} (token ${stack.index} "${stack.token}")`,
        [],
        ['params.laminate'],
      );
    const problem = boundaryProblem(boundary, part);
    if (problem !== null) return refuseCmp(doc, 'define_zone', 'CMP_ZONE_BOUNDARY_INVALID', problem, [part.id], ['params.boundary']);
    if (nameTaken(model, part.id, name))
      return refuseCmp(doc, 'define_zone', 'CMP_NAME_TAKEN', `part "${part.name}" already has a zone "${name}"`, [], ['params.name']);
    const id = nextId('zone');
    const zone: Zone = {
      id,
      partId: part.id,
      name,
      boundary: toCounterClockwise(boundary),
      notation: laminate,
      angles: stack.angles,
      priority,
    };
    return changed(
      withZone(doc, model, zone),
      `define_zone: created zone "${name}" (${id}) on part "${part.name}": ${stack.angles.length} plies [${stack.angles.join(', ')}], area ${sig(polygonArea(boundary))}, priority ${priority}.`,
      [id],
    );
  },
});

/**
 * @affects replaces fields of doc.composites.zones[zone]; plies already generated are not touched
 * @invariant omitted fields keep their value; the same validation as define_zone applies to the new boundary / stack
 * @failure unknown part or zone -> CMP_REF_MISSING; invalid stack / boundary -> CMP_NOTATION_PARSE / CMP_ZONE_BOUNDARY_INVALID
 */
export const editZone = defineCommand({
  name: 'edit_zone',
  description:
    'Edit a zone of a composite part: rename it, replace its boundary (part frame, document units), its stacking string (bottom to top, ' +
    'see define_zone) or its priority. Omitted fields are kept. Plies created earlier are not changed: re-run generate_plies_from_zones ' +
    'with replaceGenerated true afterwards.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    zone: z.string().describe('Zone id or name.'),
    name: z.string().min(1).describe('New zone name.').optional(),
    boundary: boundaryParam.optional(),
    laminate: z.string().describe('New stacking string, bottom to top.').optional(),
    priority: z.number().describe('New overlap priority.').optional(),
  }),
  run: (doc, { part: partRef, zone: zoneRef, name, boundary, laminate, priority }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'edit_zone', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const zone = findZone(model, part.id, zoneRef);
    if (zone === null)
      return refuseCmp(doc, 'edit_zone', 'CMP_REF_MISSING', `no zone '${zoneRef}' in part "${part.name}"`, [], ['params.zone']);
    const stack = laminate === undefined ? null : parseNotation(laminate);
    if (stack !== null && !stack.ok)
      return refuseCmp(
        doc,
        'edit_zone',
        'CMP_NOTATION_PARSE',
        `${stack.message} (token ${stack.index} "${stack.token}")`,
        [zone.id],
        ['params.laminate'],
      );
    const problem = boundary === undefined ? null : boundaryProblem(boundary, part);
    if (problem !== null) return refuseCmp(doc, 'edit_zone', 'CMP_ZONE_BOUNDARY_INVALID', problem, [zone.id], ['params.boundary']);
    if (name !== undefined && nameTaken(model, part.id, name, zone.id))
      return refuseCmp(doc, 'edit_zone', 'CMP_NAME_TAKEN', `part "${part.name}" already has a zone "${name}"`, [zone.id], ['params.name']);
    const next: Zone = {
      ...zone,
      name: name ?? zone.name,
      boundary: boundary === undefined ? zone.boundary : toCounterClockwise(boundary),
      notation: laminate ?? zone.notation,
      angles: stack?.ok === true ? stack.angles : zone.angles,
      priority: priority ?? zone.priority,
    };
    return changed(
      withZone(doc, model, next),
      `edit_zone: zone "${next.name}" (${zone.id}) now ${next.angles.length} plies, priority ${next.priority}.`,
      [zone.id],
    );
  },
});

/**
 * @affects removes doc.composites.zones[zone]
 * @invariant plies generated from the zone stay (regenerate them with generate_plies_from_zones)
 * @failure unknown part or zone -> CMP_REF_MISSING
 */
export const deleteZone = defineCommand({
  name: 'delete_zone',
  description:
    'Delete a zone of a composite part. Plies already generated from it are kept; re-run generate_plies_from_zones with replaceGenerated true to refresh them.',
  annotations: { destructive: true },
  params: z.object({ part: z.string().describe('Part id or name.'), zone: z.string().describe('Zone id or name.') }),
  run: (doc, { part: partRef, zone: zoneRef }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'delete_zone', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const zone = findZone(model, part.id, zoneRef);
    if (zone === null)
      return refuseCmp(doc, 'delete_zone', 'CMP_REF_MISSING', `no zone '${zoneRef}' in part "${part.name}"`, [], ['params.zone']);
    const zones = Object.fromEntries(Object.entries(model.zones).filter(([id]) => id !== zone.id));
    return changed(withComposites(doc, { zones }), `delete_zone: removed zone "${zone.name}" (${zone.id}) from part "${part.name}".`, [
      zone.id,
    ]);
  },
});
