/** joint_from_fastener_stack: the FE set-up of a placed fastener stack (PHY-06 FR-CNT-10): the bolt pretension and the clamp / bearing contact pairs. */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { defineCommand, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { toMm } from '@core/model/units';
import { significantNumber } from '@lib/compactNumber';
import { add3, scale3 } from '@lib/vec3';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { analysisIdSchema } from '../shared/schemas';
import { isRefusal, nonlinearCase } from '../nonlinear/settings';
import { refuseCnt, NOT_APPROVED } from './codes';
import { behaviourSchema, formulationSchema, frictionSchema } from './pairSchema';
import { preloadSchema } from './pretensionCommands';
import { readStack, type StackView } from './stackRead';
import { stackGeometry, type StackGeometry } from './stackGeometry';
import { boltStiffness, membersStiffness, stiffnessFactor } from './stackStiffness';

/** Offset of the face-selection points from the axis, in hole diameters (between the hole edge at 0.5 and a washer face at 0.75). */
const FACE_POINT_DIAMETERS = 0.65;

const n = (value: number): string => significantNumber(value, 5);

interface SubStep {
  readonly command: string;
  readonly params: Record<string, unknown>;
}

/** Young's modulus (MPa) of entity `entityId` at the case temperature, or null when it has no readable isotropic elastic law. */
function modulusOf(doc: CadDocument, analysis: AnalysisCase, entityId: string): number | null {
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (materialId === undefined || material === undefined) return null;
  const elastic = elasticConstants(material, materialId, propertyTemperatureK(analysis));
  return isElasticRefusal(elastic) ? null : elastic.E;
}

/** Frustum stiffness estimate of the stack (N/mm), or the reason it is not available. */
function stiffnessOf(
  doc: CadDocument,
  analysis: AnalysisCase,
  stack: StackView,
  geometry: StackGeometry,
  boltEntityId: string,
  diameter: number,
): Record<string, unknown> {
  const unit = toMm(doc, 1);
  const moduli = geometry.plates.map((plate) => modulusOf(doc, analysis, plate.entityId));
  const boltModulus = modulusOf(doc, analysis, boltEntityId);
  if (moduli.some((modulus) => modulus === null) || boltModulus === null)
    return { available: false, reason: 'a plate or the bolt has no isotropic elastic law (assign_material + a constitutive set)' };
  const layers = geometry.plates.map((plate, index) => ({ thickness: (plate.high - plate.low) * unit, modulus: moduli[index] ?? 0 }));
  const grip = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  const shank = (stack.nominalDiameter ?? diameter) * unit;
  const kBolt = boltStiffness(shank, grip, boltModulus);
  const kMembers = membersStiffness(layers, shank);
  return {
    available: true,
    kBolt,
    kMembers,
    phi: stiffnessFactor(kBolt, kMembers),
    unit: 'N/mm',
    grip: grip / unit,
    diameter: stack.nominalDiameter ?? diameter,
    method:
      'Shigley, Mechanical Engineering Design 10th ed. section 8-2: eq. 8-13 (shank over the whole grip, no thread in the grip), eq. 8-18 / 8-20 (30 degree frusta from a 1.5 d bearing face, meeting at mid-grip)',
    assumptions: [
      'bolt shank diameter = nominal diameter over the whole grip (thread in the grip ignored: k_b is high, phi conservative for the bolt load)',
      `${stack.washerCount} washer(s) and the nut are not in the grip length`,
      'the cone formula uses the nominal fastener diameter (the catalogue size; the hole diameter when the catalogue has none)',
    ],
  };
}

interface PlanInput {
  readonly analysisId: string;
  readonly boltEntityId: string;
  readonly preload: unknown;
  readonly preloadStepId: string;
  readonly lockAfter: boolean | undefined;
  readonly bearing: boolean;
  readonly formulation: string | undefined;
  readonly behaviour: unknown;
  readonly friction: unknown;
}

/** The sub-commands of the joint: the bolt pretension, then the contact pairs (clamp interfaces and the two bearing faces). */
function plan(stack: StackView, geometry: StackGeometry, input: PlanInput, diameter: number): SubStep[] {
  const { plates, pointAt, lateral, direction } = geometry;
  const first = plates[0];
  const last = plates[plates.length - 1];
  if (first === undefined || last === undefined) return [];
  const offset = scale3(lateral, FACE_POINT_DIAMETERS * diameter);
  const on = (s: number): Vec3 => add3(pointAt(s), offset);
  const base = {
    analysisId: input.analysisId,
    ...(input.formulation === undefined ? {} : { formulation: input.formulation }),
    behaviour: input.behaviour,
    ...(input.friction === undefined ? {} : { friction: input.friction }),
  };
  const pair = (name: string, slave: [string, number], master: [string, number]): SubStep => ({
    command: 'add_contact_pair',
    params: {
      ...base,
      name: `${stack.id}_${name}`,
      slave: { entityId: slave[0], facesNear: [on(slave[1])] },
      master: { entityId: master[0], facesNear: [on(master[1])] },
    },
  });
  const steps: SubStep[] = [
    {
      command: 'add_bolt_pretension',
      params: {
        analysisId: input.analysisId,
        name: `${stack.id}_bolt`,
        entityId: input.boltEntityId,
        section: { point: pointAt((first.low + last.high) / 2), normal: direction },
        preload: input.preload,
        preloadStepId: input.preloadStepId,
        ...(input.lockAfter === undefined ? {} : { lockAfter: input.lockAfter }),
      },
    },
  ];
  plates.slice(1).forEach((upper, index) => {
    const lower = plates[index];
    if (lower !== undefined) steps.push(pair(`if${index + 1}`, [upper.entityId, upper.low], [lower.entityId, lower.high]));
  });
  if (input.bearing) {
    steps.push(pair('head', [first.entityId, first.low], [input.boltEntityId, first.low]));
    steps.push(pair('nut', [last.entityId, last.high], [input.boltEntityId, last.high]));
  }
  return steps;
}

/**
 * @affects doc.analysis.cases[analysisId].pretension (+1 bolt) and .contact (+ one pair per clamped interface and, with bearing, 2 bearing pairs);
 *   affected: [analysisId, boltId, ...pairIds]
 * @invariant all or nothing (a refused step leaves the document unchanged, naming the step and its code); composes add_bolt_pretension and
 *   add_contact_pair through execute; the section is the grip mid-plane normal to the stack axis; reads the stack as document data only
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; unknown / malformed stack, plate missing, no usable
 *   diameter -> CNT_STACK_NOT_FOUND; any refusal of the composed commands passes through with its code
 */
export const jointFromFastenerStack = defineCommand({
  name: 'joint_from_fastener_stack',
  description:
    'Set up the FE model of a placed fastener stack (insert_fastener / insert_fastener_row, plugin fasteners) in a nonlinear_static analysis: ' +
    'one bolt pretension (add_bolt_pretension) cut at the grip mid-plane normal to the stack axis, one contact pair per clamped plate interface ' +
    'and, with bearing (default true), a head-side and a nut-side pair between the outer plates and the bolt part (add_contact_pair; plate = slave, ' +
    'the other face = master). The stack is read from the document (stackId = fst-<step>.<k>): its plates must be parts of the analysis ' +
    '(set_part_idealization). boltEntityId = the bolt as a SOLID part of the analysis (an instance is not meshable and the stack instances are plugin-owned: ' +
    'insert_instance a fresh copy of the bolt component, explode_instance it, set_part_idealization the SHANK (a catalogue bolt explodes into a head cylinder and a shank cylinder); or model the bolt as one solid): The bolt part must have a bearing face at each outer plate face (head and a nut / collar ' +
    'fused to the shank): the washers and the nut instances of the stack are NOT modelled. preload = { kind: "force", value } or a torque with its ' +
    'nut factor (never defaulted); preloadStepId = the FIRST step of the case. Absent formulation = the case formulation, else surface_to_surface ' +
    '(reported); absent behaviour = hard; absent friction = frictionless (named in the summary). Returns data.stiffness: the Shigley frustum estimate ' +
    '(k_bolt, k_members N/mm, phi = k_b / (k_b + k_m)) to feed bolted_joint_check and to compare with joint_stiffness_from_fe. Then fea_mesh, check_contact, ' +
    `fea_solve, contact_report. ${NOT_APPROVED}`,
  params: z.object({
    analysisId: analysisIdSchema,
    stackId: z.string().describe('Id of the fastener stack (fst-<step>.<k>, from insert_fastener).'),
    boltEntityId: z
      .string()
      .describe(
        'Solid entity of the bolt, a part of the analysis (explode_instance of the stack bolt instance, then set_part_idealization).',
      ),
    preload: preloadSchema,
    preloadStepId: z.string().describe('Id of the first step of the case (affected[0] of add_analysis_step).'),
    lockAfter: z.boolean().optional().describe('Hold the bolt length in the later steps (add_bolt_pretension default true).'),
    bearing: z
      .boolean()
      .optional()
      .describe('Add the head-side and nut-side pairs between the bolt part and the outer plates (default true). false: interfaces only.'),
    formulation: formulationSchema.optional(),
    behaviour: behaviourSchema.optional().describe('Pressure-overclosure of every pair; absent = hard.'),
    friction: frictionSchema.optional().describe('Coulomb friction of every pair; absent = frictionless.'),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'joint_from_fastener_stack';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [params.analysisId, params.stackId], [path]);
    const stack = readStack(doc, params.stackId);
    if ('message' in stack) return fail('CNT_STACK_NOT_FOUND', stack.message, 'stackId');
    const geometry = stackGeometry(doc, stack);
    if ('message' in geometry) return fail('CNT_STACK_NOT_FOUND', geometry.message, 'stackId');
    const diameter = stack.holeDiameter > 0 ? stack.holeDiameter : stack.nominalDiameter;
    if (diameter === null || !(diameter > 0))
      return fail(
        'CNT_STACK_NOT_FOUND',
        `stack '${stack.id}' has no hole diameter and its fastener size has no nominal diameter in the catalogue`,
        'stackId',
      );
    const formulation = params.formulation ?? (analysis.contact === undefined ? 'surface_to_surface' : undefined);
    const steps = plan(
      stack,
      geometry,
      {
        analysisId: params.analysisId,
        boltEntityId: params.boltEntityId,
        preload: params.preload,
        preloadStepId: params.preloadStepId,
        lockAfter: params.lockAfter,
        bearing: params.bearing ?? true,
        formulation,
        behaviour: params.behaviour ?? { kind: 'hard' },
        friction: params.friction,
      },
      diameter,
    );
    let current = doc;
    const affected: string[] = [params.analysisId];
    for (const step of steps) {
      const result = execute(current, step.command, step.params, ctx);
      if (result.error !== undefined)
        return refuseCnt(
          doc,
          command,
          result.error.code,
          `${step.command} '${String(step.params['name'])}' refused: ${result.summary}`,
          [params.analysisId, params.stackId],
          [],
        );
      current = result.document;
      affected.push(...result.affected.slice(1));
    }
    const pairIds = affected.slice(2);
    const stiffness = stiffnessOf(doc, analysis, stack, geometry, params.boltEntityId, diameter);
    const phi = typeof stiffness['phi'] === 'number' ? ` Shigley estimate phi ${n(stiffness['phi'])}.` : '';
    const grip = geometry.plates.reduce((sum, plate) => sum + plate.high - plate.low, 0);
    const unmodelled =
      stack.washerCount > 0 || stack.hasNut ? ` The ${stack.washerCount} washer(s) and the nut of the stack are not modelled.` : '';
    const behaviour = params.behaviour === undefined ? 'hard by default' : params.behaviour.kind;
    const friction = params.friction === undefined ? 'frictionless by default' : `friction mu ${params.friction.mu}`;
    const used = formulation ?? analysis.contact?.formulation;
    return {
      document: current,
      summary:
        `${command}: stack '${stack.id}' (${geometry.plates.length} plate(s), grip ${n(grip)} ${doc.units}) in '${params.analysisId}': bolt '${affected[1]}' on '${params.boltEntityId}' ` +
        `(section at the grip mid-plane, normal [${geometry.direction.map(n).join(', ')}]), ${pairIds.length} contact pair(s) [${pairIds.join(', ')}] ` +
        `(formulation ${used}${formulation !== undefined && params.formulation === undefined ? ' by default' : ''}, behaviour ${behaviour}, ${friction}).${unmodelled}${phi} ${NOT_APPROVED}`,
      affected,
      data: { analysisId: params.analysisId, stackId: stack.id, boltId: affected[1] ?? null, pairIds, stiffness, reviewRequired: true },
    };
  },
});
