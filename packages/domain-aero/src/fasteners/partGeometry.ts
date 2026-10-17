/**
 * Component geometry of standard parts (08 MAT FR-MAT-17, TECHNICAL_SPEC §5.4). Built from catalogue dimensions in the document's units;
 * a missing head/nut/washer dimension takes placeholder proportions (head Ø 2D, head h 0.5D) and flags the part `representative` (excluded
 * from mass). Local frame: +Z along the shank, head underside / washer lower face / nut lower face at z = 0.
 */

import {
  type CadDocument,
  type Component,
  type CylinderEntity,
  type Entity,
  type ExtrusionEntity,
  DEFAULT_LAYER_ID,
} from '@core/model/types';
import type { FastenerFamily, FastenerSize, PartRef } from '@core/model/fasteners';
import { nextId } from '@lib/id';
import { inchesToDoc, quantityToDoc } from './units';
import type { Resolved } from './selection';

export interface PartBuild {
  readonly component: Component;
  readonly representative: boolean;
}

const PART_COLOR = '#9aa3ad';
const HEX_SIDES = 6;

/** Component id of a standard part: one component per part number. */
export const componentIdOf = (partNumber: string): string => `std-${partNumber}`;

/** Nominal (else midpoint of min/max) dimension in document units, or null when the size does not list it. */
function dimensionDoc(doc: CadDocument, size: FastenerSize, name: string): number | null {
  const dimension = size.dims[name];
  if (dimension === undefined) return null;
  const value =
    dimension.nominal ??
    (dimension.min !== undefined && dimension.max !== undefined ? (dimension.min + dimension.max) / 2 : (dimension.max ?? dimension.min));
  return value === undefined ? null : quantityToDoc(doc, value, dimension.unit);
}

const diameterDoc = (doc: CadDocument, size: FastenerSize): number =>
  quantityToDoc(doc, size.nominalDiameter.value, size.nominalDiameter.unit) ?? 0;

const cylinder = (id: string, radius: number, height: number, centerZ: number): CylinderEntity => ({
  id,
  kind: 'cylinder',
  position: [0, 0, centerZ],
  rotation: [0, 0, 0],
  radius,
  height,
  layerId: DEFAULT_LAYER_ID,
  color: PART_COLOR,
});

function hexPrism(id: string, acrossFlats: number, height: number): ExtrusionEntity {
  const radius = acrossFlats / Math.sqrt(3);
  const profile = Array.from({ length: HEX_SIDES }, (_, k): [number, number] => [
    radius * Math.cos((k * 2 * Math.PI) / HEX_SIDES),
    radius * Math.sin((k * 2 * Math.PI) / HEX_SIDES),
  ]);
  return {
    id,
    kind: 'extrusion',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    profile,
    depth: height,
    layerId: DEFAULT_LAYER_ID,
    color: PART_COLOR,
  };
}

function component(id: string, name: string, entities: Entity[], partRef: PartRef): Component {
  return {
    id,
    name,
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    order: entities.map((entity) => entity.id),
    partRef,
  };
}

function massOf(size: FastenerSize): PartRef['unitMass'] | undefined {
  const mass = size.dims['mass'];
  const value = mass?.nominal ?? mass?.max;
  return mass === undefined || value === undefined ? undefined : { value, unit: mass.unit };
}

/** Bolt, Hi-Lok pin or rivet: shank below z = 0, head above. */
export function fastenerBody(doc: CadDocument, resolved: Resolved): PartBuild {
  const { family, size } = resolved;
  const diameter = diameterDoc(doc, size);
  const headDiameter = dimensionDoc(doc, size, 'headDiameter');
  const headHeight = dimensionDoc(doc, size, 'headHeight');
  const length = inchesToDoc(doc, resolved.lengthIn);
  const representative = headDiameter === null || headHeight === null || resolved.representativeLength;
  const head = cylinder(
    nextId('part'),
    (headDiameter ?? 2 * diameter) / 2,
    headHeight ?? 0.5 * diameter,
    -(headHeight ?? 0.5 * diameter) / 2,
  );
  const shank = cylinder(nextId('part'), diameter / 2, length, length / 2);
  const unitMass = massOf(size);
  const partRef: PartRef = {
    family: family.id,
    partNumber: resolved.partNumber,
    description: `${family.standard.id} ${family.kind} ${resolved.partNumber}`,
    ...(unitMass === undefined ? {} : { unitMass }),
    ...(representative ? { representative: true } : {}),
  };
  return { component: component(componentIdOf(resolved.partNumber), resolved.partNumber, [head, shank], partRef), representative };
}

/** Hex nut (across flats, height max) from the nut size; placeholders when unlisted. */
export function nutBody(doc: CadDocument, family: FastenerFamily, size: FastenerSize, partNumber: string): PartBuild {
  const diameter = diameterDoc(doc, size);
  const acrossFlats = dimensionDoc(doc, size, 'acrossFlats');
  const height = dimensionDoc(doc, size, 'height');
  const representative = acrossFlats === null || height === null;
  const entity = hexPrism(nextId('part'), acrossFlats ?? 1.6 * diameter, height ?? 0.8 * diameter);
  const unitMass = massOf(size);
  const partRef: PartRef = {
    family: family.id,
    partNumber,
    description: `${family.standard.id} nut ${partNumber}`,
    ...(unitMass === undefined ? {} : { unitMass }),
    ...(representative ? { representative: true } : {}),
  };
  return { component: component(componentIdOf(partNumber), partNumber, [entity], partRef), representative };
}

/** Washer disc of `thicknessIn`; outer diameter from the size (`od`) else 2 D, flagged representative. */
export function washerBody(
  doc: CadDocument,
  family: FastenerFamily,
  size: FastenerSize,
  partNumber: string,
  thicknessIn: number,
): PartBuild {
  const diameter = diameterDoc(doc, size);
  const outer = dimensionDoc(doc, size, 'od');
  const thickness = inchesToDoc(doc, thicknessIn);
  const representative = outer === null;
  const unitMass = massOf(size);
  const partRef: PartRef = {
    family: family.id,
    partNumber,
    description: `${family.standard.id} washer ${partNumber}`,
    ...(unitMass === undefined ? {} : { unitMass }),
    ...(representative ? { representative: true } : {}),
  };
  const disc = cylinder(nextId('part'), (outer ?? 2 * diameter) / 2, thickness, thickness / 2);
  return { component: component(componentIdOf(partNumber), partNumber, [disc], partRef), representative };
}
