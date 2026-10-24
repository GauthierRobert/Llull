/**
 * Insulation of a line (02 RTE §5.10): the thickness is given or read from the spec's insulation table by code, size and design temperature; the
 * envelope diameter is the pipe outside diameter + 2 x thickness. Pure.
 */

import type { LineInsulation } from '@aec/plant/types';
import { isMiss, type SpecLookup, type SpecMiss } from './specLookup';

/** The request that reads `insulation` (a spec-sourced record) from the table again, keeping a material the user gave. */
export const rereadRequest = (insulation: LineInsulation): InsulationRequest => ({
  code: insulation.code,
  thickness: 'fromSpec',
  ...(insulation.materialExplicit === true && insulation.material !== undefined ? { material: insulation.material } : {}),
});

export interface InsulationRequest {
  readonly code: string;
  /** mm, or `fromSpec` to read the spec's table. */
  readonly thickness: number | 'fromSpec';
  readonly material?: string | undefined;
}

/**
 * The insulation record for a line of size `dn` at `designTempC`.
 * @failure fromSpec without a design temperature, a spec without a table or without a row for the code / size / temperature -> the spec miss
 */
export function resolveInsulation(
  lookup: SpecLookup,
  dn: number,
  designTempC: number | undefined,
  request: InsulationRequest,
): LineInsulation | SpecMiss {
  const material = request.material === undefined ? {} : { material: request.material };
  if (request.thickness !== 'fromSpec') return { code: request.code, thicknessMm: request.thickness, ...material, source: 'explicit' };
  if (designTempC === undefined)
    return {
      miss: 'RTE_SPEC_NO_COMPONENT',
      detail: `insulation "${request.code}" from the spec needs the line design temperature (designTempC) to pick the table row`,
      ids: [],
      paths: ['designTempC'],
    };
  const choice = lookup.insulation(request.code, dn, designTempC);
  if (isMiss(choice)) return choice;
  return {
    code: request.code,
    thicknessMm: choice.thicknessMm,
    material: request.material ?? choice.material,
    ...(request.material === undefined ? {} : { materialExplicit: true }),
    source: 'spec',
    row: choice.row,
  };
}

/** Outer diameter of the insulation around a pipe of outside diameter `odMm`. */
export const envelopeDiameter = (odMm: number, insulation: Pick<LineInsulation, 'thicknessMm'>): number =>
  odMm + 2 * insulation.thicknessMm;
