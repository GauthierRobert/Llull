/**
 * add_bearing: rolling bearing (inner ring, outer ring, rolling elements) grouped under one name.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, EntityGroup, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z, looseVec3 as vec3, colorField } from '../schema';
import { nextId } from '../../lib/id';
import { MM_PER_UNIT } from '../../model/units';
import { ORIGIN } from '../../lib/vec3';
import {
  applyMat3,
  eulerFromAxis,
  eulerFromMat,
  matFromAxis,
  unitAxisOrNull,
} from '../../lib/axisRotation';
import { compactNumber as fmt, vecText } from '../../lib/compactNumber';
import { withEntity } from '../entity/entityOps';
import { positionField } from './shared';
import { newEntity } from '../entity/newEntity';
import { noop } from '../noop';
import { BEARING_TABLE, BEARING_TYPES, lookupBearing, type BearingType } from './bearingTable';
import { toRadians } from '../../lib/angle';

const TAPER_ANGLE = toRadians(12);
const MAX_ROLLING_ELEMENTS = 40;
const ROLLING_COLOR = '#8c93a0';

type Profile = Array<readonly [number, number]>;

interface Section {
  readonly bore: number;
  readonly outerDiameter: number;
  readonly width: number;
  readonly type: BearingType;
}

interface Layout {
  readonly inner: Profile;
  readonly outer: Profile;
  readonly count: number;
  readonly pitchRadius: number;
  readonly elementRadius: number;
  readonly elementLength: number;
  readonly tilt: number;
}

/** Ring cross-sections (radial, axial) and rolling-element sizing in the bearing's local frame (axis +Z, centered). */
function layoutOf({ bore, outerDiameter, width, type }: Section): Layout {
  const pitchRadius = (outerDiameter + bore) / 4;
  const h = width / 2;
  const isBall = type === 'deep_groove_ball';
  const tilt = type === 'tapered_roller' ? TAPER_ANGLE : 0;
  const elementDiameter = Math.min(
    isBall ? 0.32 * (outerDiameter - bore) : 0.28 * (outerDiameter - bore),
    0.6 * width,
  );
  const elementRadius = elementDiameter / 2;
  const count = Math.max(
    6,
    Math.min(
      MAX_ROLLING_ELEMENTS,
      Math.floor((2 * Math.PI * pitchRadius) / (elementDiameter * 1.3)),
    ),
  );
  if (isBall) {
    const lip = 0.8 * elementRadius;
    const ri = pitchRadius - 0.6 * elementRadius;
    const ro = pitchRadius + 0.6 * elementRadius;
    return {
      inner: [
        [bore / 2, -h],
        [ri, -h],
        [ri, -lip],
        [pitchRadius - elementRadius, 0],
        [ri, lip],
        [ri, h],
        [bore / 2, h],
      ],
      outer: [
        [ro, -h],
        [outerDiameter / 2, -h],
        [outerDiameter / 2, h],
        [ro, h],
        [ro, lip],
        [pitchRadius + elementRadius, 0],
        [ro, -lip],
      ],
      count,
      pitchRadius,
      elementRadius,
      elementLength: 0,
      tilt,
    };
  }
  const slope = Math.tan(tilt);
  const half = elementRadius / Math.cos(tilt);
  const rIn = (z: number): number => pitchRadius - z * slope - half;
  const rOut = (z: number): number => pitchRadius - z * slope + half;
  return {
    inner: [
      [bore / 2, -h],
      [rIn(-h), -h],
      [rIn(h), h],
      [bore / 2, h],
    ],
    outer: [
      [rOut(-h), -h],
      [outerDiameter / 2, -h],
      [outerDiameter / 2, h],
      [rOut(h), h],
    ],
    count,
    pitchRadius,
    elementRadius,
    elementLength: (0.7 * width) / Math.cos(tilt),
    tilt,
  };
}

type Resolution =
  | { readonly section: Section; readonly designation?: string }
  | { readonly error: string };

function resolveSection(
  doc: CadDocument,
  p: {
    type?: BearingType | undefined;
    designation?: string | undefined;
    bore?: number | undefined;
    outerDiameter?: number | undefined;
    width?: number | undefined;
  },
): Resolution {
  if (p.designation !== undefined) {
    const entry = lookupBearing(p.designation);
    if (!entry) {
      return {
        error: `unknown designation "${p.designation}"; known: ${[...BEARING_TABLE.keys()].join(', ')}. Pass bore, outerDiameter and width instead`,
      };
    }
    if (p.type !== undefined && p.type !== entry.type) {
      return { error: `designation ${p.designation} is a ${entry.type} bearing, not ${p.type}` };
    }
    const f = 1 / (MM_PER_UNIT[doc.units] ?? 1);
    return {
      designation: p.designation.trim().toUpperCase(),
      section: {
        type: entry.type,
        bore: entry.bore * f,
        outerDiameter: entry.outerDiameter * f,
        width: entry.width * f,
      },
    };
  }
  const { bore, outerDiameter, width } = p;
  if (bore === undefined || outerDiameter === undefined || width === undefined) {
    return { error: 'give a designation, or all of bore, outerDiameter and width' };
  }
  if (![bore, outerDiameter, width].every((v) => Number.isFinite(v) && v > 0)) {
    return {
      error: `bore, outerDiameter and width must be finite and > 0, got ${bore}, ${outerDiameter}, ${width}`,
    };
  }
  if (outerDiameter - bore < 0.2 * outerDiameter) {
    return {
      error: `outerDiameter ${outerDiameter} must exceed bore ${bore} by at least 20% of outerDiameter`,
    };
  }
  return { section: { type: p.type ?? 'deep_groove_ball', bore, outerDiameter, width } };
}

/**
 * @command add_bearing
 * @pure
 * @layer core/commands
 * @affects creates 2 revolution rings + N rolling elements (sphere/cylinder) and 1 group
 * @invariant bore < outerDiameter; rolling elements sit between the raceways; affected = member ids then group id
 * @failure unknown designation, type mismatch, bad dimensions or zero axis -> no-op, affected:[]
 */
export const addBearing = defineCommand({
  name: 'add_bearing',
  description:
    'Create a simplified rolling bearing: an inner ring and an outer ring (revolved raceway sections) plus a ring of rolling ' +
    'elements (balls for deep_groove_ball; straight rollers for spherical_roller / cylindrical_roller; rollers tilted 12 degrees ' +
    'for tapered_roller), all grouped under one named group (group_entities semantics). ' +
    'Size it with designation (ISO 15 boundary dimensions in MILLIMETRES, converted to the document units; case/space-insensitive, ' +
    'a suffix after "-" is ignored; known: 60xx/62xx/63xx deep groove e.g. "6205", 222xx spherical roller e.g. "22220", 302xx tapered roller e.g. "30210", ' +
    'NU2xx/NU3xx cylindrical roller e.g. "NU210") OR explicit bore, outerDiameter, width in document units (type then defaults to deep_groove_ball). ' +
    'An unknown designation, or a type that contradicts the designation, is rejected. ' +
    'The bearing is centered on position with its rotation axis along axis (default +Z). ' +
    'Returns affected = [inner ring, outer ring, ...rolling elements, group id] and data {groupId, innerRingId, outerRingId, ' +
    'rollingElementIds, type, bore, outerDiameter, width, designation?}.',
  params: z.object({
    type: z
      .enum(BEARING_TYPES)
      .describe(
        'Bearing type. Optional when designation is given (inferred); must match it if both are given.',
      )
      .optional(),
    designation: z
      .string()
      .describe(
        'Bearing designation, e.g. "6205", "22220", "30210", "NU210". Dimensions in mm, scaled to document units.',
      )
      .optional(),
    bore: z
      .number()
      .describe(
        'Bore (inner diameter) in document units. Needed with outerDiameter and width when no designation.',
      )
      .optional(),
    outerDiameter: z
      .number()
      .describe('Outer diameter in document units. Must exceed bore by >= 20% of itself.')
      .optional(),
    width: z.number().describe('Bearing width along the axis in document units.').optional(),
    position: positionField('Center of the bearing (mid-width on its axis). '),
    axis: vec3(
      'Rotation axis direction [dx, dy, dz] (non-zero, normalized) of the bearing. Defaults to [0, 0, 1].',
    ).optional(),
    color: colorField('#b0b6bf'),
    name: z
      .string()
      .describe('Optional group name. Defaults to "Bearing <designation|type>".')
      .optional(),
  }),
  run: (
    doc,
    {
      type,
      designation,
      bore,
      outerDiameter,
      width,
      position = ORIGIN,
      axis,
      color = '#b0b6bf',
      name,
    },
  ): CommandResult => {
    const fail = (reason: string): CommandResult =>
      noop(doc, `add_bearing failed: ${reason}; no-op.`);
    const resolved = resolveSection(doc, { type, designation, bore, outerDiameter, width });
    if ('error' in resolved) return fail(resolved.error);
    const unitAxis = axis === undefined ? ([0, 0, 1] as Vec3) : unitAxisOrNull(axis);
    if (!unitAxis) return fail('axis must be 3 finite numbers with non-zero length');
    if (position.length !== 3 || !position.every(Number.isFinite)) {
      return fail('position must be 3 finite numbers');
    }

    const { section } = resolved;
    const layout = layoutOf(section);
    const matrix = matFromAxis(unitAxis);
    const worldAt = (local: Vec3): Vec3 => {
      const [x, y, z] = applyMat3(matrix, local);
      return [position[0] + x, position[1] + y, position[2] + z];
    };
    const ringRotation = eulerFromMat(matrix);
    const label = resolved.designation ?? section.type;
    const members: Entity[] = [];
    const ring = (prefix: string, profile: Profile, role: string): void => {
      members.push(
        newEntity(
          'revolution',
          nextId(prefix),
          { profile, axis: [0, 0, 1], angle: 2 * Math.PI, segments: 48 },
          position,
          color,
          { rotation: ringRotation, name: `${label} ${role}` },
        ),
      );
    };
    ring('brg-in', layout.inner, 'inner ring');
    ring('brg-out', layout.outer, 'outer ring');
    for (let i = 0; i < layout.count; i++) {
      const phi = (2 * Math.PI * i) / layout.count;
      const centerLocal: Vec3 = [
        layout.pitchRadius * Math.cos(phi),
        layout.pitchRadius * Math.sin(phi),
        0,
      ];
      const elementName = `${label} rolling element ${i + 1}`;
      if (section.type === 'deep_groove_ball') {
        members.push(
          newEntity(
            'sphere',
            nextId('brg-el'),
            { radius: layout.elementRadius },
            worldAt(centerLocal),
            ROLLING_COLOR,
            { name: elementName },
          ),
        );
        continue;
      }
      const dirLocal: Vec3 = [
        -Math.sin(layout.tilt) * Math.cos(phi),
        -Math.sin(layout.tilt) * Math.sin(phi),
        Math.cos(layout.tilt),
      ];
      members.push(
        newEntity(
          'cylinder',
          nextId('brg-el'),
          { radius: layout.elementRadius, height: layout.elementLength },
          worldAt(centerLocal),
          ROLLING_COLOR,
          { rotation: eulerFromAxis(applyMat3(matrix, dirLocal)) ?? [0, 0, 0], name: elementName },
        ),
      );
    }

    const groupId = nextId('group');
    const memberIds = members.map((m) => m.id);
    const group: EntityGroup = { id: groupId, name: name ?? `Bearing ${label}`, memberIds };
    const document: CadDocument = {
      ...members.reduce<CadDocument>((d, m) => withEntity(d, m), doc),
      groups: { ...doc.groups, [groupId]: group },
    };
    const [innerRingId, outerRingId, ...rollingElementIds] = memberIds;
    const data = {
      groupId,
      innerRingId,
      outerRingId,
      rollingElementIds,
      type: section.type,
      bore: section.bore,
      outerDiameter: section.outerDiameter,
      width: section.width,
      ...(resolved.designation !== undefined ? { designation: resolved.designation } : {}),
    };
    return {
      document,
      summary:
        `Added ${section.type} bearing ${label} as group ${groupId} ("${group.name}"): bore ${fmt(section.bore)}, ` +
        `outer diameter ${fmt(section.outerDiameter)}, width ${fmt(section.width)}, ${layout.count} rolling elements; ` +
        `centered at ${vecText(position)}, axis ${vecText(unitAxis)}. ` +
        `Ids: ${memberIds.join(', ')}.`,
      affected: [...memberIds, groupId],
      data,
    };
  },
});
