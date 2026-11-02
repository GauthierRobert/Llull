/** SC-EQP-01 / SC-EQP-02 as reusable fixtures (docs/plant/03-parametric-equipment/validation/plans). */

import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';

const ellipsoidal = { type: 'ellipsoidal', ratio: 2 } as const;

export const mmDocument = (): CadDocument => apply(createEmptyDocument(), 'set_units', { units: 'mm' });

export const separatorParams = {
  tag: 'V-101',
  name: 'HP separator',
  orientation: 'vertical',
  location: [5000, 5000],
  insideDiameter: 1500,
  tangentLength: 4000,
  heads: { top: ellipsoidal, bottom: ellipsoidal },
  shellThickness: 10,
  headThickness: 10,
  corrosionAllowance: 3,
  support: { type: 'skirt', height: 2000, thickness: 10 },
  design: {
    pressure: { value: 1, unit: 'MPa' },
    temperatureC: 150,
    material: 'SA-516 Gr 70',
    allowableStress: { value: 137.9, unit: 'MPa', source: 'user input' },
    jointEfficiency: { shell: 1, heads: 1 },
    materialDensityKgM3: 7850,
    operatingLiquid: { specificGravity: 0.85, levelAboveBottomTangent: 1500 },
  },
};

export const drumParams = {
  tag: 'D-201',
  name: 'Reflux drum',
  orientation: 'horizontal',
  location: [0, 0],
  insideDiameter: 2000,
  tangentLength: 6000,
  heads: { left: ellipsoidal, right: ellipsoidal },
  shellThickness: 18,
  headThickness: 16,
  corrosionAllowance: 3,
  support: { type: 'saddles', stations: [1200, 4800], width: 250, axisElevation: 1500 },
  design: {
    pressure: { value: 1.5, unit: 'MPa' },
    allowableStress: { value: 137.9, unit: 'MPa', source: 'user input' },
    jointEfficiency: { shell: 0.85, heads: 1 },
    materialDensityKgM3: 7850,
  },
};

export const separatorNozzles = [
  {
    mark: 'N1',
    service: 'inlet',
    dn: 150,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'shell', elevation: 3200, orientationDeg: 0 },
    projection: 1000,
  },
  {
    mark: 'N2',
    service: 'liquid outlet',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'head', head: 'bottom', radialOffset: 0 },
    projection: 600,
  },
  {
    mark: 'N3',
    service: 'vapour outlet',
    dn: 80,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'head', head: 'top', radialOffset: 0 },
    projection: 700,
  },
  {
    mark: 'M1',
    service: 'manway',
    dn: 500,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'shell', elevation: 1000, orientationDeg: 180 },
    projection: 1000,
  },
];

export const drumNozzles = [
  {
    mark: 'N1',
    service: 'inlet',
    dn: 200,
    rating: 'CL300',
    facing: 'RF',
    location: { on: 'shell', station: 600, orientationDeg: 0 },
    projection: 1400,
  },
  {
    mark: 'N2',
    service: 'outlet',
    dn: 150,
    rating: 'CL300',
    facing: 'RF',
    location: { on: 'shell', station: 5400, orientationDeg: 180 },
    projection: 1300,
  },
  {
    mark: 'N3',
    service: 'PSV',
    dn: 100,
    rating: 'CL300',
    facing: 'RF',
    location: { on: 'shell', station: 3000, orientationDeg: 0 },
    projection: 1100,
  },
  {
    mark: 'N4',
    service: 'level bridle',
    dn: 50,
    rating: 'CL300',
    facing: 'RF',
    location: { on: 'head', head: 'right', radialOffset: 0 },
    projection: 1000,
  },
];

/** A document with V-101 (and its four nozzles when `withNozzles`). */
export function separatorDocument(withNozzles = true): CadDocument {
  let doc = apply(mmDocument(), 'add_vessel', separatorParams);
  if (withNozzles) for (const nozzle of separatorNozzles) doc = apply(doc, 'add_nozzle', { equipment: 'V-101', ...nozzle });
  return doc;
}

export function drumDocument(withNozzles = true): CadDocument {
  let doc = apply(mmDocument(), 'add_vessel', drumParams);
  if (withNozzles) for (const nozzle of drumNozzles) doc = apply(doc, 'add_nozzle', { equipment: 'D-201', ...nozzle });
  return doc;
}

/** SC-EQP-03: fixed-tubesheet exchanger E-301, TEMA BEM. */
export const bemParams = {
  tag: 'E-301',
  name: 'Product cooler',
  temaType: 'BEM',
  location: [0, 8000],
  orientation: 'horizontal',
  shellInsideDiameter: 600,
  shellThickness: 8,
  tubes: { outsideDiameter: 19.05, wallThickness: 1.651, count: 300, length: 4877, passes: 2, pitch: 23.8125, layoutAngleDeg: 30 },
  tubesheetThickness: 50,
  frontChannel: { length: 300 },
  rearChannel: { length: 300 },
  support: { type: 'saddles', stations: [800, 4077], width: 200, axisElevation: 1000 },
  design: {
    shellSide: { pressure: { value: 1, unit: 'MPa' }, temperatureC: 120 },
    tubeSide: { pressure: { value: 0.6, unit: 'MPa' }, temperatureC: 60 },
  },
};

export const bemNozzles = [
  {
    mark: 'S1',
    service: 'shell inlet',
    dn: 150,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'shell', station: 400, orientationDeg: 0 },
    projection: 600,
  },
  {
    mark: 'S2',
    service: 'shell outlet',
    dn: 150,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'shell', station: 4377, orientationDeg: 180 },
    projection: 600,
  },
  {
    mark: 'T1',
    service: 'tube inlet',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'channel', channel: 'front', station: 150, orientationDeg: 180 },
    projection: 550,
  },
  {
    mark: 'T2',
    service: 'tube outlet',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'channel', channel: 'front', station: 150, orientationDeg: 0 },
    projection: 550,
  },
];

export function bemDocument(withNozzles = true): CadDocument {
  let doc = apply(mmDocument(), 'add_heat_exchanger', bemParams);
  if (withNozzles) for (const nozzle of bemNozzles) doc = apply(doc, 'add_nozzle', { equipment: 'E-301', ...nozzle });
  return doc;
}

/** SC-EQP-04: API 650 cone-roof water tank T-401 (D 20 m, six 2 m courses, A36M). */
export const tankParams = {
  tag: 'T-401',
  name: 'Fire water tank',
  standard: 'api_650',
  location: [30000, 0],
  diameter: 20000,
  shellHeight: 12000,
  courses: [2000, 2000, 2000, 2000, 2000, 2000],
  roof: { type: 'cone', slopeRatio: '1:12' },
  bottom: { type: 'flat', annularPlate: false },
  design: { specificGravity: 1, designLiquidLevel: 12000, material: 'A36M', corrosionAllowance: 1.5, materialDensityKgM3: 7850 },
};

export const tankDocument = (): CadDocument => apply(mmDocument(), 'add_storage_tank', tankParams);

/** An ISO 2858 65-40-250 pump with a motor and a vendor weight. */
export const pumpParams = {
  tag: 'P-101',
  name: 'Feed pump',
  location: [2000, 3000],
  standard: 'iso_2858',
  size: '65-40-250',
  api610Type: 'OH1',
  driver: { length: 600, width: 400, height: 400 },
  weightKg: 310,
};

export const pumpDocument = (): CadDocument => apply(mmDocument(), 'add_pump', pumpParams);
