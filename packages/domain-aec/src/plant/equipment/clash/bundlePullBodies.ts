/**
 * The tube-bundle pull zone of removable-bundle exchangers (plant 03 EQP-FU2) as a keep-clear body of `check_clashes`, registered through
 * `industrial/clash/clashSources`. The bundle is pulled out of the front (stationary) end along the tube axis: the zone starts at the outer face of
 * the front tubesheet (the channel and cover are taken off first) and runs `bundlePullLength` (tube length + 1 m, the named default of `add_heat_exchanger`)
 * outward, as wide and as high as the shell. Anything that is not the exchanger itself and enters the zone is a `clearance` clash named by the exchanger.
 * @invariant pure, deterministic (element order); fixed-tubesheet exchangers (rear L, M, N) have no zone; units are the document units
 */

import type { CadDocument } from '@core/model/types';
import { elementsOf, getBuilding } from '../../../building/model';
import type { ExternalBody } from '../../../industrial/clash/clashSources';
import { bundlePullLength } from '../commands/exchangerParams';
import { resolveExchanger } from '../geometry/exchangerFrame';
import { directionToWorld, toWorld } from '../geometry/ports';

export function bundlePullBodies(doc: CadDocument): ExternalBody[] {
  const building = getBuilding(doc);
  return elementsOf(building, 'equipment').flatMap((element): ExternalBody[] => {
    const template = element.plant?.template;
    const level = building.levels[element.levelId];
    if (template?.kind !== 'exchanger' || level === undefined) return [];
    const pull = bundlePullLength(template, doc.units);
    if (pull === null) return [];
    const geometry = resolveExchanger(template);
    const face = geometry.front.tubesheetFrom;
    return [
      {
        id: element.id,
        kind: 'clearance',
        box: {
          center: toWorld(element, level, [face - pull / 2, 0, geometry.datum]),
          axes: [directionToWorld(element, [1, 0, 0]), directionToWorld(element, [0, 1, 0]), [0, 0, 1]],
          half: [pull / 2, geometry.outerRadius, geometry.outerRadius],
        },
        group: element.id,
        connectedTo: [element.id],
      },
    ];
  });
}
