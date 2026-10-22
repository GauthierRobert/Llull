/** The `data` conventions of the wrap commands (03 WRP §7.2): units on every number, `unverified`, provenance and the named defaults used. */

import type { CadDocument } from '../../model/types';
import { namedDefault, type NamedDefault } from '../mesh/meshCommon';

export { namedDefault };

export interface WrapProvenance {
  readonly method: string;
  readonly font?: { readonly family: string; readonly sha256: string };
  readonly inputs: Readonly<Record<string, unknown>>;
}

export function wrapData(
  doc: CadDocument,
  fields: Record<string, unknown>,
  context: { readonly unverified: boolean; readonly provenance: WrapProvenance; readonly defaults?: ReadonlyArray<NamedDefault> },
): Record<string, unknown> {
  return {
    ...fields,
    unit: doc.units,
    lengthUnit: doc.units,
    areaUnit: `${doc.units}^2`,
    volumeUnit: `${doc.units}^3`,
    unverified: context.unverified,
    provenance: context.provenance,
    defaults: context.defaults ?? [],
  };
}

/** The default `maxLengthStrain` (D-WRP-4): 2 % relative length change. */
export const DEFAULT_MAX_LENGTH_STRAIN = 0.02;
export const MAX_LENGTH_STRAIN_SOURCE = 'llull WRP default (D-WRP-4)';
