/** Shared preparation of the flat-pattern queries: part lookup, analytic unfold, provenance and unverified inputs. */

import type { CadDocument } from '@core/model/types';
import type { FtrResultMeta, FtrUnverifiedInput } from '@core/model/manufacturing';
import type { SheetMetalPart, SheetMetalRule } from '@core/model/sheetMetal';
import { toDegrees } from '@lib/angle';
import { FORMULAS } from '@lib/sheetMath';
import { FLANGED_HOLE_SOURCE, HEM_SOURCE } from './provenance';
import { resultMeta, refuser } from './result';
import { ruleUnverifiedInputs } from './rules';
import { type FlatPatternGeometry, unfoldPart } from './unfold';
import { type Refusal, isRefusal, partContext } from './partLookup';

export interface FlatBuild {
  readonly part: SheetMetalPart;
  readonly rule: SheetMetalRule;
  readonly geometry: FlatPatternGeometry;
  readonly meta: FtrResultMeta;
}

/** The part, its rule and unfolded geometry, or the refusal to return. */
export function buildFlat(doc: CadDocument, command: string, partId: string): FlatBuild | Refusal {
  const fail = refuser(doc, command);
  const found = partContext(doc, partId, fail);
  if (isRefusal(found)) return found;
  const { model, part, rule } = found;
  const geometry = unfoldPart(part, rule);
  if (geometry === null)
    return {
      refusal: fail(
        'FTR_NON_DEVELOPABLE',
        `part ${part.id} has no closed flat boundary`,
        'Check the flats of the part; it cannot be developed.',
        { ids: [part.id] },
      ),
    };
  const unverifiedInputs: FtrUnverifiedInput[] = [
    ...ruleUnverifiedInputs(model, rule, doc.units),
    ...geometry.forms.flatMap((form): FtrUnverifiedInput[] =>
      form.kind === 'flanged_hole' ? [{ kind: 'preset', id: `flanged_hole:${part.id}/${form.id}`, source: FLANGED_HOLE_SOURCE }] : [],
    ),
    ...geometry.hems.map((hem): FtrUnverifiedInput => ({ kind: 'preset', id: `hem:${part.id}/${hem.id}`, source: HEM_SOURCE })),
  ];
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
      ...(geometry.hems.length > 0 ? { hemAllowance: FORMULAS.hemAllowance, hemDeveloped: FORMULAS.hemDeveloped } : {}),
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
