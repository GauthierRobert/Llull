/** Shared preparation of the flat-pattern queries: part lookup, analytic unfold, provenance and unverified inputs. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { FtrResultMeta } from '@core/model/manufacturing';
import type { SheetMetalPart, SheetMetalRule } from '@core/model/sheetMetal';
import { toDegrees } from '@lib/angle';
import { FORMULAS } from '@lib/sheetMath';
import { getModel, ruleOfPart } from './graph';
import { refuse, resultMeta } from './result';
import { ruleUnverifiedInputs } from './rules';
import { type FlatPatternGeometry, unfoldPart } from './unfold';

export interface FlatBuild {
  readonly part: SheetMetalPart;
  readonly rule: SheetMetalRule;
  readonly geometry: FlatPatternGeometry;
  readonly meta: FtrResultMeta;
}

/** The part, its rule and unfolded geometry, or the refusal to return. */
export function buildFlat(doc: CadDocument, command: string, partId: string): FlatBuild | { readonly refusal: CommandResult } {
  const model = getModel(doc);
  const part = model.parts[partId];
  if (part === undefined)
    return {
      refusal: refuse(
        doc,
        command,
        'FTR_PART_NOT_FOUND',
        `no sheet-metal part "${partId}"`,
        'List parts with describe_scene or create one with add_sheet_metal_base.',
        { paths: ['id'] },
      ),
    };
  const rule = ruleOfPart(model, part);
  if (rule === undefined)
    return {
      refusal: refuse(
        doc,
        command,
        'FTR_RULE_NOT_FOUND',
        `rule "${part.rule}" of part ${part.id} is missing`,
        'Recreate the rule with create_sheet_metal_rule.',
        { ids: [part.id] },
      ),
    };
  const geometry = unfoldPart(part, rule);
  if (geometry === null)
    return {
      refusal: refuse(
        doc,
        command,
        'FTR_NON_DEVELOPABLE',
        `part ${part.id} has no closed flat boundary`,
        'Check the flats of the part; it cannot be developed.',
        { ids: [part.id] },
      ),
    };
  const unverifiedInputs = ruleUnverifiedInputs(model, rule, doc.units);
  const meta = resultMeta({
    lengthUnit: doc.units,
    unverifiedInputs,
    formulas: {
      ba: FORMULAS.ba,
      ossb: FORMULAS.ossb,
      bd: FORMULAS.bd,
      kChart: FORMULAS.kChart,
      joggleRun: FORMULAS.joggleRun,
      joggleAllowance: FORMULAS.joggleAllowance,
    },
    inputs: {
      thickness: { value: rule.thickness, unit: doc.units, source: `rule ${rule.name}` },
      ...Object.fromEntries(geometry.bends.map((bend) => [`${bend.id}.kFactor`, { value: bend.k.value, source: bend.k.source }])),
      ...Object.fromEntries(
        geometry.bends.map((bend) => [
          `${bend.id}.angle`,
          { value: toDegrees(Math.abs(bend.angle)), unit: 'deg', source: `part ${part.id}` },
        ]),
      ),
    },
    sources: ['R2', 'R7', `rule ${rule.name}`],
  });
  return { part, rule, geometry, meta };
}

export const isRefusal = (built: FlatBuild | { readonly refusal: CommandResult }): built is { readonly refusal: CommandResult } =>
  'refusal' in built;
