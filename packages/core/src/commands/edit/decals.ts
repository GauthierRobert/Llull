/**
 * Text decals: paint a line of text onto a solid's surface (logos, part numbers, sidewall lettering).
 * Decals live on the solid (entity-local frame) so they follow its moves and rotations; they are
 * paint — shown in the viewport and exported to glTF, never part of STL / STEP solids.
 */

import { type CadDocument, type Decal, type Entity, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { colorField, defineCommand, vec3, z } from '../schema';
import { changed, noop, failer } from '../noop';
import { nextId } from '../../lib/id';
import { isHexColor } from '../../lib/isHexColor';
import { sub3 } from '../../lib/vec3';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { hasGlyph, rasterizeText } from '../../lib/blockFont';
import { decalPatch } from '../../geometry/decal';
import { localTriangles } from '../../geometry/solidTriangles';
import { replaceEntity } from '../entity/entityOps';

const MAX_DECAL_TEXT = 64;
const MAX_DECALS_PER_ENTITY = 64;

function target(doc: CadDocument, id: string): Entity | string {
  const entity = doc.entities[id];
  if (entity === undefined) return `entity '${id}' not found`;
  if (!is3D(entity) || entity.kind === 'instance') return `entity '${id}' (kind '${entity.kind}') is not a solid; decals paint 3D solids`;
  return entity;
}

/**
 * @affects appends 1 decal to the target solid's `decals`
 * @invariant decal stored in the solid's local frame; it must land on the surface
 * @failure missing / non-solid target, empty or too long text, bad sizes or colours, zero normal,
 *   decal missing the surface, too many decals -> no-op, affected:[]
 */
export const addDecal = defineCommand({
  name: 'add_decal',
  description:
    'Paint a line of text onto a 3D solid as a decal (logo, brand, part number, sidewall lettering): ' +
    'it is projected along -normal onto the faces turned toward it within the decal box, keeps ' +
    'following the solid when it moves or rotates, shows in the viewport and is exported to glTF as a ' +
    'textured overlay (never part of STL / STEP solids). Text uses the built-in block font ' +
    "(A–Z, 0–9, - . , : / + & ! ? ' #; lower case prints as capitals). Place it with `at` (a world " +
    'point on the surface) and `normal` (the outward surface direction there).',
  params: z.object({
    id: z.string().describe('Id of the 3D solid to paint.'),
    text: z.string().describe(`Text, 1..${MAX_DECAL_TEXT} characters.`),
    at: vec3('World point on the surface at the decal centre.'),
    normal: vec3('Outward surface direction at `at` (world); the decal projects along -normal.'),
    height: z.number().describe('Letter block height in document units (> 0).'),
    width: z.number().describe('Decal width (> 0). Default: from the text length at this height.').optional(),
    angle: z.number().describe('Rotation of the text about the normal, radians (default 0).').optional(),
    depth: z.number().describe('Projection depth through curved surfaces (> 0). Default: 2 × height.').optional(),
    color: colorField('#ffffff'),
    background: z.string().describe('Optional #rrggbb background behind the letters (default transparent).').optional(),
  }),
  run: (doc, { id, text, at, normal, height, width, angle = 0, depth, color = '#ffffff', background }): CommandResult => {
    const fail = failer(doc, 'add_decal');
    const entity = target(doc, id);
    if (typeof entity === 'string') return fail(entity);
    if (text.trim().length === 0 || text.length > MAX_DECAL_TEXT) return fail(`text must be 1..${MAX_DECAL_TEXT} characters`);
    if (!(height > 0)) return fail(`height must be > 0 (got ${height})`);
    if (width !== undefined && !(width > 0)) return fail(`width must be > 0 (got ${width})`);
    if (depth !== undefined && !(depth > 0)) return fail(`depth must be > 0 (got ${depth})`);
    if (background !== undefined && !isHexColor(background)) return fail(`background must be a #rrggbb colour (got "${background}")`);
    if (Math.hypot(...normal) < 1e-12) return fail('normal must be non-zero');
    if ((entity.decals?.length ?? 0) >= MAX_DECALS_PER_ENTITY) return fail(`entity '${id}' already has ${MAX_DECALS_PER_ENTITY} decals`);
    const decal: Decal = {
      id: nextId('decal'),
      text,
      center: inverseEulerXYZ(sub3(at, entity.position), entity.rotation),
      normal: inverseEulerXYZ(normal, entity.rotation),
      angle,
      width: width ?? height * rasterizeText(text, color).aspect,
      height,
      depth: depth ?? 2 * height,
      color,
      ...(background !== undefined ? { background } : {}),
    };
    if (decalPatch(decal, localTriangles(entity)).positions.length === 0)
      return fail(`the decal at [${at.join(', ')}] does not reach any face of '${id}' turned toward ${JSON.stringify(normal)}`);
    const unknown = [...new Set([...text].filter((ch) => !hasGlyph(ch)))];
    const updated = { ...entity, decals: [...(entity.decals ?? []), decal] } as Entity;
    return changed(
      replaceEntity(doc, updated),
      `add_decal: painted "${text}" (${decal.width.toFixed(2)} × ${height}) on '${id}' as ${decal.id}.` +
        (unknown.length > 0 ? ` Characters without a glyph print blank: ${unknown.join('')}.` : ''),
      [id],
    );
  },
});

/**
 * @affects removes 1 decal from the target solid
 * @failure missing entity or decal -> no-op, affected:[]
 */
export const removeDecal = defineCommand({
  name: 'remove_decal',
  description: 'Remove one decal (by its id, from add_decal) from a solid.',
  params: z.object({
    id: z.string().describe('Id of the solid carrying the decal.'),
    decalId: z.string().describe('Id of the decal to remove.'),
  }),
  run: (doc, { id, decalId }): CommandResult => {
    const entity = doc.entities[id];
    if (entity === undefined) return noop(doc, `remove_decal: entity '${id}' not found; no-op.`);
    const decals = entity.decals ?? [];
    if (!decals.some((decal) => decal.id === decalId)) return noop(doc, `remove_decal: '${id}' has no decal '${decalId}'; no-op.`);
    const rest = decals.filter((decal) => decal.id !== decalId);
    const updated = (
      rest.length > 0 ? { ...entity, decals: rest } : Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'decals'))
    ) as Entity;
    return changed(replaceEntity(doc, updated), `remove_decal: removed ${decalId} from '${id}'.`, [id]);
  },
});
