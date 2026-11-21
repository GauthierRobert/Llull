/** Shared tail of add_winder_stair / add_spiral_stair: the rise, the element, its commit and the result data. */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { toMm } from '@core/model/units';
import type { RadialStairElement, RadialStairForm, SteelStairTread } from '@aec/building/types';
import { appendElements, getBuilding, resolveLevel } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { findTwin, samePoint } from '../../../shared/duplicates';
import { round } from '../../../shared/numeric';
import { refuse } from '../codes';
import type { RadialGeometry } from './radialLayout';
import { radialQuantities } from './radialMeasure';

const MAX_RISE_MM = 30_000;
const MAX_RISERS = 200;

export const RULES_NOTE =
  'No winder / spiral going, rise or walkline rule is cited in validation/sources.md (OSHA 1910.25 and ISO 14122-3 rows describe straight stairs only), so none is checked: the measures are reported, not judged.';

export type RadialFail = (message: string, paths?: string[]) => CommandResult;

type Rise =
  | { readonly ok: true; readonly riseMm: number; readonly riserCount: number; readonly riserHeight: number }
  | { readonly ok: false; readonly result: CommandResult };

/** The equal risers of a rise given in document units, or the refusal. */
export function riseFor(doc: CadDocument, rise: number, riserMax: number, minimum: number, fail: RadialFail): Rise {
  const riseMm = toMm(doc, rise);
  if (riseMm > MAX_RISE_MM) return { ok: false, result: fail(`rise ${round(riseMm, 1)} mm is above 30 m: check the units`, ['rise']) };
  const riserCount = Math.ceil(rise / riserMax - 1e-9);
  if (riserCount < minimum)
    return {
      ok: false,
      result: fail(`rise ${rise} with riserMax ${riserMax} gives ${riserCount} riser(s): this stair needs ${minimum}+`, ['riserMax']),
    };
  if (riserCount > MAX_RISERS) return { ok: false, result: fail(`${riserCount} risers: check the units of rise / riserMax`, ['riserMax']) };
  return { ok: true, riseMm, riserCount, riserHeight: rise / riserCount };
}

export interface RadialSetup {
  readonly form: RadialStairForm;
  readonly name: 'add_winder_stair' | 'add_spiral_stair';
  readonly start: Vec3;
  readonly angle: number;
  readonly rise: number;
  readonly riserCount: number;
  readonly riserHeight: number;
  readonly width: number;
  readonly turn: 'left' | 'right';
  readonly profile: string;
  readonly tread: SteelStairTread;
  readonly levelId: string | undefined;
  readonly geometry: RadialGeometry;
  readonly defaulted: string[];
  /** Form-specific result data and summary text. */
  readonly extra: Record<string, unknown>;
  readonly extraSummary: string;
}

/** Appends the element to the building and returns the result with the common data. */
export function commitRadial(doc: CadDocument, setup: RadialSetup): CommandResult {
  const fail = (message: string, paths: string[] = [], ids: string[] = []): CommandResult =>
    refuse(doc, setup.name, 'STA_INVALID_GEOMETRY', message, ids, paths);
  const building = getBuilding(doc);
  const resolution = resolveLevel(doc, building, setup.levelId);
  if (!resolution.ok) return fail(resolution.reason, ['levelId']);
  const { level } = resolution;
  const twin = findTwin(
    resolution.building,
    'radialStair',
    level.id,
    (element) =>
      element.form === setup.form && element.angle === setup.angle && element.rise === setup.rise && samePoint(element.start, setup.start),
  );
  if (twin !== undefined)
    return fail(`a ${setup.form} stair from this start, angle and rise already exists as ${twin.id} (${twin.mark})`, [], [twin.id]);
  const added = appendElements(
    resolution.building,
    [0],
    'radialStair',
    (_, id, mark): RadialStairElement => ({
      id,
      category: 'radialStair',
      mark,
      entityIds: [],
      levelId: level.id,
      form: setup.form,
      start: setup.start,
      angle: setup.angle,
      rise: setup.rise,
      width: setup.width,
      riserCount: setup.riserCount,
      riserHeight: setup.riserHeight,
      turn: setup.turn,
      profile: setup.profile,
      tread: setup.tread,
      plates: setup.geometry.plates,
      runs: setup.geometry.runs,
    }),
  );
  const stairId = added.ids[0] as string;
  const result = commitBuilding(doc, added.building, [stairId], (document) => {
    const mark = document.building?.elements[stairId]?.mark;
    return `Added ${setup.form} stair ${mark} (${stairId}): ${round(toMm(doc, setup.rise), 1)} mm rise, ${setup.riserCount} risers of ${round(toMm(doc, setup.riserHeight), 3)} mm, ${setup.geometry.plates.length} treads, ${setup.extraSummary}. ${setup.defaulted.length > 0 ? `Defaults: ${setup.defaulted.join('; ')}. ` : ''}${RULES_NOTE}`;
  });
  const element = result.document.building?.elements[stairId];
  if (element?.category !== 'radialStair') return result;
  const quantities = radialQuantities(result.document, element);
  return {
    ...result,
    data: {
      elementIds: [stairId],
      stairId,
      form: setup.form,
      riserCount: setup.riserCount,
      treadCount: quantities.treads,
      riserHeightMm: round(toMm(doc, setup.riserHeight), 4),
      widthMm: round(toMm(doc, setup.width), 3),
      treadAreaM2: round(quantities.treadAreaM2, 4),
      treadKg: round(quantities.treadKg, 3),
      sectionKg: round(quantities.sectionKg, 3),
      steelKg: round(quantities.steelKg, 3),
      endPlanMm: [round(toMm(doc, setup.geometry.end[0]), 3), round(toMm(doc, setup.geometry.end[1]), 3)],
      rules: { evaluated: false, reason: RULES_NOTE },
      defaults: setup.defaulted,
      ...setup.extra,
    },
  };
}
