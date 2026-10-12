/**
 * add_spline_shaft (DIN 5480-style involute spline) and add_keyed_shaft (DIN 6885 keyway), built
 * directly from profiles — no booleans.
 *
 * @layer core/commands
 */

import type { Entity, MeshData, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import type { Point2 } from '../../lib/polygon';
import { defineCommand, z } from '../schema';
import { nextId } from '../../lib/id';
import { compactNumber as fmt } from '../../lib/compactNumber';
import { finiteVec3OrZero } from '../../lib/vec3';
import { DEFAULT_FLANK_SAMPLES, toothOutline } from '../../lib/gearOutline';
import { addCap, addWalls, createMeshBuilder, prismMesh } from '../../geometry/prismMesh';
import { MAX_GEAR_TEETH } from '../limits';
import { rotatedEntityBounds } from '../../geometry/rotatedBounds';
import { withEntity } from '../entity/entityOps';
import { commitEntity } from '../entity/commitEntity';
import { newEntity } from '../entity/newEntity';
import { boundsText, positionField, rotationField } from './shared';
import { placedMeshEntity, pressureAngleProblem } from './gearSolid';
import { noop } from '../noop';

const SHAFT_SEGMENTS = 64;

/**
 * @command add_spline_shaft
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity (involute spline shaft along +Z)
 * @invariant referenceDiameter > 0; module > 0; teeth = round(referenceDiameter / module) - 2 unless given, integer >= 6; length > 0
 * @failure invalid params -> unchanged doc, summary names the violated param, affected:[]
 */
export const addSplineShaft = defineCommand({
  name: 'add_spline_shaft',
  description:
    'Create an involute spline shaft in the style of DIN 5480 (e.g. W200x5x38 = referenceDiameter 200, module 5, 38 teeth) as one extrusion ' +
    'along +Z (z from 0 to length). Tooth count follows DIN 5480: teeth = referenceDiameter/module - 2 (override with `teeth`). ' +
    'Flanks are involutes of the generating circle (module*teeth/2) at the 30° pressure angle; the nominal tooth thickness on the reference ' +
    'circle is half the pitch; tip radius = referenceDiameter/2 - 0.1*module, tooth depth 0.9*module (approximation of the DIN tolerances). ' +
    'Tooth flanks are sampled coarsely (7 points) to keep STEP/boolean cost low.',
  params: z.object({
    referenceDiameter: z
      .number()
      .describe('DIN 5480 reference diameter dB, > 0 (e.g. 200 for W200x5x38).'),
    module: z.number().describe('Spline module, > 0 (e.g. 5 for W200x5x38).'),
    teeth: z
      .number()
      .describe(
        'Tooth count, integer >= 6. Default round(referenceDiameter/module) - 2 (DIN 5480).',
      )
      .optional(),
    length: z.number().describe('Shaft length along +Z, > 0.'),
    pressureAngle: z
      .number()
      .describe('Flank pressure angle in RADIANS, in (0, π/2). Default 0.5236 (30°, DIN 5480).')
      .optional(),
    position: positionField('Centre of the bottom face. '),
    rotation: rotationField(),
    color: z.string().describe('Hex color. Default "#9aa3ad".').optional(),
    name: z.string().describe('Optional display name.').optional(),
  }),
  run: (
    doc,
    {
      referenceDiameter,
      module: mod,
      teeth,
      length,
      pressureAngle = Math.PI / 6,
      position,
      rotation,
      color = '#9aa3ad',
      name,
    },
  ): CommandResult => {
    const fail = (why: string): CommandResult => noop(doc, `add_spline_shaft failed: ${why}`);
    if (!(referenceDiameter > 0 && Number.isFinite(referenceDiameter))) {
      return fail(`referenceDiameter must be finite and > 0, got ${String(referenceDiameter)}.`);
    }
    if (!(mod > 0 && Number.isFinite(mod)))
      return fail(`module must be finite and > 0, got ${String(mod)}.`);
    const count = Math.round(teeth ?? referenceDiameter / mod - 2);
    if (!(count >= 6 && count <= MAX_GEAR_TEETH)) {
      return fail(
        `teeth must be an integer in [6, ${MAX_GEAR_TEETH}], got ${String(teeth ?? count)}.`,
      );
    }
    if (!(length > 0 && Number.isFinite(length)))
      return fail(`length must be finite and > 0, got ${String(length)}.`);
    const angleProblem = pressureAngleProblem(pressureAngle);
    if (angleProblem !== null) return fail(angleProblem);
    const referenceRadius = referenceDiameter / 2;
    const tipRadius = referenceRadius - 0.1 * mod;
    const rootRadius = tipRadius - 0.9 * mod;
    if (!(rootRadius > 0))
      return fail('module is too large for this referenceDiameter (root radius <= 0).');
    const profile = toothOutline({
      teeth: count,
      baseRadius: ((mod * count) / 2) * Math.cos(pressureAngle),
      tipRadius,
      rootRadius,
      refRadius: referenceRadius,
      halfAngleAtRef: Math.PI / (2 * count),
      flankSamples: DEFAULT_FLANK_SAMPLES,
      phase: 0,
    });
    const at = finiteVec3OrZero(position);
    const id = nextId('spline');
    const entity = newEntity('extrusion', id, { profile, depth: length }, at, color, {
      rotation: finiteVec3OrZero(rotation),
      name,
    });
    return commitEntity(
      doc,
      entity,
      `Created spline_shaft ${id}: W${fmt(referenceDiameter)}x${fmt(mod)}x${count} tipD=${fmt(2 * tipRadius)} ` +
        `rootD=${fmt(2 * rootRadius)} length=${fmt(length)} (${profile.length} profile points) at [${at.map(fmt).join(', ')}]. ` +
        `${boundsText(rotatedEntityBounds(entity))}.`,
    );
  },
});

/** DIN 6885 form A parallel keys: [max shaft diameter, key width b, key height h, shaft groove depth t1]. */
const DIN_6885: ReadonlyArray<readonly [number, number, number, number]> = [
  [8, 2, 2, 1.2],
  [10, 3, 3, 1.8],
  [12, 4, 4, 2.5],
  [17, 5, 5, 3],
  [22, 6, 6, 3.5],
  [30, 8, 7, 4],
  [38, 10, 8, 5],
  [44, 12, 8, 5],
  [50, 14, 9, 5.5],
  [58, 16, 10, 6],
  [65, 18, 11, 7],
  [75, 20, 12, 7.5],
  [85, 22, 14, 9],
  [95, 25, 14, 9],
  [110, 28, 16, 10],
  [130, 32, 18, 11],
  [150, 36, 20, 12],
  [170, 40, 22, 13],
  [200, 45, 25, 15],
  [230, 50, 28, 17],
  [260, 56, 32, 20],
  [290, 63, 32, 20],
  [330, 70, 36, 22],
  [380, 80, 40, 25],
  [440, 90, 45, 28],
  [500, 100, 50, 31],
];

/** DIN 6885 key for a shaft diameter (largest entry when beyond the table). */
export function din6885Key(diameter: number): { width: number; height: number; depth: number } {
  const row = DIN_6885.find(([max]) => diameter <= max) ?? DIN_6885[DIN_6885.length - 1]!;
  return { width: row[1], height: row[2], depth: row[3] };
}

interface KeywayGeometry {
  /** Full circle outline including the arc inside the slot (CCW). */
  readonly full: Point2[];
  /** Circle with the slot cut out down to the groove floor (CCW). */
  readonly notched: Point2[];
  /** Circular-segment ∩ slot region that remains solid below a pocket end (CCW). */
  readonly step: Point2[];
}

/** Shaft section outlines for a groove of `width` and `depth` on the +X side. */
function keywayGeometry(radius: number, width: number, depth: number): KeywayGeometry {
  const half = Math.asin(width / (2 * radius));
  const polar = (a: number): Point2 => [radius * Math.cos(a), radius * Math.sin(a)];
  const outsideSteps = Math.max(
    8,
    Math.ceil(((2 * Math.PI - 2 * half) * SHAFT_SEGMENTS) / (2 * Math.PI)),
  );
  const outside = Array.from({ length: outsideSteps + 1 }, (_, i) =>
    polar(half + ((2 * Math.PI - 2 * half) * i) / outsideSteps),
  );
  const slotSteps = Math.max(2, Math.ceil((2 * half * SHAFT_SEGMENTS) / (2 * Math.PI)));
  const slotInside = Array.from({ length: slotSteps - 1 }, (_, j) =>
    polar(-half + (2 * half * (j + 1)) / slotSteps),
  );
  const upperEdge = outside[0]!;
  const lowerEdge = outside[outside.length - 1]!;
  const floorX = radius - depth;
  const floorUpper: Point2 = [floorX, upperEdge[1]];
  const floorLower: Point2 = [floorX, lowerEdge[1]];
  return {
    full: [...outside, ...slotInside],
    notched: [...outside, floorLower, floorUpper],
    step: [lowerEdge, ...slotInside, upperEdge, floorUpper, floorLower],
  };
}

/** Local mesh of a shaft (z in [0, length]) with a rectangular keyway pocket from `z0` to `z1`. */
export function keyedShaftMesh(
  radius: number,
  length: number,
  width: number,
  depth: number,
  z0: number,
  z1: number,
): MeshData {
  const { full, notched, step } = keywayGeometry(radius, width, depth);
  const builder = createMeshBuilder();
  const bottomOpen = z0 <= 0;
  const topOpen = z1 >= length;
  addCap(builder, bottomOpen ? notched : full, [], 0, false);
  addCap(builder, topOpen ? notched : full, [], length, true);
  if (!bottomOpen) {
    addWalls(builder, full, 0, z0, true);
    addCap(builder, step, [], z0, true);
  }
  addWalls(builder, notched, Math.max(z0, 0), Math.min(z1, length), true);
  if (!topOpen) {
    addCap(builder, step, [], z1, false);
    addWalls(builder, full, z1, length, true);
  }
  return builder.build();
}

/**
 * @command add_keyed_shaft
 * @pure
 * @layer core/commands
 * @affects creates 1 mesh entity (shaft with a rectangular keyway) and optionally 1 mesh entity (parallel key)
 * @invariant diameter > 0; length > 0; keyDepth in (sagitta, 0.9·radius]; keyWidth < 1.8·radius; keyway inside [0, length]
 * @failure invalid params -> unchanged doc, summary names the violated param, affected:[]
 */
export const addKeyedShaft = defineCommand({
  name: 'add_keyed_shaft',
  description:
    'Create a round shaft along +Z (z from 0 to length) with a rectangular keyway (pocket) on its +X side, built as one closed mesh solid ' +
    'without booleans. Keyway width b, groove depth t1 (from the shaft surface to the groove floor) and the optional key height h default ' +
    'to the DIN 6885 form A values for the shaft diameter (e.g. d=40 -> b=12, t1=5, h=8). The pocket spans keyLength starting keyOffset ' +
    'above the bottom end (defaults: keyLength = 60% of length, centred); keyOffset 0 or reaching the top gives an open-ended keyway. ' +
    'includeKey=true also creates the matching parallel key as a separate mesh solid seated in the groove ' +
    '(affected = [shaft, key]). Result is world-space mesh entities.',
  params: z.object({
    diameter: z.number().describe('Shaft diameter, > 0.'),
    length: z.number().describe('Shaft length along +Z, > 0.'),
    keyWidth: z
      .number()
      .describe('Keyway width b. Default from DIN 6885 for the diameter.')
      .optional(),
    keyDepth: z
      .number()
      .describe('Groove depth t1 measured from the shaft surface. Default from DIN 6885.')
      .optional(),
    keyHeight: z
      .number()
      .describe('Key height h (only used when includeKey is true). Default from DIN 6885.')
      .optional(),
    keyLength: z
      .number()
      .describe('Keyway length along the shaft, > 0 and <= length. Default 60% of length.')
      .optional(),
    keyOffset: z
      .number()
      .describe(
        'Distance from the shaft bottom end (z = 0) to the keyway start, >= 0. Default centred.',
      )
      .optional(),
    includeKey: z
      .boolean()
      .describe('Also create the parallel key part. Default false.')
      .optional(),
    position: positionField('Centre of the shaft bottom face. '),
    rotation: rotationField(),
    color: z.string().describe('Shaft hex color. Default "#9aa3ad".').optional(),
    keyColor: z.string().describe('Key hex color. Default "#c0a060".').optional(),
    name: z.string().describe('Optional display name for the shaft.').optional(),
  }),
  run: (
    doc,
    {
      diameter,
      length,
      keyWidth,
      keyDepth,
      keyHeight,
      keyLength,
      keyOffset,
      includeKey = false,
      position,
      rotation,
      color = '#9aa3ad',
      keyColor = '#c0a060',
      name,
    },
  ): CommandResult => {
    const fail = (why: string): CommandResult => noop(doc, `add_keyed_shaft failed: ${why}`);
    if (!(diameter > 0 && Number.isFinite(diameter)))
      return fail(`diameter must be finite and > 0, got ${String(diameter)}.`);
    if (!(length > 0 && Number.isFinite(length)))
      return fail(`length must be finite and > 0, got ${String(length)}.`);
    const din = din6885Key(diameter);
    const [width, depth, height] = [
      keyWidth ?? din.width,
      keyDepth ?? din.depth,
      keyHeight ?? din.height,
    ];
    const radius = diameter / 2;
    if (!(width > 0 && width < 1.8 * radius))
      return fail(`keyWidth must be in (0, ${fmt(1.8 * radius)}), got ${String(width)}.`);
    const sagitta = radius - Math.sqrt(radius * radius - (width * width) / 4);
    if (!(depth > sagitta && depth <= 0.9 * radius)) {
      return fail(
        `keyDepth must be in (${fmt(sagitta)}, ${fmt(0.9 * radius)}], got ${String(depth)}.`,
      );
    }
    if (!(height > depth))
      return fail(`keyHeight must be > keyDepth (${fmt(depth)}), got ${String(height)}.`);
    const span = keyLength ?? 0.6 * length;
    if (!(span > 0 && span <= length))
      return fail(`keyLength must be in (0, ${fmt(length)}], got ${String(span)}.`);
    const start = keyOffset ?? (length - span) / 2;
    if (!(start >= 0 && start + span <= length + 1e-9)) {
      return fail(
        `keyOffset must be in [0, ${fmt(length - span)}] for keyLength ${fmt(span)}, got ${String(start)}.`,
      );
    }

    const at: Vec3 = finiteVec3OrZero(position);
    const turn: Vec3 = finiteVec3OrZero(rotation);
    const shaftId = nextId('shaft');
    const shaft = placedMeshEntity(
      shaftId,
      keyedShaftMesh(radius, length, width, depth, start, start + span),
      at,
      turn,
      color,
      name,
    );
    const entities: Entity[] = [shaft];
    if (includeKey) {
      const x0 = radius - depth;
      const rectangle: Point2[] = [
        [x0, -width / 2],
        [x0 + height, -width / 2],
        [x0 + height, width / 2],
        [x0, width / 2],
      ];
      const slab = prismMesh(rectangle, [], span);
      const lifted: MeshData = {
        positions: slab.positions.map((v, i) => (i % 3 === 2 ? v + start : v)),
        indices: slab.indices,
      };
      entities.push(
        placedMeshEntity(
          nextId('key'),
          lifted,
          at,
          turn,
          keyColor,
          name ? `${name}_key` : undefined,
        ),
      );
    }
    return {
      document: entities.reduce(withEntity, doc),
      summary:
        `Created keyed_shaft ${shaftId}: d=${fmt(diameter)} length=${fmt(length)} keyway b=${fmt(width)} t1=${fmt(depth)} ` +
        `length=${fmt(span)} from z=${fmt(start)}${includeKey ? ` plus key ${entities[1]!.id} (h=${fmt(height)})` : ''} ` +
        `at [${at.map(fmt).join(', ')}]. ${boundsText(rotatedEntityBounds(shaft))}.`,
      affected: entities.map((e) => e.id),
    };
  },
});
