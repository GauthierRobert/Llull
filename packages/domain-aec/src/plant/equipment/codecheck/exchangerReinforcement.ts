/**
 * UG-37 opening reinforcement of the shell and channel nozzles of an exchanger (plant 03 EQP-FU2). Each nozzle is judged as a nozzle in the wall of an
 * equivalent horizontal vessel (the shell against `design.shellSide`, a channel against `design.tubeSide`, the channel thickness for a channel), so the
 * area replacement is `vesselReinforcement` unchanged. Pure. Bonnets, flat covers, tubesheets and free nozzles are not covered.
 */

import type { ExchangerSideDesign, ExchangerTemplate, NozzleRecord, PlantEquipmentData, VesselTemplate } from '../plantData';
import { PLANT_EQUIPMENT_SCHEMA } from '../plantData';
import { vesselReinforcement, type NozzleReinforcement, type ReinforcementOptions } from './reinforcement';

export interface SideBasis {
  readonly pressureMPa: number;
  readonly stressMPa: number;
}

export interface ExchangerReinforcement {
  readonly nozzles: readonly NozzleReinforcement[];
  /** The design basis each side was judged with (absent when that side had no usable design data). */
  readonly sides: { readonly shellSide?: SideBasis; readonly tubeSide?: SideBasis };
}

const notCovered = (nozzle: NozzleRecord, code: string, message: string, path: string): NozzleReinforcement => ({
  mark: nozzle.mark,
  refusal: { code, message: `nozzle ${nozzle.mark}: ${message}`, paths: [path] },
});

/** The nozzle as a shell nozzle of the equivalent vessel (its station and angle do not enter UG-37 for a cylinder). */
const asShellNozzle = (nozzle: NozzleRecord): NozzleRecord => ({ ...nozzle, location: { on: 'shell', station: 0, orientationDeg: 0 } });

function equivalentVessel(
  template: ExchangerTemplate,
  thickness: number,
  side: ExchangerSideDesign | undefined,
  nozzle: NozzleRecord,
): PlantEquipmentData {
  const head = { type: 'ellipsoidal', ratio: 2 } as const;
  const vessel: VesselTemplate = {
    kind: 'vessel',
    orientation: 'horizontal',
    insideDiameter: template.shellInsideDiameter,
    tangentLength: template.shellInsideDiameter,
    heads: { first: head, second: head },
    shellThickness: thickness,
    headThickness: thickness,
    corrosionAllowance: template.corrosionAllowance,
    support: { type: 'none', baseElevation: 0 },
  };
  const design = side === undefined ? undefined : (({ specificGravity: _gravity, ...rest }) => rest)(side);
  return {
    schema: PLANT_EQUIPMENT_SCHEMA,
    template: vessel,
    nozzles: [asShellNozzle(nozzle)],
    ...(design === undefined ? {} : { design }),
  };
}

/**
 * UG-37 result of every shell and channel nozzle of an exchanger; a nozzle that cannot be judged refuses only itself.
 * @invariant a shell nozzle is judged with design.shellSide and the shell wall, a channel nozzle with design.tubeSide and the channel wall (corrosion allowance shared)
 * @failure no pressure / allowable stress on the side -> EQP_DESIGN_DATA_MISSING / EQP_ALLOWABLE_MISSING for that side's nozzles; free nozzle -> EQP_PARAM_INVALID
 */
export function exchangerReinforcement(
  template: ExchangerTemplate,
  nozzles: readonly NozzleRecord[],
  options: ReinforcementOptions,
): ExchangerReinforcement {
  const sides: { shellSide?: SideBasis; tubeSide?: SideBasis } = {};
  const results = nozzles.map((nozzle): NozzleReinforcement => {
    const { location } = nozzle;
    if (location.on !== 'shell' && location.on !== 'channel')
      return notCovered(
        nozzle,
        'EQP_PARAM_INVALID',
        'only shell and channel nozzles are checked (bonnets and covers are not covered)',
        `nozzles.${nozzle.mark}.location.on`,
      );
    if (location.on === 'channel' && location.channel === 'rear' && template.rearChannel === undefined)
      return notCovered(
        nozzle,
        'EQP_PARAM_INVALID',
        'the exchanger has no rear channel (rearChannel is undefined)',
        `nozzles.${nozzle.mark}.location.channel`,
      );
    const sideName = location.on === 'shell' ? 'shellSide' : 'tubeSide';
    const thickness =
      location.on === 'shell'
        ? template.shellThickness
        : location.channel === 'front'
          ? template.frontChannel.thickness
          : (template.rearChannel?.thickness ?? template.shellThickness);
    const run = vesselReinforcement(equivalentVessel(template, thickness, template.design?.[sideName], nozzle), options);
    if ('refusal' in run)
      return notCovered(
        nozzle,
        run.refusal.code,
        run.refusal.message,
        run.refusal.paths[0]?.replace(/^design\./, `design.${sideName}.`) ?? `design.${sideName}`,
      );
    sides[sideName] = { pressureMPa: run.pressureMPa, stressMPa: run.stressMPa };
    const only = run.nozzles[0];
    if (only === undefined) return notCovered(nozzle, 'EQP_PARAM_INVALID', 'no result', `nozzles.${nozzle.mark}`);
    if ('refusal' in only) return only;
    return { mark: only.mark, result: { ...only.result, on: location.on, inputs: { ...only.result.inputs, side: sideName } } };
  });
  return { nozzles: results, sides };
}
