/**
 * @layer domain-aec
 */

import type { BuildingElement, BuildingLevel, SlabElement } from '@core/model/building';
import { wallFrame } from './wallGeometry';
import {
  type Context,
  extrusion,
  ifcString,
  placement,
  circleProfile,
  scaledPolygonProfile,
  rectangleProfile,
  shape,
} from './ifcStep';
import type { Exported } from './ifcElementExport';

const SLAB_TYPE: Readonly<Record<SlabElement['role'], string>> = {
  floor: '.FLOOR.',
  roof: '.ROOF.',
  foundation: '.BASESLAB.',
};

export function exportOther(
  context: Context,
  element: Extract<BuildingElement, { category: 'slab' | 'column' | 'beam' | 'stair' | 'room' }>,
  level: BuildingLevel,
  storeyPlacement: string,
): Exported {
  const { mm, writer } = context;
  const guid = context.guid(element.id);
  switch (element.category) {
    case 'slab': {
      const local = placement(
        context,
        storeyPlacement,
        0,
        0,
        mm(element.offset - element.thickness),
      );
      const profile = scaledPolygonProfile(context, element.boundary);
      const ref = writer.add(
        `IFCSLAB('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(element.thickness))])},${ifcString(element.id)},${SLAB_TYPE[element.role]})`,
      );
      (element.openings ?? []).forEach((opening, index) => {
        const voidProfile = scaledPolygonProfile(context, opening);
        const voidRef = writer.add(
          `IFCOPENINGELEMENT('${context.guid(`${element.id}:void-${index}`)}',$,${ifcString(`${element.mark} opening ${index + 1}`)},$,$,${placement(context, local, 0, 0, 0)},${shape(context, [extrusion(context, voidProfile, mm(element.thickness) + 20, 0, 0, -10)])},$,.OPENING.)`,
        );
        writer.add(
          `IFCRELVOIDSELEMENT('${context.guid(`${element.id}:voids-${index}`)}',$,$,$,${ref},${voidRef})`,
        );
      });
      return { ref, material: element.material };
    }
    case 'column': {
      const local = placement(
        context,
        storeyPlacement,
        mm(element.location[0]),
        mm(element.location[1]),
        0,
      );
      const profile =
        element.shape === 'circular'
          ? circleProfile(context, mm(element.width) / 2)
          : rectangleProfile(context, [0, 0], mm(element.width), mm(element.depth));
      const ref = writer.add(
        `IFCCOLUMN('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(element.height))])},${ifcString(element.id)},.COLUMN.)`,
      );
      return { ref, material: element.material };
    }
    case 'beam': {
      const frame = wallFrame(element);
      const top = level.height + element.topOffset;
      const local = placement(
        context,
        storeyPlacement,
        mm(element.start[0]),
        mm(element.start[1]),
        mm(top - element.depth),
        frame.angle,
      );
      const profile = rectangleProfile(
        context,
        [mm(frame.length) / 2, 0],
        mm(frame.length),
        mm(element.width),
      );
      const ref = writer.add(
        `IFCBEAM('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(element.depth))])},${ifcString(element.id)},.BEAM.)`,
      );
      return { ref, material: element.material };
    }
    case 'stair': {
      const local = placement(
        context,
        storeyPlacement,
        mm(element.start[0]),
        mm(element.start[1]),
        0,
        element.angle,
      );
      const steps: string[] = [];
      for (let index = 0; index < element.riserCount; index++) {
        const profile = rectangleProfile(
          context,
          [mm((index + 0.5) * element.treadDepth), 0],
          mm(element.treadDepth),
          mm(element.width),
        );
        steps.push(extrusion(context, profile, mm((index + 1) * element.riserHeight)));
      }
      const ref = writer.add(
        `IFCSTAIR('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, steps)},${ifcString(element.id)},.STRAIGHT_RUN_STAIR.)`,
      );
      return { ref, material: element.material };
    }
    case 'room': {
      const local = placement(context, storeyPlacement, 0, 0, 0);
      const profile = scaledPolygonProfile(context, element.boundary);
      const ref = writer.add(
        `IFCSPACE('${guid}',$,${ifcString(element.mark)},$,$,${local},${shape(context, [extrusion(context, profile, mm(level.height))])},${ifcString(element.name)},.ELEMENT.,.INTERNAL.,$)`,
      );
      return { ref, material: null };
    }
  }
}
