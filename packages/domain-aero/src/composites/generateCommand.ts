/** generate_plies_from_zones: blends the zone stacks of a part into continuous plies with ramps (FR-CMP-10, FR-CMP-12). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { CompositesModel } from '@core/model/composites';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { syncOutlines } from './derive';
import { insertPly } from './plyCommands';
import { DEFAULT_DROP_RULES } from './rules';
import { compositesOf, findPart, pliesOf, withComposites, zonesOf } from './state';
import { isDoublyCurved } from './surface';
import { blendZones } from './zones';

/**
 * @affects creates one ply per master-stack position (ply-<step>.<k>) and their outlines; with replaceGenerated removes the previously generated plies first
 * @invariant every zone stack is a subsequence of the thickest zone's stack (symmetric halves matched from both ends); the k-th dropped ply of a step ends k * max(t * rampRatio, minStagger) beyond the full-thickness region
 * @failure no zones / unknown part, material -> CMP_REF_MISSING; not embeddable -> CMP_ZONES_NOT_BLENDABLE; equal-thickness conflict; cover plies dropped; ramp does not fit -> CMP_RAMP_CONFLICT
 */
export const generatePliesFromZones = defineCommand({
  name: 'generate_plies_from_zones',
  description:
    'Generate the plies of a composite part from its zones (define_zone). The thickest zone gives the master stack; every other zone stack ' +
    'must embed in it (same angles in the same order, symmetric halves matched from both ends): otherwise the command is refused and ' +
    'names the two zones (CMP_ZONES_NOT_BLENDABLE; equally thick zones must be identical). Each master ply covers the union of the zones ' +
    'that contain it, extended by a ramp: at every thickness step the k-th dropped ply ends k * max(plyThickness * rampRatio, minStagger) ' +
    'beyond the full-thickness boundary (set_ply_drop_rules; default ramp 20:1, inner plies end first). A ramp that does not fit before ' +
    'the next zone boundary is refused (CMP_RAMP_CONFLICT with needed vs available length). Where a thick zone overlaps a thinner one it ' +
    'must have the higher priority. Plies are named "<sequencePrefix><n>" (default "S", n = 1-based position from the tool side) and ' +
    'carry the same sequence label. Existing generated plies need replaceGenerated true. Ends with check_laminate_rules / check_layup.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    material: z.string().describe('Lamina material name used by every generated ply (its plyThickness drives the ramps).'),
    sequencePrefix: z.string().describe('Prefix of ply names and sequence labels; default "S".').optional(),
    replaceGenerated: z
      .boolean()
      .describe('Remove plies generated earlier (not manual ones) and generate again; default false.')
      .optional(),
  }),
  run: (doc, { part: partRef, material, sequencePrefix = 'S', replaceGenerated = false }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'generate_plies_from_zones', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const lamina = model.materials[material];
    if (lamina === undefined)
      return refuseCmp(doc, 'generate_plies_from_zones', 'CMP_REF_MISSING', `no lamina material '${material}'`, [], ['params.material']);
    const zones = zonesOf(model, part.id);
    if (zones.length === 0)
      return refuseCmp(
        doc,
        'generate_plies_from_zones',
        'CMP_REF_MISSING',
        `part "${part.name}" has no zones (define_zone first)`,
        [part.id],
        ['params.part'],
      );
    const generated = pliesOf(model, part.id).filter((ply) => ply.zoneOrigin !== undefined);
    if (generated.length > 0 && !replaceGenerated)
      return refuseCmp(
        doc,
        'generate_plies_from_zones',
        'CMP_PARAM_INVALID',
        `part "${part.name}" already has ${generated.length} generated plies; pass replaceGenerated true`,
        [part.id],
        ['params.replaceGenerated'],
      );
    const rules = part.plyDropRules ?? DEFAULT_DROP_RULES;
    const blend = blendZones(zones, part, rules, lamina.plyThickness);
    if (!blend.ok) return refuseCmp(doc, 'generate_plies_from_zones', blend.code, blend.message, blend.zoneIds, ['params.part']);
    if (blend.conflicts.length > 0) {
      const worst = blend.conflicts[0];
      return refuseCmp(
        doc,
        'generate_plies_from_zones',
        'CMP_RAMP_CONFLICT',
        `a ${sig(worst?.needed ?? 0)} ramp does not fit: only ${sig(worst?.available ?? 0)} before the next boundary near [${worst?.location.map(sig).join(', ')}] (${blend.conflicts.length} conflict(s))`,
        worst?.zoneIds ?? [],
      );
    }
    const manual = new Set(
      pliesOf(model, part.id)
        .filter((ply) => ply.zoneOrigin === undefined)
        .map((ply) => ply.name),
    );
    const clash = blend.plies.map((plan) => `${sequencePrefix}${plan.index + 1}`).find((label) => manual.has(label));
    if (clash !== undefined)
      return refuseCmp(
        doc,
        'generate_plies_from_zones',
        'CMP_NAME_TAKEN',
        `a manual ply is already named "${clash}"; use another sequencePrefix`,
        [part.id],
        ['params.sequencePrefix'],
      );
    const drop = new Set(generated.map((ply) => ply.id));
    const kept: CompositesModel = {
      ...model,
      plies: Object.fromEntries(Object.entries(model.plies).filter(([id]) => !drop.has(id))),
      plyOrder: model.plyOrder.filter((id) => !drop.has(id)),
    };
    let next = kept;
    const created = blend.plies.map((plan) => {
      const label = `${sequencePrefix}${plan.index + 1}`;
      const result = insertPly(next, part, {
        name: label,
        materialName: material,
        orientation: plan.angle,
        sequence: label,
        rosetteId: part.rosetteId,
        boundary: { kind: 'polygons', polygons: plan.polygons },
        drape: { method: isDoublyCurved(part.surface) ? 'kinematic' : 'developable' },
        zoneOrigin: { zoneIds: plan.zoneIds, dropRank: plan.dropRank },
      });
      next = result.model;
      return { plan, id: result.ply.id, label };
    });
    const dropped = blend.plies.filter((plan) => plan.dropRank > 0);
    const widest = Math.max(0, ...blend.plies.map((plan) => plan.extension));
    const data = {
      masterAngles: [...blend.master],
      plies: created.map(({ plan, id, label }) => ({
        id,
        name: label,
        angleDeg: plan.angle,
        zoneIds: plan.zoneIds,
        dropRank: plan.dropRank,
        rampExtension: sig(plan.extension),
      })),
      rampRatio: {
        value: rules.rampRatio,
        unit: '-',
        source: 'common published ramp ratio 20:1 (user rule)',
        defaulted: part.plyDropRules === undefined,
      },
      lengthUnit: doc.units,
    };
    return {
      document: syncOutlines(withComposites(doc, next)),
      summary:
        `generate_plies_from_zones: part "${part.name}": ${zones.length} zone(s) blended into ${created.length} plies (${lamina.name}); ` +
        `${dropped.length} drop at thickness steps, longest ramp ${sig(widest)} ${doc.units}; ramp ratio ${rules.rampRatio}:1${part.plyDropRules === undefined ? ' (default)' : ''}.`,
      affected: created.map((entry) => entry.id),
      data,
    };
  },
});
