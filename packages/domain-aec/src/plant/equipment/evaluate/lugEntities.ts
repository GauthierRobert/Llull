/** Derived meshes of bracket lugs (vessel and exchanger): per lug a base plate and a web plate, boxes in the equipment frame at the lug azimuth. */

import type { BoxEntity } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { orientedBox } from '../../../building/evaluate/entities';
import { lugAzimuth } from '../geometry/lugs';
import { toWorld } from '../geometry/ports';
import type { LugSupport } from '../plantData';
import { SUPPORT_COLOR } from './revolutionPart';

/**
 * @param rootRadius shell outside radius at the lugs
 * @param datum elevation of the bottom tangent line in the equipment frame
 * @invariant 2 boxes per lug (`lug-<i>-base`, `lug-<i>-web`), radial axis = box X, outer end at rootRadius + lugProjection
 */
export function lugEntities(
  element: EquipmentElement,
  level: BuildingLevel,
  lug: LugSupport,
  rootRadius: number,
  datum: number,
): BoxEntity[] {
  const bottom = datum + lug.lugElevation;
  const plate = lug.lugBasePlateThickness;
  const radial = rootRadius + lug.lugProjection / 2;
  return Array.from({ length: lug.count }, (_unused, index): BoxEntity[] => {
    const azimuth = lugAzimuth(index, lug.count);
    const angle = element.angle + Math.PI / 2 - azimuth;
    const box = (part: string, label: string, height: number, z: number, width: number): BoxEntity =>
      orientedBox(
        element,
        { part: `lug-${index + 1}-${part}`, label: `${label} ${index + 1} ${element.mark}` },
        toWorld(element, level, [radial * Math.sin(azimuth), radial * Math.cos(azimuth), z]),
        angle,
        [lug.lugProjection, width, height],
        SUPPORT_COLOR,
      );
    return [
      box('base', 'Lug base plate', plate, bottom + plate / 2, lug.lugWidth),
      box('web', 'Lug web', lug.lugHeight - plate, bottom + plate + (lug.lugHeight - plate) / 2, lug.lugThickness),
    ];
  }).flat();
}
