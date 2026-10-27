/**
 * Text decals: paint a line of text onto a solid's surface (logos, part numbers, sidewall lettering). Decals live on the solid
 * (entity-local frame) so they follow its moves and rotations; they are paint — shown in the viewport and exported to glTF, never part of
 * STL / STEP solids.
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
import { wrapExtent } from '../../geometry/decalWrap';
import { wrapRejection } from '../wrap/codes';
import { fontDecal } from './decalFont';
import { wrapFaceAt } from './decalWrapFace';
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
 * @affects appends 1 decal to the target solid's `decals` (and, for a font not yet in the document, embeds it)
 * @invariant decal stored in the solid's local frame; it must land on the surface; kernel-optional: projecting (the default) needs no kernel, mapping wrap reads the face under the decal
 *   from the exact kernel and refuses (CMD_KERNEL_UNAVAILABLE) without one; a wrap decal keeps its width as an arc length on the cylinder or cone
 * @failure missing / non-solid target, empty or too long text, bad sizes or colours, zero normal, decal missing the surface, too many
 *   decals, unknown font, wrap on a plane / sphere / torus / freeform face or beyond one turn -> no-op, affected:[]
 */
export const addDecal = defineCommand({
  name: 'add_decal',
  annotations: { readsMeshTriangles: true },
  description:
    'Paint a line of text onto a 3D solid as a decal (logo, brand, part number, sidewall lettering): ' +
    'it is projected along -normal onto the faces turned toward it within the decal box, keeps ' +
    'following the solid when it moves or rotates, shows in the viewport and is exported to glTF as a ' +
    'textured overlay (never part of STL / STEP solids). Text uses the built-in block font ' +
    "(A–Z, 0–9, - . , : / + & ! ? ' #; lower case prints as capitals). Place it with `at` (a world " +
    'point on the surface) and `normal` (the outward surface direction there). With `font` (a font id from import_font / list_fonts, or a bundled family such as "Fira Sans") ' +
    'the letters are the outline of that font (lower case, accents and any glyph it has), `height` is then the cap height and the decal box is the ink box of the text. ' +
    "With mapping 'wrap' the decal follows a cylinder or cone face instead of being projected: `width` and `height` are lengths ON the face (a width of 30 on a radius 20 " +
    'cylinder spans 1.5 rad; projected it would span 1.696 rad and miss the face beyond the diameter); it needs the exact kernel, a plane face refuses with WRP_WRAP_NOT_NEEDED, sphere / ' +
    'torus / freeform faces with WRP_FACE_NOT_DEVELOPABLE, a width beyond one turn with WRP_WRAP_OVERLAP. data: mapping, extentRad (azimuth span of a wrapped decal), ' +
    'widthArc, missingCharacters.',
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
    font: z
      .string()
      .describe(
        'Outline font of the letters: a font id (import_font, list_fonts) or a bundled family name such as "Fira Sans". Default: the built-in block font.',
      )
      .optional(),
    mapping: z
      .enum(['project', 'wrap'])
      .describe(
        'project (default): the decal is projected along -normal onto the faces. wrap: it follows the cylinder or cone face under `at` keeping its width and height as lengths on it.',
      )
      .optional(),
  }),
  run: (
    doc,
    { id, text, at, normal, height, width, angle = 0, depth, color = '#ffffff', background, font, mapping },
    ctx,
  ): CommandResult => {
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
    let working = doc;
    let ink: { width: number; height: number } | null = null;
    let mask: Decal['mask'];
    let missing: readonly string[] = [];
    let family: string | undefined;
    if (font !== undefined) {
      const made = fontDecal(doc, ctx, font, text, height);
      if ('code' in made) return wrapRejection(doc, 'add_decal', made.code, made.message, [id], ['font']);
      working = made.document;
      ink = { width: made.inkWidth, height: made.inkHeight };
      mask = made.mask;
      missing = made.missing;
      family = made.family;
    }
    const boxHeight = ink?.height ?? height;
    let placed: Pick<Decal, 'center' | 'normal'> = {
      center: inverseEulerXYZ(sub3(at, entity.position), entity.rotation),
      normal: inverseEulerXYZ(normal, entity.rotation),
    };
    let wrap: Decal['wrap'];
    if (mapping === 'wrap') {
      const face = wrapFaceAt(entity, ctx, at);
      if ('code' in face) return wrapRejection(doc, 'add_decal', face.code, face.message, [id], ['mapping']);
      placed = { center: face.center, normal: face.normal };
      wrap = face.surface;
    }
    const decal: Decal = {
      id: nextId('decal'),
      text,
      ...placed,
      angle,
      width: width ?? (ink === null ? height * rasterizeText(text, color).aspect : (ink.width / ink.height) * boxHeight),
      height: boxHeight,
      depth: depth ?? 2 * height,
      color,
      ...(background !== undefined ? { background } : {}),
      ...(mapping === 'wrap' && wrap !== undefined ? { mapping: 'wrap' as const, wrap } : {}),
      ...(mask !== undefined ? { mask } : {}),
    };
    if (wrap !== undefined && wrapExtent(decal, wrap) > 2 * Math.PI * (1 + 1e-9)) {
      const refused = wrapRejection(
        doc,
        'add_decal',
        'WRP_WRAP_OVERLAP',
        `the decal spans ${wrapExtent(decal, wrap).toPrecision(6)} rad, more than one turn`,
        [id],
        ['width'],
      );
      return { ...refused, data: { extentRad: wrapExtent(decal, wrap) } };
    }
    if (decalPatch(decal, localTriangles(entity)).positions.length === 0)
      return fail(`the decal at [${at.join(', ')}] does not reach any face of '${id}' turned toward ${JSON.stringify(normal)}`);
    const unknown = font === undefined ? [...new Set([...text].filter((ch) => !hasGlyph(ch)))] : missing;
    const updated = { ...entity, decals: [...(entity.decals ?? []), decal] } as Entity;
    const result = changed(
      replaceEntity(working, updated),
      `add_decal: painted "${text}" (${decal.width.toFixed(2)} × ${decal.height.toFixed(2)}${wrap === undefined ? '' : `, wrapped on the ${wrap.type} (${wrapExtent(decal, wrap).toPrecision(6)} rad)`}${family === undefined ? '' : `, ${family}`}) on '${id}' as ${decal.id}.` +
        (unknown.length > 0 ? ` Characters without a glyph print blank: ${unknown.join('')}.` : ''),
      [id],
    );
    return {
      ...result,
      data: {
        decalId: decal.id,
        mapping: wrap === undefined ? 'project' : 'wrap',
        widthArc: decal.width,
        height: decal.height,
        ...(wrap === undefined ? {} : { extentRad: wrapExtent(decal, wrap), surfaceKind: wrap.type }),
        missingCharacters: unknown,
        unit: doc.units,
      },
    };
  },
});

/**
 * @affects removes 1 decal from the target solid
 * @failure missing entity or decal -> no-op, affected:[]
 */
export const removeDecal = defineCommand({
  name: 'delete_decal',
  description: 'Remove one decal (by its id, from add_decal) from a solid.',
  params: z.object({
    id: z.string().describe('Id of the solid carrying the decal.'),
    decalId: z.string().describe('Id of the decal to remove.'),
  }),
  run: (doc, { id, decalId }): CommandResult => {
    const entity = doc.entities[id];
    if (entity === undefined) return noop(doc, `delete_decal: entity '${id}' not found; no-op.`);
    const decals = entity.decals ?? [];
    if (!decals.some((decal) => decal.id === decalId)) return noop(doc, `delete_decal: '${id}' has no decal '${decalId}'; no-op.`);
    const rest = decals.filter((decal) => decal.id !== decalId);
    const updated = (
      rest.length > 0 ? { ...entity, decals: rest } : Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'decals'))
    ) as Entity;
    return changed(replaceEntity(doc, updated), `delete_decal: removed ${decalId} from '${id}'.`, [id]);
  },
});
