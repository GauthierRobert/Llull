/** recognize_features (07 FTR M4): holes, pockets, fillets, chamfers and sheet-metal bends of an exact solid, read from its face graph. */

import { type CadDocument } from '../../model/types';
import type { FtrFinding, FtrResultMeta } from '../../model/manufacturing';
import { HOLE_KINDS } from '../../model/features';
import { toRadians } from '../../lib/angle';
import { recognizeFeatures as recognize } from '../../geometry/recognition/recognize';
import { RECOGNIZE_KINDS, type Recognition } from '../../geometry/recognition/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';

import { report } from '../noop';
import { resultMeta } from './ftr';
import { lengthToleranceOf, solidRecognition } from './recognition';

export interface RecognizeData extends FtrResultMeta {
  readonly entityId: string;
  readonly counts: {
    readonly holes: number;
    readonly countersink: number;
    readonly counterbore: number;
    readonly blind: number;
    readonly pockets: number;
    readonly bends: number;
    readonly fillets: number;
    readonly chamfers: number;
  };
  readonly holes: Recognition['holes'];
  readonly pockets: Recognition['pockets'];
  readonly bends: Recognition['bends'];
  readonly fillets: Recognition['fillets'];
  readonly chamfers: Recognition['chamfers'];
  readonly unclassified: readonly number[];
  readonly findings: readonly FtrFinding[];
}

function countsOf(found: Recognition): RecognizeData['counts'] {
  return {
    holes: found.holes.length,
    countersink: found.holes.filter((hole) => hole.subtype === 'countersink').length,
    counterbore: found.holes.filter((hole) => hole.subtype === 'counterbore').length,
    blind: found.holes.filter((hole) => !hole.through).length,
    pockets: found.pockets.length,
    bends: found.bends.length,
    fillets: found.fillets.length,
    chamfers: found.chamfers.length,
  };
}

const ambiguity = (found: Recognition): FtrFinding[] =>
  found.holes.flatMap((hole, index): FtrFinding[] =>
    hole.confidence === 'exact'
      ? []
      : [
          {
            code: 'FTR_RECOGNITION_AMBIGUOUS',
            severity: 'info',
            ids: [`holes.${index}`, ...hole.faceIndices.map((face) => `face-${face}`)],
            remediation: 'inspect the faces or give the intended feature explicitly',
          },
        ],
  );

/**
 * @affects nothing — read-only
 * @invariant data = RecognizeData (counts, holes, pockets, bends, fillets, chamfers, unclassified face indices, findings + FtrResultMeta); faces
 *   of one analytic surface split by the kernel are merged first; the order is deterministic (kind, then axis point x, y, z)
 * @failure missing / non-solid entity (FTR_PART_NOT_FOUND), no exact kernel or no face graph (FTR_NEEDS_EXACT_KERNEL) -> rejected no-op, no data
 */
export const recognizeFeatures = defineCommand({
  name: 'recognize_features',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Recognise the manufacturing features of an exact 3D solid from its B-rep: holes (simple, counterbore, countersink, through or blind with ' +
    'a drill point; per hole the axis point at the entrance, the axis pointing into the material, diameter, countersink diameter / included ' +
    'angle in degrees / depth, counterbore diameter / depth, blind depth, drill point angle, face indices and confidence exact | ambiguous), ' +
    'pockets (floor height, depth, corner radius, floor fillet, open or closed), fillets, chamfers and sheet-metal bends. Faces of one ' +
    'surface that the kernel split in two (periodic cylinders and cones) are merged first. All lengths are in the document length unit, ' +
    'angles in degrees; results are deterministic and listed in data (counts, holes, pockets, bends, fillets, chamfers, unclassified face ' +
    'indices). Works on imported STEP solids (import_step_exact) and on parts built with add_hole / add_pocket. Needs an exact kernel: ' +
    'otherwise refused with FTR_NEEDS_EXACT_KERNEL (also FTR_PART_NOT_FOUND). Result computed by llull, not approved: reviewRequired is true.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid (mesh with an exact B-rep) to analyse.'),
    kinds: z
      .array(z.enum(RECOGNIZE_KINDS))
      .optional()
      .describe('Feature kinds to report: hole, pocket, fillet, chamfer, bend. Omit for all.'),
    mergeSplitFaces: z
      .boolean()
      .optional()
      .describe('Merge faces on one analytic surface (split periodic faces) before recognising. Default true.'),
    angularTolerance: z
      .number()
      .positive()
      .optional()
      .describe('Angle tolerance in degrees for parallel axes and equal cone angles. Default 0.0001 degrees.'),
    lengthTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Length tolerance in document length units for coaxial axes, equal radii and coplanar faces. Default 1e-6 of the model diagonal.',
      ),
  }),
  run: (doc: CadDocument, { id, kinds, mergeSplitFaces = true, angularTolerance, lengthTolerance }, ctx): CommandResult => {
    const recognition = solidRecognition(doc, 'recognize_features', id, ctx, 'list entities with describe_scene, then pass a solid id');
    if ('refusal' in recognition) return recognition.refusal;
    const { input } = recognition;
    const tolerance = lengthTolerance ?? lengthToleranceOf(input.topology);
    const angle = angularTolerance ?? 1e-4;
    const found = recognize(
      input.graph,
      input.topology,
      { kinds: kinds ?? RECOGNIZE_KINDS, mergeSplitFaces, angularTolerance: toRadians(angle), lengthTolerance: tolerance },
      input.orientation,
    );
    const counts = countsOf(found);
    const data: RecognizeData = {
      ...resultMeta(doc, {
        formulas: { recognition: 'merge same-surface faces; coaxial hole chains; concave floors with perpendicular walls' },
        inputs: {
          lengthTolerance: {
            value: tolerance,
            unit: doc.units,
            source: lengthTolerance === undefined ? '1e-6 x model diagonal (07 §5.8)' : 'parameter',
            defaulted: lengthTolerance === undefined,
          },
          angularTolerance: {
            value: angle,
            unit: 'deg',
            source: angularTolerance === undefined ? 'default' : 'parameter',
            defaulted: angularTolerance === undefined,
          },
        },
        sources: ['07 FTR §5.6'],
      }),
      entityId: id,
      counts,
      holes: found.holes,
      pockets: found.pockets,
      bends: found.bends,
      fillets: found.fillets,
      chamfers: found.chamfers,
      unclassified: found.unclassified,
      findings: ambiguity(found),
    };
    const kindsOfHoles = HOLE_KINDS.map((kind) => `${found.holes.filter((hole) => hole.subtype === kind).length} ${kind}`).join(', ');
    return report(
      doc,
      `recognize_features: '${id}' has ${counts.holes} holes (${kindsOfHoles}; ${counts.blind} blind), ${counts.pockets} pockets, ` +
        `${counts.bends} bends, ${counts.fillets} fillets, ${counts.chamfers} chamfers; ${found.unclassified.length} faces unclassified. ` +
        'Computed by llull, not approved — a qualified person must review before manufacture.',
      data,
    );
  },
});
