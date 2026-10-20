/** create_composite_part, set_ply_drop_rules, set_laminate_rules: the tool surface of a laminate and its per-part rules. */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { CompositePart, PlyDropRules, RuleConfig } from '@core/model/composites';
import { nextId } from '@lib/id';
import { polygonArea } from '@lib/polygon';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { resolveToolFace } from './faceResolve';
import { DEFAULT_DROP_RULES, DEFAULT_RULES, RULE_KEY } from './rules';
import { compositesOf, findPart, findRosette, withComposites } from './state';

/**
 * @affects creates doc.composites.parts[part-<step>.<k>]
 * @invariant the part frame is the developed frame of the face: plane = rosette origin projected on the face with x = the projected 0-degree axis; cylinder (s = r*azimuth, axial) and cone (polar about the apex) = flat pattern coordinates
 * @failure unknown entity or rosette -> CMP_REF_MISSING; no / two faces at the point -> CMP_FACE_NOT_FOUND / CMP_FACE_AMBIGUOUS; unsupported solid -> CMP_FACE_UNSUPPORTED
 */
export const createCompositePart = defineCommand({
  name: 'create_composite_part',
  description:
    'Create a composite part on a tool face: the face of solid `toolSurface.entityId` that contains (is nearest to) the point ' +
    '`toolSurface.faceNear` [x, y, z] in document units (re-resolved on every replay). Box faces, cylinder sides / caps and cone sides / ' +
    'base resolve on any kernel; other solids need the OCC kernel (plane, cylinder and cone faces). The part frame is the DEVELOPED frame of ' +
    'the face, in which zone and ply polygons and flat patterns are expressed: for a plane, x = the rosette 0-degree axis projected on the ' +
    'face and the origin = the rosette origin projected on it; for a cylinder, x = arc length from the azimuth-0 direction and y = axial ' +
    'distance; for a cone, polar coordinates about the apex (angle = azimuth * sin(half-angle)). On cylinders and cones 0 degrees is along ' +
    'the axis / meridian. `laminateSide` "positive_normal" (default) puts the laminate on the outward side of the tool face. `rosette` is ' +
    'a rosette id or name (define_rosette). arcTolerance (document length units, default 0.05) is the chord error of curved outlines. ' +
    'Returns the part id; next: define_zone / add_ply.',
  params: z.object({
    name: z.string().min(1).describe('Unique part name.'),
    toolSurface: z
      .object({
        entityId: z.string().describe('Id of the tool solid (box, cylinder, cone, or any solid on the OCC kernel).'),
        faceNear: vec3('A point [x, y, z] on the intended face, document units; the nearest face within a small tolerance is taken.'),
      })
      .describe('The tool face to lay the laminate on.'),
    rosette: z.string().describe('Rosette id or name defining the 0-degree direction.'),
    laminateSide: z
      .enum(['positive_normal', 'negative_normal'])
      .describe('Laminate on the outward ("positive_normal", default) or inward side of the face.')
      .optional(),
    arcTolerance: z.number().describe('Chord error of curved outlines, document length units; default 0.05; must be > 0.').optional(),
  }),
  run: (doc, { name, toolSurface, rosette: rosetteRef, laminateSide = 'positive_normal', arcTolerance = 0.05 }, ctx): CommandResult => {
    const model = compositesOf(doc);
    const entity = doc.entities[toolSurface.entityId];
    if (entity === undefined)
      return refuseCmp(
        doc,
        'create_composite_part',
        'CMP_REF_MISSING',
        `no entity '${toolSurface.entityId}'`,
        [toolSurface.entityId],
        ['params.toolSurface.entityId'],
      );
    const rosette = findRosette(model, rosetteRef);
    if (rosette === null)
      return refuseCmp(doc, 'create_composite_part', 'CMP_REF_MISSING', `no rosette '${rosetteRef}'`, [], ['params.rosette']);
    if (!(arcTolerance > 0))
      return refuseCmp(doc, 'create_composite_part', 'CMP_PARAM_INVALID', 'arcTolerance must be > 0', [], ['params.arcTolerance']);
    if (findPart(model, name) !== null)
      return refuseCmp(doc, 'create_composite_part', 'CMP_NAME_TAKEN', `a part named "${name}" exists`, [], ['params.name']);
    const face = resolveToolFace(entity, toolSurface.faceNear, rosette, ctx?.kernel ?? null, arcTolerance);
    if (!face.ok)
      return refuseCmp(doc, 'create_composite_part', face.code, face.message, [toolSurface.entityId], ['params.toolSurface.faceNear']);
    const id = nextId('part');
    const part: CompositePart = {
      id,
      name,
      toolFaces: [
        {
          entityId: toolSurface.entityId,
          faceNear: toolSurface.faceNear,
          ...(face.faceIndex === undefined ? {} : { faceIndex: face.faceIndex }),
        },
      ],
      laminateSide,
      rosetteId: rosette.id,
      surface: face.surface,
      outline: face.outline,
    };
    const next = withComposites(doc, { parts: { ...model.parts, [id]: part } });
    return changed(
      next,
      `create_composite_part: created part "${name}" (${id}) on a ${face.surface.type} face of '${toolSurface.entityId}', outline ${face.outline.length} vertices, area ${sig(polygonArea(face.outline))} (document units^2), rosette "${rosette.name}".`,
      [id],
    );
  },
});

/**
 * @affects sets doc.composites.parts[part].plyDropRules
 * @invariant rampRatio >= 1; omitted fields take the named defaults (20, 3 dropped thicknesses, inner_first, 1 cover ply)
 * @failure unknown part -> CMP_REF_MISSING; rampRatio < 1, negative stagger or cover count -> CMP_PARAM_INVALID
 */
export const setPlyDropRules = defineCommand({
  name: 'set_ply_drop_rules',
  description:
    'Set the ply drop-off rules of a part, used by generate_plies_from_zones and check_layup. rampRatio: ramp length per dropped ' +
    'thickness (default 20, i.e. 1:20, a user rule not a mandate); minStagger with staggerUnit "dropped_thickness" (multiples of the ply ' +
    'thickness, default 3) or "length" (document length units); dropOrder "inner_first" (default: plies nearest the mid-plane end first, ' +
    'outer plies run longest) or "outer_first"; coverPlies: number of continuous plies kept on each surface (default 1).',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    rampRatio: z.number().describe('Ramp length / dropped thickness, >= 1 (dimensionless); default 20.').optional(),
    minStagger: z.number().describe('Minimum stagger between drops; unit per staggerUnit; >= 0; default 3.').optional(),
    staggerUnit: z.enum(['dropped_thickness', 'length']).describe('Unit of minStagger; default "dropped_thickness".').optional(),
    dropOrder: z.enum(['inner_first', 'outer_first']).describe('Which plies end first at a step; default "inner_first".').optional(),
    coverPlies: z.number().describe('Continuous plies kept on each outer surface, integer >= 0; default 1.').optional(),
  }),
  run: (doc, { part: ref, ...given }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, ref);
    if (part === null) return refuseCmp(doc, 'set_ply_drop_rules', 'CMP_REF_MISSING', `no part '${ref}'`, [], ['params.part']);
    const rules: PlyDropRules = {
      ...DEFAULT_DROP_RULES,
      ...part.plyDropRules,
      ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
    };
    if (!(rules.rampRatio >= 1) || !(rules.minStagger >= 0) || !Number.isInteger(rules.coverPlies) || rules.coverPlies < 0)
      return refuseCmp(
        doc,
        'set_ply_drop_rules',
        'CMP_PARAM_INVALID',
        'rampRatio must be >= 1, minStagger >= 0 and coverPlies an integer >= 0',
        [part.id],
      );
    const next = withComposites(doc, { parts: { ...model.parts, [part.id]: { ...part, plyDropRules: rules } } });
    return changed(
      next,
      `set_ply_drop_rules: part "${part.name}" ramp ${rules.rampRatio}:1, stagger ${rules.minStagger} (${rules.staggerUnit}), ${rules.dropOrder}, ${rules.coverPlies} cover ply(ies).`,
      [part.id],
    );
  },
});

/**
 * @affects sets doc.composites.parts[part].rules
 * @invariant omitted fields keep the part's previous (else default) value; every disable carries a justification
 * @failure unknown part -> CMP_REF_MISSING; minFraction outside [0, 1], maxConsecutive < 1 or an unknown rule key -> CMP_PARAM_INVALID
 */
export const setLaminateRules = defineCommand({
  name: 'set_laminate_rules',
  description:
    'Configure the laminate design rules of a part (read by check_laminate_rules and check_layup). Defaults are the commonly published ' +
    'guidelines, not CMH-17 clauses: symmetric, balanced, at least 10% of plies in each of the 0 / +-45 / 90 families (minFraction 0.1), ' +
    'at most 4 consecutive plies of one angle (maxConsecutive), outer plies +-45 (outerPlusMinus45). maxAngleChange (degrees) adds the ' +
    'adjacent-ply disorientation rule. `disable` lists rules switched off with a mandatory justification: rule is one of "R1" (symmetry), ' +
    '"R2" (balance), "R3" (min fraction), "R4" (consecutive), "R5" (outer +-45), "DISORIENTATION". For release, a disabled rule is only ' +
    'accepted after a human approval; check_layup purpose "release" still reports it.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    symmetric: z.boolean().describe('Require a symmetric stack (R1); default true.').optional(),
    balanced: z.boolean().describe('Require balanced +theta / -theta plies (R2); default true.').optional(),
    minFraction: z
      .number()
      .describe('Minimum fraction (0..1, not percent) of plies per 0 / +-45 / 90 family (R3); default 0.1.')
      .optional(),
    maxConsecutive: z.number().describe('Maximum consecutive plies of one angle, integer >= 1 (R4); default 4.').optional(),
    outerPlusMinus45: z.boolean().describe('Require +-45 outer plies (R5); default true.').optional(),
    maxAngleChange: z.number().describe('Maximum angle change between adjacent plies, degrees (0..90); omitted = rule off.').optional(),
    disable: z
      .array(
        z.object({
          rule: z.string().describe('"R1".."R5" or "DISORIENTATION".'),
          justification: z.string().min(1).describe('Why the rule is switched off.'),
        }),
      )
      .describe('Rules to switch off, each with a justification.')
      .optional(),
  }),
  run: (doc, { part: ref, disable, ...given }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, ref);
    if (part === null) return refuseCmp(doc, 'set_laminate_rules', 'CMP_REF_MISSING', `no part '${ref}'`, [], ['params.part']);
    const known = new Set(Object.values(RULE_KEY));
    const unknownRule = (disable ?? []).find((entry) => !known.has(entry.rule));
    const base = {
      ...DEFAULT_RULES,
      ...part.rules,
      ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
    };
    if (unknownRule !== undefined || !(base.minFraction >= 0 && base.minFraction <= 1) || !(base.maxConsecutive >= 1))
      return refuseCmp(
        doc,
        'set_laminate_rules',
        'CMP_PARAM_INVALID',
        unknownRule === undefined
          ? 'minFraction must be in [0, 1] and maxConsecutive >= 1'
          : `unknown rule "${unknownRule.rule}" in disable`,
        [part.id],
      );
    const rules: RuleConfig = { ...base, ...(disable === undefined ? {} : { disabled: disable }) };
    const next = withComposites(doc, { parts: { ...model.parts, [part.id]: { ...part, rules } } });
    return changed(
      next,
      `set_laminate_rules: part "${part.name}" symmetric ${rules.symmetric}, balanced ${rules.balanced}, min fraction ${rules.minFraction}, max consecutive ${rules.maxConsecutive}, outer +-45 ${rules.outerPlusMinus45}, ${(rules.disabled ?? []).length} rule(s) disabled.`,
      [part.id],
    );
  },
});
