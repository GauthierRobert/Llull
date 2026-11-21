/**
 * Derived geometry of a parametric shell-and-tube exchanger (plant 03 EQP §2): shell, channels, tubesheets, bonnets / shell cover (exact head
 * sections), flat covers, saddle blocks and nozzles, all tagged `element:<id>`. The tube bundle, baffles and pass partitions are internals: data
 * only, no geometry.
 */

import type { Entity, Vec3 } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import type { ExchangerEnd, ExchangerGeometry } from '../geometry/exchangerFrame';
import { resolveExchanger } from '../geometry/exchangerFrame';
import type { ShellSegment } from '../geometry/exchangerShell';
import { toWorld } from '../geometry/ports';
import { headBand, ringSection } from '../geometry/vesselProfile';
import type { ExchangerTemplate } from '../plantData';
import { evaluateNozzles } from './evaluateNozzles';
import { polygonSection, revolutionPart, supportBox, type Section } from './revolutionPart';

/** Saddle block width across the shell as a fraction of the outside diameter (same as vessel saddles). */
const SADDLE_ACROSS = 0.8;

function endParts(
  make: (name: string, label: string, section: Section) => Entity,
  geometry: ExchangerGeometry,
  end: ExchangerEnd,
  side: 'front' | 'rear',
): Entity[] {
  const { shellThickness } = geometry;
  const radius = end.radius;
  const name = (part: string): string => `${side}-${part}`;
  const parts: Entity[] = [];
  if (end.hasTubesheet) {
    parts.push(
      make(name('tubesheet'), `Tubesheet (${side})`, ringSection(0, geometry.radius + shellThickness, end.tubesheetFrom, end.tubesheetTo)),
      make(name('channel'), `Channel (${side})`, ringSection(radius, radius + end.channelThickness, end.channelFrom, end.channelTo)),
    );
  }
  if (end.closure === 'flat') {
    const to = end.tangent + end.sign * end.coverThickness;
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

const segmentLabel = (segment: ShellSegment): string =>
  segment.name === 'shell' ? 'Shell' : segment.name === 'kettleShell' ? 'Kettle shell' : 'Kettle transition';

/** Wall section of a shell segment: a ring for a cylinder, a quadrilateral for the kettle cone. */
function segmentSection(segment: ShellSegment): Section {
  if (segment.rFrom === segment.rTo) return ringSection(segment.rFrom, segment.rFrom + segment.thickness, segment.from, segment.to);
  return polygonSection([
    [segment.rFrom, segment.from],
    [segment.rTo, segment.to],
    [segment.rTo + segment.thickness, segment.to],
    [segment.rFrom + segment.thickness, segment.from],
  ]);
}

function saddleBlocks(element: EquipmentElement, level: BuildingLevel, template: ExchangerTemplate, geometry: ExchangerGeometry): Entity[] {
  const { support } = template;
  const saddleHeight = support.type === 'saddles' ? support.axisElevation - geometry.outerRadius : 0;
  if (support.type !== 'saddles' || saddleHeight <= 0) return [];
  return support.stations.map((station, index) =>
    supportBox(
      element,
      level,
      `saddle-${index + 1}`,
      `Saddle ${index + 1} ${element.mark}`,
      [geometry.shellFrom + station, 0, saddleHeight / 2],
      [support.width, 2 * geometry.outerRadius * SADDLE_ACROSS, saddleHeight],
    ),
  );
}

/** Skirt (ring from the level to the bottom tangent line, inside radius = the largest outside radius) with its base ring, or square legs on the pitch circle. */
function verticalSupports(
  element: EquipmentElement,
  level: BuildingLevel,
  template: ExchangerTemplate,
  geometry: ExchangerGeometry,
): Entity[] {
  const { support } = template;
  const rotation: Vec3 = [0, 0, element.angle];
  const origin = toWorld(element, level, [0, 0, 0]);
  if (support.type === 'skirt') {
    const inner = geometry.outerRadius;
    const outer = inner + support.thickness;
    const parts: Entity[] = [
      revolutionPart(
        element,
        { name: 'skirt', label: `Skirt ${element.mark}` },
        origin,
        rotation,
        ringSection(inner, outer, 0, support.height),
        [0, 0, 1],
      ),
    ];
    if (support.baseRingWidth > 0)
      parts.push(
        revolutionPart(
          element,
          { name: 'base-ring', label: `Base ring ${element.mark}` },
          origin,
          rotation,
          ringSection(outer, outer + support.baseRingWidth, 0, support.thickness),
          [0, 0, 1],
        ),
      );
    return parts;
  }
  if (support.type !== 'legs') return [];
  return Array.from({ length: support.count }, (_unused, index): Entity => {
    const azimuth = ((index + 0.5) * 2 * Math.PI) / support.count;
    const pitch = support.pitchDiameter / 2;
    return supportBox(
      element,
      level,
      `leg-${index + 1}`,
      `Leg ${index + 1} ${element.mark}`,
      [pitch * Math.sin(azimuth), pitch * Math.cos(azimuth), support.height / 2],
      [support.legWidth, support.legWidth, support.height],
    );
  });
}

/** Entities of a parametric exchanger element, nozzles included. */
export function evaluateExchanger(element: EquipmentElement, level: BuildingLevel, template: ExchangerTemplate): Entity[] {
  const geometry = resolveExchanger(template);
  const origin = toWorld(element, level, [0, 0, geometry.vertical ? geometry.zOffset : geometry.datum]);
  const rotation: Vec3 = [0, 0, element.angle];
  const axis: Vec3 = geometry.vertical ? [0, 0, 1] : [1, 0, 0];
  const make = (name: string, label: string, section: Section): Entity =>
    revolutionPart(element, { name, label: `${label} ${element.mark}` }, origin, rotation, section, axis);
  return [
    ...geometry.segments.map((segment) => make(segment.name, segmentLabel(segment), segmentSection(segment))),
    ...endParts(make, geometry, geometry.front, 'front'),
    ...endParts(make, geometry, geometry.rear, 'rear'),
    ...(geometry.vertical ? verticalSupports(element, level, template, geometry) : saddleBlocks(element, level, template, geometry)),
    ...evaluateNozzles(element, level),
  ];
}
