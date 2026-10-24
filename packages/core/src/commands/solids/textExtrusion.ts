/**
 * extrude_profile of a text entity with a font (03 WRP M1): every glyph region is a prism, every hole a prism subtracted from it, all united in one
 * kernel recipe. Works on any kernel (planar prisms and booleans), exact curves on the native one.
 */

import type { CadDocument, Entity, ShapeRecipe, TextEntity, Vec3 } from '../../model/types';
import { nextId } from '../../lib/id';
import { textProfiles, type ProfileChain } from '../../geometry/textProfiles';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { commitEntity } from '../entity/commitEntity';
import { evaluateRecipe, kernelResultEntity } from '../kernelShape';
import { noop } from '../noop';
import type { CommandResult, ExecutionContext } from '../types';
import { newEntity } from '../entity/newEntity';
import { exactCurves } from './extrusionResult';
import { resolveRotation } from './shared';
import { wrapRejection } from '../wrap/codes';
import { isFontFailure, loadFont } from '../wrap/fontStore';
import { isOutlineFailure, outlineOfText } from '../wrap/textPath';
import { wrapData } from '../wrap/conventions';

/** Balanced union of `parts` (a text of hundreds of regions stays far below the recipe depth limit). */
function unionOf(parts: readonly ShapeRecipe[]): ShapeRecipe {
  if (parts.length === 1) return parts[0] as ShapeRecipe;
  const half = Math.ceil(parts.length / 2);
  return { op: 'boolean', boolean: 'union', a: unionOf(parts.slice(0, half)), b: unionOf(parts.slice(half)) };
}

export interface TextExtrusionRequest {
  readonly text: TextEntity;
  readonly depth: number;
  readonly position: Vec3 | undefined;
  readonly rotation: unknown;
  readonly axis: unknown;
  readonly color: string;
}

/**
 * @failure no kernel, unknown / unreadable font, text over the length limit, contours the union cannot repair, depth <= 0, a kernel that refuses the prisms -> coded no-op
 */
export function extrudeText(doc: CadDocument, ctx: ExecutionContext | undefined, request: TextExtrusionRequest): CommandResult {
  const { text, depth } = request;
  const fail = (code: string, message: string): CommandResult => wrapRejection(doc, 'extrude_profile', code, message, [text.id], ['id']);
  if (!(depth > 0)) return noop(doc, `extrude_profile: depth must be a finite number > 0 (got ${String(depth)}); no-op.`);
  const kernel = (ctx ?? currentContext()).kernel;
  if (kernel === null) return noop(doc, kernelUnavailable('extrude_profile'));
  const loaded = loadFont(doc, text.font as string);
  if (isFontFailure(loaded)) return fail(loaded.code, loaded.message);
  if (loaded.font.singleLine)
    return fail(
      'WRP_TEXT_SINGLE_LINE',
      `font '${loaded.record.family}' draws open strokes: they have no area to extrude (use emboss_on_face mode engrave, or an outline font)`,
    );
  const outline = outlineOfText(doc, text, loaded.font);
  if (isOutlineFailure(outline)) return fail(outline.code, outline.message);
  const profiles = textProfiles(outline);
  if (profiles.length === 0) return fail('WRP_PROFILE_EMPTY', `text "${text.content}" has no outline (blank or unmapped characters)`);
  const resolved = resolveRotation(request.axis, request.rotation ?? text.rotation);
  if (resolved.error !== undefined) return noop(doc, `extrude_profile: ${resolved.error}; no-op.`);
  const meshId = nextId('mesh');
  const prism = (chain: ProfileChain, part: string, height: number): ShapeRecipe => {
    const geometry = { profile: chain.profile, depth: height, ...exactCurves(chain.curves) };
    const leaf: Entity = newEntity('extrusion', `${meshId}.${part}`, geometry, [0, 0, 0], request.color);
    return { op: 'solid', entity: leaf };
  };
  /** A hole tool overshoots the prism on both faces, so the subtraction never leaves coincident faces. */
  const tool = (chain: ProfileChain, part: string): ShapeRecipe => ({
    op: 'place',
    source: prism(chain, part, 2 * depth),
    position: [0, 0, -depth / 2],
    rotation: [0, 0, 0],
  });
  const parts = profiles.map(
    (profile, index): ShapeRecipe =>
      profile.holes.reduce<ShapeRecipe>(
        (solid, hole, k) => ({ op: 'boolean', boolean: 'subtract', a: solid, b: tool(hole, `r${index}h${k}`) }),
        prism(profile.outer, `r${index}`, depth),
      ),
  );
  const recipe: ShapeRecipe = {
    op: 'place',
    source: unionOf(parts),
    position: request.position ?? text.position,
    rotation: resolved.rotation,
  };
  const result = evaluateRecipe(kernel, recipe);
  if (typeof result === 'string')
    return fail('WRP_KERNEL_BUILD_FAILED', `the kernel could not build the ${profiles.length} text prism(s) (${result})`);
  const entity = { ...kernelResultEntity(meshId, result, text), color: request.color };
  const committed = commitEntity(doc, entity, '');
  const data = wrapData(
    doc,
    { id: meshId, regions: profiles.length, loops: outline.loopCount, area: outline.area, depth, exact: !outline.united },
    {
      unverified: !loaded.record.provenance.verified,
      provenance: {
        method: 'one prism per glyph region, holes subtracted',
        font: { family: loaded.record.family, sha256: loaded.record.blob },
        inputs: { content: text.content, depth },
      },
    },
  );
  return {
    ...committed,
    summary: `extrude_profile: extruded text "${text.content}" (${loaded.record.family}) from ${text.id} into mesh "${meshId}" — ${profiles.length} region(s), ${outline.holeCount} hole(s), area ${outline.area.toPrecision(10)} ${doc.units}^2, depth ${depth}; source text kept.`,
    data,
  };
}
