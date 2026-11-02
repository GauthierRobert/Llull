/**
 * Derived geometry of a parametric shell-and-tube exchanger (plant 03 EQP §2): shell, channels, tubesheets, bonnets / shell cover (exact head
 * sections), flat covers, saddle blocks and nozzles, all tagged `element:<id>`. The tube bundle, baffles and pass partitions are internals: data
 * only, no geometry.
 */

import type { Entity, Vec3 } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import type { ExchangerEnd, ExchangerGeometry } from '../geometry/exchangerFrame';
import { resolveExchanger } from '../geometry/exchangerFrame';
import { toWorld } from '../geometry/ports';
import { headBand, ringSection } from '../geometry/vesselProfile';
import type { ExchangerTemplate } from '../plantData';
import { evaluateNozzles } from './evaluateNozzles';
import { revolutionPart, supportBox } from './revolutionPart';

/** Saddle block width across the shell as a fraction of the outside diameter (same as vessel saddles). */
const SADDLE_ACROSS = 0.8;

function endParts(
  make: (name: string, label: string, section: ReturnType<typeof ringSection>) => Entity,
  geometry: ExchangerGeometry,
  end: ExchangerEnd,
  side: 'front' | 'rear',
): Entity[] {
  const { radius, shellThickness } = geometry;
  const name = (part: string): string => `${side}-${part}`;
  const parts: Entity[] = [];
  if (end.hasTubesheet) {
    parts.push(
      make(name('tubesheet'), `Tubesheet (${side})`, ringSection(0, radius + shellThickness, end.tubesheetFrom, end.tubesheetTo)),
      make(name('channel'), `Channel (${side})`, ringSection(radius, radius + end.channelThickness, end.channelFrom, end.channelTo)),
    );
  }
  if (end.closure === 'flat') {
    const to = end.tangent + end.sign * end.channelThickness;
    parts.push(
      make(
        name('cover'),
        `Cover (${side})`,
        ringSection(0, radius + end.channelThickness, Math.min(end.tangent, to), Math.max(end.tangent, to)),
      ),
    );
  } else {
    parts.push(
      make(
        name(end.closure === 'bonnet' ? 'bonnet' : 'shell-cover'),
        end.closure === 'bonnet' ? `Bonnet (${side})` : `Shell cover (${side})`,
        headBand(end.head, radius, end.channelThickness, end.tangent, end.sign),
      ),
    );
  }
  return parts;
}

/** Entities of a parametric exchanger element, nozzles included. */
export function evaluateExchanger(element: EquipmentElement, level: BuildingLevel, template: ExchangerTemplate): Entity[] {
  const geometry = resolveExchanger(template);
  const origin = toWorld(element, level, [0, 0, geometry.datum]);
  const rotation: Vec3 = [0, 0, element.angle];
  const make = (name: string, label: string, section: ReturnType<typeof ringSection>): Entity =>
    revolutionPart(element, { name, label: `${label} ${element.mark}` }, origin, rotation, section, [1, 0, 0]);
  const { support } = template;
  const saddleHeight = support.type === 'saddles' ? support.axisElevation - geometry.outerRadius : 0;
  const saddles =
    support.type === 'saddles' && saddleHeight > 0
      ? support.stations.map((station, index) =>
          supportBox(
            element,
            level,
            `saddle-${index + 1}`,
            `Saddle ${index + 1} ${element.mark}`,
            [geometry.shellFrom + station, 0, saddleHeight / 2],
            [support.width, 2 * geometry.outerRadius * SADDLE_ACROSS, saddleHeight],
          ),
        )
      : [];
  return [
    make('shell', 'Shell', ringSection(geometry.radius, geometry.radius + geometry.shellThickness, geometry.shellFrom, geometry.shellTo)),
    ...endParts(make, geometry, geometry.front, 'front'),
    ...endParts(make, geometry, geometry.rear, 'rear'),
    ...saddles,
    ...evaluateNozzles(element, level),
  ];
}
