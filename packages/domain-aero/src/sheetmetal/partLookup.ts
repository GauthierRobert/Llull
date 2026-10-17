/** Lookups shared by the sheet-metal commands — the part with its rule, the flat under a picked point — each with its FTR refusal. */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { SheetMetalModel, SheetMetalPart, SheetMetalRule } from '@core/model/sheetMetal';
import { getModel, ruleOfPart } from './graph';
import { type FlatHit, pickFlat } from './pick';
import type { Fail } from './result';

export interface Refusal {
  readonly refusal: CommandResult;
}

export const isRefusal = <T extends object>(value: T | Refusal): value is Refusal => 'refusal' in value;

export interface PartContext {
  readonly model: SheetMetalModel;
  readonly part: SheetMetalPart;
  readonly rule: SheetMetalRule;
}

/** The part `id` with its model and rule, or the FTR_PART_NOT_FOUND / FTR_RULE_NOT_FOUND refusal. */
export function partContext(doc: CadDocument, id: string, fail: Fail): PartContext | Refusal {
  const model = getModel(doc);
  const part = Object.hasOwn(model.parts, id) ? model.parts[id] : undefined;
  if (part === undefined)
    return {
      refusal: fail(
        'FTR_PART_NOT_FOUND',
        `no sheet-metal part "${id}"`,
        'List parts with describe_scene or create one with add_sheet_metal_base.',
        { paths: ['id'] },
      ),
    };
  const rule = ruleOfPart(model, part);
  if (rule === undefined)
    return {
      refusal: fail(
        'FTR_RULE_NOT_FOUND',
        `rule "${part.rule}" of part ${part.id} is missing`,
        'Recreate the rule with create_sheet_metal_rule.',
        { ids: [part.id] },
      ),
    };
  return { model, part, rule };
}

/** The flat within one thickness of `near` (param path `path`), or the FTR_FACE_NOT_FOUND refusal. */
export function flatNear(
  part: SheetMetalPart,
  thickness: number,
  near: Vec3,
  path: string,
  fail: Fail,
  fix = 'Pick a point on a flat face of the part.',
): FlatHit | Refusal {
  const hit = pickFlat(part, thickness, near);
  if (hit === null || hit.distance > thickness + 1e-6)
    return {
      refusal: fail('FTR_FACE_NOT_FOUND', `no flat within one thickness of ${JSON.stringify(near)}`, fix, {
        ids: [part.id],
        paths: [path],
      }),
    };
  return hit;
}
