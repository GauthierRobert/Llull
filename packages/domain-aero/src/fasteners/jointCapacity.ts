/** joint_capacity (08 MAT FR-MAT-20, M9, VC-MAT-21): single-shear and bearing capacity of one placed fastener stack from sourced allowables. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { BASES, type Basis } from '@core/model/propertyModel';
import type { CadDocument } from '@core/model/types';
import { refuse } from './codes';
import { familyOf, fastenerModel, sizeOf } from './fastenerDoc';
import { propagateBasis } from './jointBasis';
import { convertTo, docToInches } from './units';

const COMMAND = 'joint_capacity';
const N_PER_LBF = 4.4482216152605;

interface Allowable {
  readonly role: string;
  readonly material: string;
  readonly property: string;
  readonly basis: Basis;
  readonly value: number;
  readonly unit: string;
  readonly modelId: string;
  readonly provenance: unknown;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

type Lookup =
  | { readonly ok: true; readonly allowable: Allowable; readonly psi: number }
  | { readonly ok: false; readonly result: CommandResult };

function lookup(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  role: string,
  query: Record<string, unknown> & { material: string; property: string; basis: Basis },
): Lookup {
  const answer = execute(doc, 'get_material_allowable', query, ctx);
  const data = (answer.data ?? {}) as Record<string, unknown>;
  const psi = typeof data['value'] === 'number' && typeof data['unit'] === 'string' ? convertTo(data['value'], data['unit'], 'psi') : null;
  if (data['available'] !== true || psi === null)
    return {
      ok: false,
      result: {
        ...refuse(
          doc,
          COMMAND,
          answer.error?.code ?? 'MAT_ALLOWABLE_NOT_AVAILABLE',
          `${role}: ${answer.summary}`,
          answer.error?.ids ?? [query.material],
        ),
        ...(answer.data !== undefined ? { data: answer.data } : {}),
      },
    };
  return {
    ok: true,
    psi,
    allowable: {
      role,
      material: query.material,
      property: query.property,
      basis: data['basis'] as Basis,
      value: data['value'] as number,
      unit: data['unit'] as string,
      modelId: String(data['modelId']),
      provenance: data['provenance'],
      unverified: data['unverified'] === true,
      unverifiedReasons: (data['unverifiedReasons'] as string[] | undefined) ?? [],
    },
  };
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const capacity = (lbf: number): { lbf: number; N: number } => ({ lbf: round(lbf), N: round(lbf * N_PER_LBF) });

interface Mode {
  readonly mode: 'shear' | 'bearing';
  readonly entityId?: string;
  readonly lbf: number;
  readonly N: number;
}

/**
 * @affects nothing — read-only; data { shear, bearing[], governing, basis, inputs[], unverified, unverifiedReasons, reviewRequired: true }
 * @invariant shear = Fsu · πD²/4 (one plane); bearing(layer) = Fbru · D · t at the given e/D; basis follows §5.6 and is never upgraded;
 *   capacities are returned even when an input is unverified, but flagged; reviewRequired is always true
 * @failure unknown stack FAST_STACK_NOT_FOUND; missing layer / unassigned sheet material FAST_LAYER_MISSING; a value that cannot be read
 *   (basis never substituted) keeps the get_material_allowable code (MAT_ALLOWABLE_NOT_AVAILABLE, MAT_LIBRARY_UNRESOLVED, …)
 */
export const jointCapacity = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Joint capacity of one placed fastener stack (read-only, V2 hook): single shear = fastener Fsu × π·D²/4 (one shear plane) and, for each ' +
    'sheet layer, bearing = sheet Fbru × D × layer thickness at edge ratio e/D. D is the catalogue nominal diameter; each sheet uses the ' +
    'material assigned to its entity (assign_material); the fastener material is fastenerMaterial. Values come from get_material_allowable ' +
    'with the EXACT basis you give (never substituted). The result basis follows MMPDS rules and is never upgraded: A only if every input is ' +
    'A; B if all are A or B; otherwise "mixed" with the per-input list in data.inputs. Typical / supplier values make the capacities ' +
    'unverified (data.unverified). The capacities are an input to a stress check, not a margin: reviewRequired is always true.',
  params: z.object({
    stackId: z.string().describe('Id of a placed stack (fst-…); check_fastener_layout lists them.'),
    fastenerMaterial: z.string().describe('Material id of the fastener (record carrying the shear allowable Fsu).'),
    fastenerBasis: z.enum(BASES).describe('Basis of the fastener Fsu value to use (A, B, S, …); no other basis is substituted.'),
    sheetBasis: z.enum(BASES).describe('Basis of the sheet Fbru value to use; no other basis is substituted.'),
    edOverD: z
      .number()
      .positive()
      .describe('Edge-distance ratio e/D of the bearing allowable (1.5 or 2.0): the Fbru value is keyed by it.'),
    sheetDirection: z.string().optional().describe('Grain direction of the sheet value (L, LT, …); omit for a direction-free value.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const stack = Object.hasOwn(fastenerModel(doc).stacks, params.stackId) ? fastenerModel(doc).stacks[params.stackId] : undefined;
    if (stack === undefined)
      return refuse(doc, COMMAND, 'FAST_STACK_NOT_FOUND', `no stack '${params.stackId}'`, [params.stackId], ['stackId']);
    const family = familyOf(doc, stack.fastener.family);
    const size = family === undefined ? undefined : sizeOf(family, stack.fastener.diameterDash);
    const diameter = size === undefined ? null : convertTo(size.nominalDiameter.value, size.nominalDiameter.unit, 'in');
    if (diameter === null)
      return refuse(
        doc,
        COMMAND,
        'FAST_SIZE_UNKNOWN',
        `the catalogue no longer has ${stack.fastener.family} size ${stack.fastener.diameterDash}`,
        [stack.id],
      );
    const shear = lookup(doc, ctx, 'fastener shear Fsu', {
      material: params.fastenerMaterial,
      property: 'Fsu',
      basis: params.fastenerBasis,
    });
    if (!shear.ok) return shear.result;
    const inputs: Allowable[] = [shear.allowable];
    const bearing: Array<Mode & { material: string; thicknessIn: number }> = [];
    for (const layer of stack.layers) {
      const materialId = doc.entities[layer.entityId]?.materialId;
      if (materialId === undefined)
        return refuse(doc, COMMAND, 'FAST_LAYER_MISSING', `layer '${layer.entityId}' does not exist or has no material (assign_material)`, [
          layer.entityId,
        ]);
      const thicknessIn = docToInches(doc, layer.thickness);
      const found = lookup(doc, ctx, `sheet bearing Fbru (${layer.entityId})`, {
        material: materialId,
        property: 'Fbru',
        basis: params.sheetBasis,
        edOverD: params.edOverD,
        thickness: { value: round(thicknessIn), unit: 'in' },
        ...(params.sheetDirection !== undefined ? { direction: params.sheetDirection } : {}),
      });
      if (!found.ok) return found.result;
      inputs.push(found.allowable);
      bearing.push({
        mode: 'bearing',
        entityId: layer.entityId,
        material: materialId,
        thicknessIn: round(thicknessIn),
        ...capacity(found.psi * diameter * thicknessIn),
      });
    }
    const area = (Math.PI * diameter * diameter) / 4;
    const shearCapacity = capacity(shear.psi * area);
    const modes: Mode[] = [{ mode: 'shear', ...shearCapacity }, ...bearing];
    const governing = modes.reduce((lowest, mode) => (mode.lbf < lowest.lbf ? mode : lowest));
    const basis = propagateBasis(inputs.map((input) => ({ role: input.role, basis: input.basis })));
    const unverified = inputs.some((input) => input.unverified);
    const unverifiedReasons = inputs.flatMap((input) => input.unverifiedReasons.map((reason) => `${input.role}: ${reason}`));
    const perInput = basis === 'mixed' ? ` (${inputs.map((input) => `${input.role}: ${input.basis}`).join('; ')})` : '';
    return report(
      doc,
      `joint_capacity ${stack.id} (${stack.fastener.partNumber}, D ${round(diameter)} in, e/D ${params.edOverD}): shear ${shearCapacity.lbf} lbf, ` +
        `bearing [${bearing.map((entry) => `${entry.entityId} ${entry.lbf} lbf`).join(', ')}], governing ${governing.mode} ${governing.lbf} lbf; ` +
        `basis ${basis}${perInput}${unverified ? '; UNVERIFIED inputs' : ''}; review required.`,
      {
        stackId: stack.id,
        diameterIn: round(diameter),
        edOverD: params.edOverD,
        shear: { ...shearCapacity, planes: 1, areaIn2: round(area) },
        bearing,
        governing,
        basis,
        inputs,
        unverified,
        unverifiedReasons,
        reviewRequired: true,
      },
    );
  },
});
