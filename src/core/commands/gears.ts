/**
 * Procedural gear commands.
 *
 * PG1: add_spur_gear — parametric involute spur gear computed in pure core math.
 * Produces one `extrusion` entity; no new EntityKind, no kernel call, no DOM.
 *
 * @module
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';
import { rotatedEntityBounds } from './scene';

// ---------------------------------------------------------------------------
// Internal involute geometry helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/**
 * Sample one involute flank of a gear tooth.
 *
 * The involute of a circle with base radius `rb` at parameter `t`:
 *   x(t) = rb * (cos t + t * sin t)
 *   y(t) = rb * (sin t - t * cos t)
 *
 * @param rb      Base circle radius.
 * @param tStart  Start parameter (clamped near root circle when undercut occurs).
 * @param tEnd    End parameter where involute reaches the addendum circle.
 * @param samples Number of points to generate (inclusive of endpoints).
 * @returns Array of [x, y] points along the involute.
 */
function sampleInvolute(
  rb: number,
  tStart: number,
  tEnd: number,
  samples: number,
): ReadonlyArray<readonly [number, number]> {
  const pts: Array<readonly [number, number]> = [];
  const n = Math.max(samples - 1, 1);
  for (let i = 0; i <= n; i++) {
    const t = tStart + ((tEnd - tStart) * i) / n;
    const x = rb * (Math.cos(t) + t * Math.sin(t));
    const y = rb * (Math.sin(t) - t * Math.cos(t));
    pts.push([x, y]);
  }
  return pts;
}

/**
 * Rotate a 2D point by `angle` radians around the origin.
 */
function rotate2D(pt: readonly [number, number], angle: number): readonly [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [pt[0] * c - pt[1] * s, pt[0] * s + pt[1] * c];
}

/**
 * Mirror a 2D point about the X-axis (negate Y).
 */
function mirrorY(pt: readonly [number, number]): readonly [number, number] {
  return [pt[0], -pt[1]];
}

/**
 * Compute the `t` parameter at which the involute of base circle `rb` reaches
 * radius `r` from the origin:  rb * sqrt(1 + t^2) = r → t = sqrt((r/rb)^2 - 1).
 * Returns 0 if r <= rb (involute starts at the base circle).
 */
function involuteT(rb: number, r: number): number {
  if (r <= rb) return 0;
  return Math.sqrt((r / rb) ** 2 - 1);
}

/**
 * Project a point at angle `angle` onto radius `r` around the origin.
 */
function onCircle(r: number, angle: number): readonly [number, number] {
  return [r * Math.cos(angle), r * Math.sin(angle)];
}

/**
 * Sample a circular arc at radius `r` from `startAngle` to `endAngle` (CCW),
 * with `segments` intermediate points (exclusive of start; inclusive of end).
 */
function sampleArc(
  r: number,
  startAngle: number,
  endAngle: number,
  segments: number,
): ReadonlyArray<readonly [number, number]> {
  const pts: Array<readonly [number, number]> = [];
  const n = Math.max(segments, 1);
  for (let i = 1; i <= n; i++) {
    const a = startAngle + ((endAngle - startAngle) * i) / n;
    pts.push(onCircle(r, a));
  }
  return pts;
}

/** Format a number compactly for the summary string. */
function fmt(v: number): string {
  return parseFloat(v.toFixed(4)).toString();
}

/** Format an AABB for use in a summary string. */
function boundsText(b: { min: Vec3; max: Vec3 }): string {
  return `world AABB min [${b.min.map(fmt).join(', ')}] max [${b.max.map(fmt).join(', ')}]`;
}

/** Helper: add one entity and append it to order. */
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

// ---------------------------------------------------------------------------
// Involute spur gear profile builder
// ---------------------------------------------------------------------------

/**
 * Build a closed CCW 2D involute spur gear profile centered at the origin.
 *
 * @param module        Gear module (metric) — pitch radius = module * teeth / 2.
 * @param teeth         Number of teeth (>= 3).
 * @param pressureAngle Pressure angle in radians (typical: Math.PI/9 = 20°).
 * @param flankSamples  Points per involute flank side (default 14).
 * @returns ReadonlyArray of [x, y] forming a closed polygon (first ≈ last).
 *
 * @invariant When baseRadius >= rootRadius (teeth < ~17), undercut occurs.
 *            The involute start is clamped to rootRadius via tStart; the flank
 *            is radially connected to the root circle. This is an approximation.
 */
export function buildSpurGearProfile(
  module: number,
  teeth: number,
  pressureAngle: number,
  flankSamples = 14,
): ReadonlyArray<readonly [number, number]> {
  const pitchRadius = (module * teeth) / 2;
  const baseRadius = pitchRadius * Math.cos(pressureAngle);
  const addendum = module;
  const dedendum = 1.25 * module;
  const outerRadius = pitchRadius + addendum;
  const rootRadius = pitchRadius - dedendum;

  // Tooth pitch angle (one tooth + one gap = 2π/teeth).
  const toothAngle = (2 * Math.PI) / teeth;
  // Half-tooth angle at the pitch circle: tooth thickness = π * module / 2 = pitchAngle / 2.
  // The angular half-width of a tooth at the pitch circle is π / (2 * teeth).
  const halfToothPitchAngle = Math.PI / (2 * teeth);

  // Involute t parameters.
  const tMax = involuteT(baseRadius, outerRadius);
  // Angle of the involute point on the pitch circle (used to orient the tooth symmetrically).
  const tPitch = involuteT(baseRadius, pitchRadius);
  // Involute angle at pitch circle: angle of the involute curve at t = tPitch.
  const involuteAngleAtPitch =
    baseRadius > 0
      ? Math.atan2(
          baseRadius * (Math.sin(tPitch) - tPitch * Math.cos(tPitch)),
          baseRadius * (Math.cos(tPitch) + tPitch * Math.sin(tPitch)),
        )
      : 0;

  // The raw involute flank points start from angle 0 of the base circle.
  // We need to rotate the flank so the tooth is symmetric about the tooth-center line.
  // The tooth center angle for tooth 0 is 0. The right flank of tooth 0 is rotated
  // so that the pitch-circle point lands at +halfToothPitchAngle.
  const rightFlankRotation = halfToothPitchAngle - involuteAngleAtPitch;

  // tStart: clamp to rootRadius if base circle is outside root circle (undercut regime).
  const tStart = baseRadius >= rootRadius ? involuteT(baseRadius, rootRadius) : 0;

  const profile: Array<readonly [number, number]> = [];

  for (let t = 0; t < teeth; t++) {
    const toothCenter = t * toothAngle;

    // --- Right flank (CCW order: approach from root, go outward) ---
    const rightFlank = sampleInvolute(baseRadius, tStart, tMax, flankSamples).map((pt) =>
      rotate2D(pt, rightFlankRotation + toothCenter),
    );

    // --- Tip arc: from right-flank tip to left-flank tip ---
    const rightTipAngle = Math.atan2(rightFlank[rightFlank.length - 1]![1], rightFlank[rightFlank.length - 1]![0]);
    const leftFlankRaw = sampleInvolute(baseRadius, tStart, tMax, flankSamples);
    // Left flank = mirror of right flank about tooth center line, then rotate to tooth position.
    const leftFlankRotation = -halfToothPitchAngle + involuteAngleAtPitch;
    const leftFlank = leftFlankRaw.map((pt) =>
      rotate2D(mirrorY(pt), leftFlankRotation + toothCenter),
    );
    const leftTipAngle = Math.atan2(leftFlank[leftFlank.length - 1]![1], leftFlank[leftFlank.length - 1]![0]);

    // Tip arc CCW from right-flank tip to left-flank tip.
    // The arc sweeps CCW so we need the shorter path across the tooth top.
    let arcEnd = leftTipAngle;
    if (arcEnd < rightTipAngle) arcEnd += 2 * Math.PI;

    const tipArc = sampleArc(outerRadius, rightTipAngle, arcEnd, 2);

    // --- Root arc: from this tooth's left root to next tooth's right root ---
    // Root point angles at bottom of flanks.
    let leftRootAngle: number;
    let nextRightRootAngle: number;

    if (baseRadius >= rootRadius) {
      // Undercut: flank starts at rootRadius; the bottom of the flank IS on the root circle.
      leftRootAngle = Math.atan2(leftFlank[0]![1], leftFlank[0]![0]);
      const nextToothCenter = ((t + 1) % teeth) * toothAngle;
      const nextRightFlankFirst = rotate2D(
        sampleInvolute(baseRadius, tStart, tMax, 2)[0]!,
        rightFlankRotation + nextToothCenter,
      );
      nextRightRootAngle = Math.atan2(nextRightFlankFirst[1], nextRightFlankFirst[0]);
    } else {
      // Root arc from root-circle intersection of left flank to that of next right flank.
      leftRootAngle = Math.atan2(leftFlank[0]![1], leftFlank[0]![0]);
      const nextToothCenter = ((t + 1) % teeth) * toothAngle;
      const nextRightFlankRoot = rotate2D(
        sampleInvolute(baseRadius, 0, 0, 1)[0]!,
        rightFlankRotation + nextToothCenter,
      );
      nextRightRootAngle = Math.atan2(nextRightFlankRoot[1], nextRightFlankRoot[0]);
    }

    // Ensure CCW direction (root arc sweeps CCW).
    let rootArcEnd = nextRightRootAngle;
    if (rootArcEnd <= leftRootAngle) rootArcEnd += 2 * Math.PI;

    // Build root arc points.
    // For very small tooth counts we reduce segments to avoid bloating the profile.
    const rootArcSegs = teeth >= 10 ? 3 : 2;
    const rootArc = sampleArc(rootRadius, leftRootAngle, rootArcEnd, rootArcSegs);

    // Assemble this tooth: right-flank → tip arc → left-flank (reversed) → root arc.
    // Right flank: index 0 is at root, last is at tip.
    // We walk: root of right flank → tip of right flank → tip arc → tip of left flank → root of left flank → root arc to next tooth.
    for (const pt of rightFlank) profile.push(pt);
    for (const pt of tipArc) profile.push(pt);
    // Left flank goes from tip down to root (reversed order).
    for (let i = leftFlank.length - 1; i >= 0; i--) {
      profile.push(leftFlank[i]!);
    }
    for (const pt of rootArc) profile.push(pt);
  }

  // Close the polygon.
  if (profile.length > 0) {
    profile.push(profile[0]!);
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * @command add_spur_gear
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity (spur gear solid)
 * @invariant module > 0; teeth >= 3; pressureAngle in (0, π/2); faceWidth > 0; bore >= 0 and bore < pitchRadius
 * @failure invalid params -> unchanged doc, summary explains which param violated, affected:[]
 * @failure bore > 0 when ExtrusionEntity does not support holes natively -> bore is ignored, noted in summary
 * @invariant when baseRadius >= rootRadius (typically teeth < 17), undercut occurs;
 *            the involute start is clamped to rootRadius (approximate — not geometrically exact undercut)
 */
interface AddSpurGearParams {
  module: number;
  teeth: number;
  pressureAngle?: number;
  faceWidth: number;
  bore?: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  name?: string;
}

export const addSpurGear: CommandDefinition<AddSpurGearParams> = {
  name: 'add_spur_gear',
  description:
    'Create a parametric involute spur gear solid (extrusion). ' +
    'Computes the full closed 2D tooth profile from module, tooth count, and pressure angle, ' +
    'then extrudes it by faceWidth along +Z. ' +
    'module (metric) sets the tooth scale: pitchDiameter = module * teeth. ' +
    'pressureAngle is in RADIANS; standard value is 0.3491 rad (20 degrees = Math.PI/9). ' +
    'faceWidth is the gear thickness along Z. ' +
    'bore is a central hole radius; if > 0 it is currently ignored (kernel hole not yet wired) and noted in the summary. ' +
    'position is [x, y, z] of the gear center; rotation is extrinsic XYZ Euler angles in radians. ' +
    'Right-handed frame, +Z up.',
  paramsSchema: {
    type: 'object',
    properties: {
      module: {
        type: 'number',
        description:
          'Gear module (metric). Controls tooth scale: pitchDiameter = module * teeth. Must be > 0. ' +
          'Common values: 1 (small), 2 (medium), 4 (large).',
      },
      teeth: {
        type: 'number',
        description:
          'Number of teeth. Must be an integer >= 3. ' +
          'Below ~17 teeth undercut occurs; the profile is approximated by clamping the involute to the root circle.',
      },
      pressureAngle: {
        type: 'number',
        description:
          'Pressure angle in RADIANS. Must be in (0, π/2). ' +
          'Standard value: 0.3491 rad (20°). Omit to use the 20° default.',
      },
      faceWidth: {
        type: 'number',
        description:
          'Gear face width (thickness along Z) in document units. Must be > 0. ' +
          'Typical: 8–12× module for spur gears.',
      },
      bore: {
        type: 'number',
        description:
          'Central bore hole radius in document units. >= 0. Default 0 (solid hub). ' +
          'Currently ignored if > 0 (kernel hole not yet wired); a note appears in the summary.',
      },
      position: {
        type: 'array',
        description:
          'World-space center of the gear [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#7a9cbb". Defaults to "#7a9cbb".',
      },
      name: {
        type: 'string',
        description: 'Optional display name for the entity (shown in the scene tree).',
      },
    },
    required: ['module', 'teeth', 'faceWidth'],
  },
  run: (
    doc,
    {
      module: mod,
      teeth,
      pressureAngle = Math.PI / 9,
      faceWidth,
      bore = 0,
      position = [0, 0, 0],
      rotation,
      color = '#7a9cbb',
      name,
    },
  ): CommandResult => {
    // --- Validate module ---
    if (!Number.isFinite(mod) || mod <= 0) {
      return {
        document: doc,
        summary: `add_spur_gear failed: module must be finite and > 0, got ${String(mod)}.`,
        affected: [],
      };
    }

    // --- Validate teeth ---
    const teethInt = Math.round(teeth);
    if (!Number.isFinite(teeth) || teethInt < 3) {
      return {
        document: doc,
        summary: `add_spur_gear failed: teeth must be a finite integer >= 3, got ${String(teeth)}.`,
        affected: [],
      };
    }

    // --- Validate pressureAngle ---
    if (!Number.isFinite(pressureAngle) || pressureAngle <= 0 || pressureAngle >= Math.PI / 2) {
      return {
        document: doc,
        summary: `add_spur_gear failed: pressureAngle must be in (0, π/2), got ${String(pressureAngle)}.`,
        affected: [],
      };
    }

    // --- Validate faceWidth ---
    if (!Number.isFinite(faceWidth) || faceWidth <= 0) {
      return {
        document: doc,
        summary: `add_spur_gear failed: faceWidth must be finite and > 0, got ${String(faceWidth)}.`,
        affected: [],
      };
    }

    // --- Validate bore ---
    const pitchRadius = (mod * teethInt) / 2;
    if (!Number.isFinite(bore) || bore < 0) {
      return {
        document: doc,
        summary: `add_spur_gear failed: bore must be finite and >= 0, got ${String(bore)}.`,
        affected: [],
      };
    }
    if (bore >= pitchRadius) {
      return {
        document: doc,
        summary: `add_spur_gear failed: bore (${bore}) must be < pitchRadius (${pitchRadius}).`,
        affected: [],
      };
    }

    // --- Validate position ---
    const resolvedPosition = resolvePosition(position);
    const resolvedRotation = resolveRotation(rotation);

    // --- Build profile ---
    const profile = buildSpurGearProfile(mod, teethInt, pressureAngle);

    // --- Computed values for summary ---
    const pitchDiameter = mod * teethInt;
    const outerDiameter = pitchDiameter + 2 * mod;

    // --- Bore note ---
    const boreNote =
      bore > 0 ? ` bore=${bore} ignored — kernel hole not yet wired.` : '';

    // --- Create extrusion entity ---
    const id = nextId('gear');
    const entity: Entity = {
      id,
      kind: 'extrusion',
      profile,
      depth: faceWidth,
      position: resolvedPosition,
      rotation: resolvedRotation,
      layerId: DEFAULT_LAYER_ID,
      color,
      ...(name !== undefined && name !== '' ? { name } : {}),
    };

    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);

    return {
      document: newDoc,
      summary:
        `Created spur_gear ${id}: module=${fmt(mod)} teeth=${teethInt} ` +
        `pitchD=${fmt(pitchDiameter)} outerD=${fmt(outerDiameter)} ` +
        `bore=${bore} face=${fmt(faceWidth)} ` +
        `at [${resolvedPosition.map(fmt).join(', ')}].` +
        `${boreNote} ${boundsText(b)}.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// Local helpers (mirrors of geometry.ts — kept here to avoid cross-file dep on internals)
// ---------------------------------------------------------------------------

function resolvePosition(position: unknown): Vec3 {
  if (!Array.isArray(position) || position.length !== 3) return [0, 0, 0];
  const [x, y, z] = position as unknown[];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [0, 0, 0];
  return [x as number, y as number, z as number];
}

function resolveRotation(rotation: unknown): Vec3 {
  if (!Array.isArray(rotation) || rotation.length !== 3) return [0, 0, 0];
  const [rx, ry, rz] = rotation as unknown[];
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) return [0, 0, 0];
  return [rx as number, ry as number, rz as number];
}
