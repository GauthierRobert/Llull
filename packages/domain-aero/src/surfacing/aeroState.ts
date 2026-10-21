/** Read / write access to `CadDocument.aero` (absent until the first airfoil or wing command). */

import type { AeroModel, AircraftFrame, AirfoilDef, BodyDef, WingDef } from '@aero/surfacing/types';
import type { CadDocument } from '@core/model/types';

const EMPTY: AeroModel = { airfoils: {}, wings: {} };

export const aeroOf = (doc: CadDocument): AeroModel => doc.aero ?? EMPTY;

export const withAirfoil = (doc: CadDocument, airfoil: AirfoilDef): CadDocument => ({
  ...doc,
  aero: { ...aeroOf(doc), airfoils: { ...aeroOf(doc).airfoils, [airfoil.id]: airfoil } },
});

export const withBody = (doc: CadDocument, body: BodyDef): CadDocument => ({
  ...doc,
  aero: { ...aeroOf(doc), bodies: { ...aeroOf(doc).bodies, [body.id]: body } },
});

export const withWing = (doc: CadDocument, wing: WingDef): CadDocument => ({
  ...doc,
  aero: { ...aeroOf(doc), wings: { ...aeroOf(doc).wings, [wing.id]: wing } },
});

export const withFrame = (doc: CadDocument, frame: AircraftFrame): CadDocument => ({ ...doc, aero: { ...aeroOf(doc), frame } });
