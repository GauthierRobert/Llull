/** Input resolution of moisture_uptake: diffusivity, boundary content and initial content from parameters, the saturation law or the material record. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { equilibriumContent } from './fick';
import { givenInput, materialInput, type GivenQuantity, type ResolvedInput } from './inputs';
import { materialProperty, type MaterialMissing } from './materialValue';
import type { UnitProblem } from './units';

export interface UptakeInputs {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext | undefined;
  readonly material: string | undefined;
  readonly at: Readonly<Record<string, { readonly value: number; readonly unit: string }>>;
  readonly mode: 'absorption' | 'desorption';
  /** Relative humidity % of the mission exposure (default of the saturation law). */
  readonly relativeHumidity: number | undefined;
}

export interface SaturationLaw {
  readonly a: number;
  readonly b: number;
  readonly relativeHumidity?: number | undefined;
  readonly source?: string | undefined;
}

const missing = (code: string, reason: string): MaterialMissing => ({ code, reason });
const invalid = (path: string, message: string): UnitProblem => ({ path, message });
const named = (text: string, value: number): ResolvedInput => ({ value, unit: '%', source: `named default: ${text}`, unverified: false });

/** D (m^2/s): the parameter, else the material's moistureDiffusivity at the operating point. */
export function diffusivityInput(request: UptakeInputs, given: GivenQuantity | undefined): ResolvedInput | UnitProblem | MaterialMissing {
  if (given !== undefined) return givenInput(given, 'm^2/s', 'diffusivity');
  if (request.material === undefined)
    return missing('ENV_PROPERTY_MISSING', 'no diffusivity: give `diffusivity` or a `material` with a moistureDiffusivity property');
  const found = materialProperty(request.doc, request.ctx, request.material, 'moistureDiffusivity', 'm^2/s', request.at);
  return 'reason' in found ? found : materialInput(found);
}

/** The boundary content (%): `saturation`; desorption defaults to the dry value 0; else the saturation law, else the material's moistureSaturation. */
export function boundaryInput(
  request: UptakeInputs,
  given: GivenQuantity | undefined,
  law: SaturationLaw | undefined,
  defaults: string[],
): ResolvedInput | UnitProblem | MaterialMissing {
  if (given !== undefined) return givenInput(given, '%', 'saturation');
  if (request.mode === 'desorption') {
    defaults.push('saturation = 0 % (dry boundary)');
    return named('vacuum dry-out boundary 0 %', 0);
  }
  if (law !== undefined) {
    const humidity = law.relativeHumidity ?? request.relativeHumidity;
    if (humidity === undefined || !(humidity >= 0 && humidity <= 100))
      return invalid('saturationLaw.relativeHumidity', 'relative humidity must be given between 0 and 100 %');
    if (!Number.isFinite(law.a) || !Number.isFinite(law.b)) return invalid('saturationLaw', 'a and b must be finite');
    const sourced = law.source !== undefined && law.source.trim() !== '';
    return {
      value: equilibriumContent(law.a, law.b, humidity),
      unit: '%',
      source: sourced ? `${law.source} (M_inf = a RH^b, a ${law.a}, b ${law.b}, RH ${humidity} %)` : undefined,
      unverified: !sourced,
    };
  }
  if (request.material === undefined)
    return missing(
      'ENV_PROPERTY_MISSING',
      'no saturation: give `saturation`, `saturationLaw` or a `material` with a moistureSaturation property',
    );
  const found = materialProperty(request.doc, request.ctx, request.material, 'moistureSaturation', '%', request.at);
  return 'reason' in found ? found : materialInput(found);
}

/** The initial content (%): `initial`; absorption defaults to dry (0 %, named default); desorption requires it. */
export function initialInput(request: UptakeInputs, given: GivenQuantity | undefined, defaults: string[]): ResolvedInput | UnitProblem {
  if (given !== undefined) return givenInput(given, '%', 'initial');
  if (request.mode === 'desorption') return invalid('initial', 'desorption needs the starting content `initial`');
  defaults.push('initial = 0 % (dry start)');
  return named('dry start 0 %', 0);
}
