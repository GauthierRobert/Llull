/** Read / write access to `CadDocument.aero` (absent until the first airfoil or wing command). */

import type { AeroModel, AirfoilDef, WingDef } from '@core/model/aero';
import type { CadDocument } from '@core/model/types';

const EMPTY: AeroModel = { airfoils: {}, wings: {} };

export const aeroOf = (doc: CadDocument): AeroModel => doc.aero ?? EMPTY;

export const withAirfoil = (doc: CadDocument, airfoil: AirfoilDef): CadDocument => ({
  ...doc,
  aero: { ...aeroOf(doc), airfoils: { ...aeroOf(doc).airfoils, [airfoil.id]: airfoil } },
});

export const withWing = (doc: CadDocument, wing: WingDef): CadDocument => ({
  ...doc,
  aero: { ...aeroOf(doc), wings: { ...aeroOf(doc).wings, [wing.id]: wing } },
});
