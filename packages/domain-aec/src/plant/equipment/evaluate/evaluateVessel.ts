/**
 * Derived geometry of a parametric vessel (plant 03 EQP §2): the shell + heads wall section as ONE exact revolution (`curves`), skirt, base
 * ring, legs, saddle blocks, platform clips and nozzles, all tagged `element:<id>` (read-only under the building derivation guard,
 * re-derived on load). Trays are internals: data only, no geometry.
 */

import type { BoxEntity, Entity, RevolutionEntity, Vec3 } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { base, orientedBox } from '../../../building/evaluate/entities';
import { toWorld } from '../geometry/ports';
import { resolveVessel, skirtRadii, type VesselGeometry } from '../geometry/vesselFrame';
import { ringSection, vesselBand, type ProfileBand } from '../geometry/vesselProfile';
import type { PlatformClip, VesselTemplate } from '../plantData';
import { evaluateNozzles } from './evaluateNozzles';

const BODY_COLOR = '#c27c2c';
const SUPPORT_COLOR = '#7d8a96';
const REVOLUTION_SEGMENTS = 64;
/** Saddle block width across the vessel as a fraction of the outside diameter (the block rests under the shell, tangent at the bottom). */
const SADDLE_ACROSS = 0.8;

function revolution(
  element: EquipmentElement,
  part: { name: string; label: string },
  position: Vec3,
  rotation: Vec3,
  band: ProfileBand,
  axis: Vec3,
  angle = 2 * Math.PI,
): RevolutionEntity {
  return {
    ...base(element, { part: part.name, label: part.label }, position, rotation, BODY_COLOR),
    kind: 'revolution',
    profile: band.profile,
    axis,
    angle,
    segments: REVOLUTION_SEGMENTS,
    curves: band.curves,
  };
}

function box(element: EquipmentElement, level: BuildingLevel, part: string, label: string, local: Vec3, size: Vec3): BoxEntity {
  return orientedBox(element, { part, label }, toWorld(element, level, local), element.angle, size, SUPPORT_COLOR);
}

function verticalSupports(element: EquipmentElement, level: BuildingLevel, template: VesselTemplate, geometry: VesselGeometry): Entity[] {
  const { support } = template;
  const origin = toWorld(element, level, [0, 0, 0]);
  const rotation: Vec3 = [0, 0, element.angle];
  if (support.type === 'skirt') {
    const skirt = skirtRadii(geometry, support.thickness);
    const parts: Entity[] = [
      revolution(
        element,
        { name: 'skirt', label: `Skirt ${element.mark}` },
        origin,
        rotation,
        ringSection(skirt.inner, skirt.outer, 0, support.height),
        [0, 0, 1],
      ),
    ];
    if (support.baseRingWidth > 0)
      parts.push(
        revolution(
          element,
          { name: 'base-ring', label: `Base ring ${element.mark}` },
          origin,
          rotation,
          ringSection(skirt.inner, skirt.outer + support.baseRingWidth, 0, support.thickness),
          [0, 0, 1],
        ),
      );
    return parts;
  }
  if (support.type !== 'legs') return [];
  return Array.from({ length: support.count }, (_unused, index): Entity => {
    const azimuth = ((index + 0.5) * 2 * Math.PI) / support.count;
    const pitch = support.pitchDiameter / 2;
    return box(
      element,
      level,
      `leg-${index + 1}`,
      `Leg ${index + 1} ${element.mark}`,
      [pitch * Math.sin(azimuth), pitch * Math.cos(azimuth), support.height / 2],
      [support.legWidth, support.legWidth, support.height],
    );
  });
}

function saddleBlocks(element: EquipmentElement, level: BuildingLevel, template: VesselTemplate, geometry: VesselGeometry): Entity[] {
  const { support } = template;
  if (support.type !== 'saddles') return [];
  const outer = geometry.radius + geometry.shellThickness;
  const height = support.axisElevation - outer;
  if (height <= 0) return [];
  return support.stations.map((station, index) =>
    box(
      element,
      level,
      `saddle-${index + 1}`,
      `Saddle ${index + 1} ${element.mark}`,
      [-geometry.length / 2 + station, 0, height / 2],
      [support.width, 2 * outer * SADDLE_ACROSS, height],
    ),
  );
}

/** Platform clip: a partial ring on the shell, swept clockwise from `fromDeg` to `toDeg` (north_cw), starting on the +X side of its frame. */
function clipRing(element: EquipmentElement, level: BuildingLevel, geometry: VesselGeometry, clip: PlatformClip, index: number): Entity {
  const outer = geometry.radius + geometry.shellThickness;
  const sweep = (((clip.toDeg - clip.fromDeg) % 360) + 360) % 360;
  const start = Math.PI / 2 - (clip.toDeg * Math.PI) / 180;
  return revolution(
    element,
    { name: `clip-${index + 1}`, label: `Platform clip ${index + 1} ${element.mark}` },
    toWorld(element, level, [0, 0, geometry.datum + clip.elevation]),
    [0, 0, element.angle + start],
    ringSection(outer, outer + clip.depth, 0, clip.height),
    [0, 0, 1],
    (sweep * Math.PI) / 180,
  );
}

/** Entities of a parametric vessel element, nozzles included. */
export function evaluateVessel(element: EquipmentElement, level: BuildingLevel, template: VesselTemplate): Entity[] {
  const geometry = resolveVessel(template);
  if ('error' in geometry) return [];
  const rotation: Vec3 = [0, 0, element.angle];
  const vertical = template.orientation === 'vertical';
  const band = vesselBand(geometry, vertical ? geometry.datum : -geometry.length / 2);
  const body = revolution(
    element,
    { name: 'body', label: `${element.name} ${element.mark}` },
    toWorld(element, level, [0, 0, vertical ? 0 : geometry.datum]),
    rotation,
    band,
    vertical ? [0, 0, 1] : [1, 0, 0],
  );
  return [
    body,
    ...(vertical ? verticalSupports(element, level, template, geometry) : saddleBlocks(element, level, template, geometry)),
    ...(template.platformClips ?? []).map((clip, index) => clipRing(element, level, geometry, clip, index)),
    ...evaluateNozzles(element, level),
  ];
}
