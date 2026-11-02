/**
 * Mapping table P&ID DEXPI class <-> 3D class (P3D_CLASS_MISMATCH). Inline items: the DEXPI piping-component class against the 01 PSC catalogue
 * component type of the 02 RTE inline component. Equipment: the DEXPI equipment class against what the 03 EQP template can stand for.
 * A class with no row is not compared (coded skip), never silently accepted.
 */

import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import type { ComponentType } from '@aec/plant/catalog/types';

const VALVES: readonly ComponentType[] = ['valveGate', 'valveGlobe', 'valveCheck', 'valveBall', 'valveButterfly', 'valvePlug'];

/** DEXPI piping class -> the catalogue component types it may be placed as. Classes the catalogue has no component for (needle, diaphragm and safety valves, tees, flanges, orifices) have no row. */
const INLINE_CLASSES: ReadonlyMap<string, readonly ComponentType[]> = new Map([
  ['GateValve', ['valveGate']],
  ['GlobeValve', ['valveGlobe']],
  ['SwingCheckValve', ['valveCheck']],
  ['BallValve', ['valveBall']],
  ['ButterflyValve', ['valveButterfly']],
  ['PlugValve', ['valvePlug']],
  ['OperatedValve', VALVES],
  ['PipeReducer', ['reducerConcentric', 'reducerEccentric']],
]);

/** The 3D types a P&ID inline class can be, or undefined when the class has no row. */
export const inlineTypesFor = (dexpiClass: string): readonly string[] | undefined => INLINE_CLASSES.get(dexpiClass);

/** DEXPI equipment classes a 03 EQP vessel template can stand for, by orientation (a tubular exchanger shell is a horizontal vessel). */
const VESSEL_CLASSES: Readonly<Record<'vertical' | 'horizontal', ReadonlySet<string>>> = {
  vertical: new Set(['PressureVessel', 'Tank', 'ProcessColumn', 'ColumnSection']),
  horizontal: new Set(['PressureVessel', 'Tank', 'TubularHeatExchanger']),
};

/** Classes the 3D equipment can be; undefined when it carries no kind (a legacy `add_equipment` box or a nozzle-only block). */
export function equipmentClassesOf(element: EquipmentElement): ReadonlySet<string> | undefined {
  const template = element.plant?.template;
  return template?.kind === 'vessel' ? VESSEL_CLASSES[template.orientation] : undefined;
}

export const equipmentOf = (building: BuildingModel, id: string): EquipmentElement | undefined => {
  const element = Object.hasOwn(building.elements, id) ? building.elements[id] : undefined;
  return element?.category === 'equipment' ? element : undefined;
};
