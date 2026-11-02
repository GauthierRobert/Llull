/** `resolve_joint` (plant 01 PSC M4): the parts of a joint between two pipe ends under a spec, with the bolt set and stud length. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../../catalog/codes';
import { END_TYPES, FACINGS } from '../../catalog/types';
import type { PipeSpec } from '../types';
import { boltDiameterInches, FLANGE_TYPES, GASKET_TYPES, resolveJoint, type JointResult } from '../jointResolve';
import { componentData, isLoaded, loadSpec } from './answer';

const nominalParam = z.union([z.number(), z.string()]);

function jointData(specId: string, revision: number, joint: JointResult, specOf: PipeSpec): Record<string, unknown> {
  const part = (resolved: JointResult['flangeA']): Record<string, unknown> | undefined =>
    resolved === undefined ? undefined : componentData(specOf, resolved);
  const warnings: Array<Record<string, unknown>> = [];
  if (joint.unverifiedParts.length > 0) warnings.push({ code: 'PSC_DATA_UNVERIFIED', parts: joint.unverifiedParts });
  if (joint.studUnknown !== undefined) warnings.push({ code: 'PSC_CATALOG_ROW_MISSING', reason: joint.studUnknown });
  if (joint.stud?.method === 'rule')
    warnings.push({ code: 'PSC_DATA_UNVERIFIED', reason: 'stud length is derived by a rule', assumptions: joint.stud.assumptions });
  return {
    specId,
    revision,
    kind: joint.kind,
    size: joint.sizeLabel,
    flanged: joint.kind === 'flanged',
    ...(joint.ratingClass === undefined ? {} : { class: joint.ratingClass }),
    ...(joint.facing === undefined ? {} : { facing: joint.facing }),
    ...(joint.flangeA === undefined
      ? {}
      : { flangeA: part(joint.flangeA), flangeB: part(joint.flangeB), gasket: part(joint.gasket), boltSet: part(joint.bolts) }),
    ...(joint.boltCount === undefined || joint.boltDiameterMm === undefined
      ? {}
      : {
          bolts: {
            count: joint.boltCount.value,
            countSource: joint.boltCount.source,
            diameterMm: joint.boltDiameterMm.value,
            diameterIn: boltDiameterInches(joint.boltDiameterMm.value),
            diameterSource: joint.boltDiameterMm.source,
            studs: joint.boltCount.value,
            nuts: 2 * joint.boltCount.value,
            ...(joint.stud === undefined
              ? { studLength: null, studLengthUnknown: joint.studUnknown }
              : {
                  studLengthMm: joint.stud.lengthMm,
                  studLengthIn: joint.stud.lengthIn,
                  studMethod: joint.stud.method,
                  studVerified: joint.stud.verified,
                  studAssumptions: joint.stud.assumptions,
                  ...(joint.stud.rule === undefined ? {} : { studRule: joint.stud.rule }),
                }),
          },
        }),
    verified: joint.verified,
    unverifiedParts: joint.unverifiedParts,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * @affects none; data = { kind, size, flanged, class?, facing?, flangeA?, flangeB?, gasket?, boltSet?, bolts?: { count, diameterMm, diameterIn, studLengthMm?, studMethod, studAssumptions }, verified, warnings? }
 * @invariant read-only; a flanged joint is complete (two mating flanges, gasket, bolt set) or refused; a stud length from the rule is derived and never verified; an imported bolt-set row with studLength overrides the rule
 * @failure unknown spec / size out of range -> PSC_SPEC_UNKNOWN / PSC_SIZE_OUT_OF_RANGE; ends that do not mate, flange class / facing / bolt pattern clash -> PSC_END_INCOMPATIBLE; missing gasket / bolt set -> PSC_JOINT_INCOMPLETE; no flange -> PSC_NO_COMPONENT
 */
export const resolveJointCommand = defineCommand({
  name: 'resolve_joint',
  description:
    'Resolve the joint between two pipe ends of one size under a piping spec. Flanged ends (endA and endB both "FL"): the two mating flanges (weld neck by default, or flangeTypeA / flangeTypeB), the gasket, the bolt set ' +
    'with stud count, diameter and STUD LENGTH. Stud length: taken from the bolt-set row when an imported bolting table has studLength, else computed by the named rule ' +
    'L = ceil((t1 + RF1 + t2 + RF2 + gasket + 2 nuts + 2 x 2 thread pitches) / 1/4 in) x 1/4 in (flange thickness excludes the raised face; raised face 1.6 mm Class 150 / 300, 6.4 mm from Class 400; nut = bolt diameter) and is marked derived, UNVERIFIED, with every assumption listed ' +
    '(gasketThicknessMm and nutHeightMm override the assumed gasket thickness and nut height). The stud length is null with a reason where the rule cannot apply (no thickness, EN 1092-1 faces, untabulated bolt). ' +
    'Welded and threaded joints (BW-BW, SW-PE, THD-THD) have no parts. Refuses ends that do not mate and flanges of different class or facing or bolt pattern (PSC_END_INCOMPATIBLE), a spec without gasket or bolt set (PSC_JOINT_INCOMPLETE), sizes outside the spec (PSC_SIZE_OUT_OF_RANGE). ' +
    'Size is NPS (inch designation or number) or DN. Next: component_shape for the flange geometry, check_pipe_spec to validate the whole spec.',
  params: z.object({
    specId: z.string().describe('Spec id (list_pipe_specs).'),
    revision: z.number().int().positive().describe('Spec revision. Default: the newest.').optional(),
    nps: nominalParam.describe('Joint size, NPS inch designation ("4") or number. Give nps or dn.').optional(),
    dn: nominalParam.describe('Joint size as DN.').optional(),
    endA: z
      .enum(END_TYPES)
      .describe('End type at side A of the joint: FL flanged, BW butt weld (BE bevelled), SW socket weld, PE plain end, THD threaded.'),
    endB: z.enum(END_TYPES).describe('End type at side B. Mating pairs: FL-FL, BW-BW, SW-PE, THD-THD.'),
    flangeTypeA: z.enum(FLANGE_TYPES).describe('Flange type at side A (default flangeWeldNeck).').optional(),
    flangeTypeB: z.enum(FLANGE_TYPES).describe('Flange type at side B (default flangeWeldNeck).').optional(),
    gasketType: z.enum(GASKET_TYPES).describe('Gasket type, needed only when the spec defines several at this size.').optional(),
    class: z.number().int().positive().describe('Pressure class to select flange / gasket / bolt rows (150, 300 ...).').optional(),
    facing: z.enum(FACINGS).describe('Flange facing to select rows (RF, FF).').optional(),
    gasketThicknessMm: z
      .number()
      .positive()
      .describe('Compressed gasket thickness in mm for the stud rule (overrides the row and the assumed value).')
      .optional(),
    nutHeightMm: z.number().positive().describe('Nut height in mm for the stud rule (default: the nominal bolt diameter).').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { specId, revision, ...query }): CommandResult => {
    const loaded = loadSpec(doc, 'resolve_joint', specId, revision);
    if (!isLoaded(loaded)) return loaded;
    const outcome = resolveJoint(loaded.spec, loaded.catalogs, query);
    if (!outcome.ok) return refuse(doc, 'resolve_joint', outcome.code, outcome.message, outcome.ids, outcome.paths);
    const { joint } = outcome;
    const stud =
      joint.stud === undefined
        ? joint.kind === 'flanged'
          ? `stud length unknown (${joint.studUnknown ?? 'n/a'})`
          : ''
        : `stud ${joint.stud.lengthMm} mm${joint.stud.lengthIn === null ? '' : ` (${joint.stud.lengthIn} in)`} by ${joint.stud.method === 'rule' ? 'the derived rule, UNVERIFIED' : 'the bolting table'}`;
    return report(
      doc,
      joint.kind === 'flanged'
        ? `resolve_joint: spec ${loaded.spec.id} r${loaded.spec.revision} ${joint.sizeLabel} flanged joint class ${joint.ratingClass ?? 'n/a'} ${joint.facing ?? ''}: ${joint.flangeA?.component.id} + ${joint.flangeB?.component.id}, gasket ${joint.gasket?.component.id}, ${joint.boltCount?.value} x ${joint.boltDiameterMm?.value} mm bolts (set ${joint.bolts?.component.id}); ${stud}${joint.verified ? '' : '; UNVERIFIED (PSC_DATA_UNVERIFIED)'}.`
        : `resolve_joint: spec ${loaded.spec.id} r${loaded.spec.revision} ${joint.sizeLabel}: ${joint.kind} joint, no parts.`,
      jointData(loaded.spec.id, loaded.spec.revision, joint, loaded.spec),
    );
  },
});
