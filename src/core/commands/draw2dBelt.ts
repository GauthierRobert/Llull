import type { Entity, Vec3, Vec2 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { nextId } from '../../lib/id';
import { MAX_CURVE_SAMPLES } from './limits';
import { withEntity, fmtN } from './draw2dShared';

// ---------------------------------------------------------------------------
// draw_belt_around
// ---------------------------------------------------------------------------

/** One pulley/sprocket specification: center in local 2D frame + radius. */
interface PulleySpec {
  center: [number, number];
  radius: number;
}

/**
 * Compute the two external tangent points for a pair of circles (same-side,
 * "open belt" convention).  Returns [tp1, tp2] on c1 and c2 respectively, on
 * the CCW outer envelope side (angle = θ + π/2 + α, where α = asin((r1−r2)/d)).
 *
 * Returns null when no external tangent exists (one circle inside the other).
 */
function externalTangentPoints(
  c1x: number,
  c1y: number,
  r1: number,
  c2x: number,
  c2y: number,
  r2: number,
): readonly [readonly [number, number], readonly [number, number]] | null {
  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return null;
  const sinAlphaRaw = (r1 - r2) / d;
  if (Math.abs(sinAlphaRaw) > 1) return null; // one inside the other
  const alpha = Math.asin(Math.max(-1, Math.min(1, sinAlphaRaw)));
  const theta = Math.atan2(dy, dx);
  // Top-side tangent (CCW outer envelope)
  const angle = theta + Math.PI / 2 + alpha;
  const tp1: readonly [number, number] = [c1x + r1 * Math.cos(angle), c1y + r1 * Math.sin(angle)];
  const tp2: readonly [number, number] = [c2x + r2 * Math.cos(angle), c2y + r2 * Math.sin(angle)];
  return [tp1, tp2] as const;
}

/**
 * Sample a CCW arc on a circle centred at (cx,cy) with radius r,
 * from startAngle to endAngle (both in radians, CCW positive).
 * The arc goes CCW from startAngle to endAngle, wrapping if necessary.
 * Returns `arcSamples` interior chord points (not including the start point;
 * the end point IS included).  This means the caller can safely concatenate
 * arrays without duplicating the join point.
 */
function sampleArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  arcSamples: number,
): ReadonlyArray<readonly [number, number]> {
  // Normalise endAngle so it is > startAngle (CCW sweep)
  let sweep = endAngle - startAngle;
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;

  const pts: Array<readonly [number, number]> = [];
  // Emit arcSamples points: skip i=0 (that's the tangent point already added),
  // include i=arcSamples (the outgoing tangent point on this pulley).
  for (let i = 1; i <= arcSamples; i++) {
    const t = startAngle + (sweep * i) / arcSamples;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

/**
 * @command draw_belt_around
 * @pure
 * @layer core/commands
 * @affects creates 1 closed polyline entity tracing the belt/chain centerline
 * @invariant pulleys.length >= 2; each radius > 0; no coincident centers; no pulley inside another
 * @failure pulleys < 2, non-positive radius, non-finite inputs, coincident centers, pulley-inside-pulley -> no-op, affected:[]
 */
export const drawBeltAround = defineCommand({
  name: 'draw_belt_around',
  description:
    'Compute the closed centerline of a belt or chain wrapping ≥2 circular pulleys/sprockets ' +
    'and emit it as a single closed polyline entity. ' +
    'For each adjacent pair of pulleys the command computes the external common tangent (open-belt / ' +
    'same-direction rotation convention, CCW outer envelope), then samples the wrap arc on each pulley ' +
    'between the two tangent touch-points. The result is one `polyline` with `closed: true`. ' +
    'pulleys is an ordered array of {center:[x,y], radius} objects; the belt wraps them in that order ' +
    'and closes back to the first. ' +
    'arcSamples controls chord resolution per wrap arc (default 12, minimum 2). ' +
    'position/rotation place the entity in 3D world space (default [0,0,0]). ' +
    'Fails gracefully (no-op) when: fewer than 2 pulleys, non-positive or non-finite radius, ' +
    'non-finite center coordinates, coincident centers, or any pulley is contained inside another ' +
    '(no external tangent exists).',
  params: z.object({
    pulleys: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Ordered list of pulleys the belt wraps around. Each entry is an object ' +
          '{ center: [x, y], radius: number } where center is a 2D point in the work plane ' +
          'and radius is a finite positive number. ' +
          'The belt wraps them in the given order and closes back to the first. Minimum 2 pulleys.',
      ),
    arcSamples: z
      .number()
      .describe(
        'Integer number of chord segments used to approximate each pulley wrap arc. ' +
          'Must be >= 2. Default 12. Higher values give smoother arcs.',
      )
      .optional(),
    position: vec3(
      'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
    ).optional(),
    rotation: z
      .array(z.number())
      .describe(
        'Extrinsic XYZ Euler angles in radians [rx, ry, rz] for the work plane. Defaults to [0,0,0].',
      )
      .optional(),
    color: z
      .string()
      .describe('Hex color string, e.g. "#4a90d9". Defaults to "#4a90d9".')
      .optional(),
    name: z
      .string()
      .describe('Optional display name for the entity (shown in the scene tree).')
      .optional(),
  }),
  run: (
    doc,
    {
      pulleys: pulleyInput,
      arcSamples = 12,
      position = [0, 0, 0] as const,
      rotation = [0, 0, 0],
      color = '#4a90d9',
      name,
    },
  ): CommandResult => {
    // --- Validate pulleys array ---
    const pulleys = pulleyInput as unknown as PulleySpec[];
    if (pulleys.length < 2) {
      return {
        document: doc,
        summary: `draw_belt_around: requires at least 2 pulleys (got ${pulleys.length}).`,
        affected: [],
      };
    }

    // --- Validate arcSamples ---
    if (!Number.isFinite(arcSamples) || arcSamples < 2 || arcSamples > MAX_CURVE_SAMPLES) {
      return {
        document: doc,
        summary: `draw_belt_around: arcSamples must be a finite number in [2, ${MAX_CURVE_SAMPLES}] (got ${String(arcSamples)}).`,
        affected: [],
      };
    }
    const samplesInt = Math.round(arcSamples);

    // --- Validate each pulley ---
    for (let i = 0; i < pulleys.length; i++) {
      const p = pulleys[i]!;
      if (!p || !Array.isArray(p.center) || p.center.length < 2) {
        return {
          document: doc,
          summary: `draw_belt_around: pulley[${i}] center must be a [x, y] array.`,
          affected: [],
        };
      }
      const [cx, cy] = p.center;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        return {
          document: doc,
          summary: `draw_belt_around: pulley[${i}] center contains non-finite coordinate (${cx}, ${cy}).`,
          affected: [],
        };
      }
      if (!Number.isFinite(p.radius) || p.radius <= 0) {
        return {
          document: doc,
          summary: `draw_belt_around: pulley[${i}] radius must be a finite positive number (got ${String(p.radius)}).`,
          affected: [],
        };
      }
    }

    // --- Check for coincident centers or pulley-inside-pulley ---
    const n = pulleys.length;
    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const p1 = pulleys[i]!;
      const p2 = pulleys[ni]!;
      const dx = p2.center[0]! - p1.center[0]!;
      const dy = p2.center[1]! - p1.center[1]!;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d === 0) {
        return {
          document: doc,
          summary: `draw_belt_around: pulleys[${i}] and pulleys[${ni}] have coincident centers.`,
          affected: [],
        };
      }
      if (d < Math.abs(p1.radius - p2.radius)) {
        return {
          document: doc,
          summary: `draw_belt_around: pulley[${ni}] is inside pulley[${i}] (d=${fmtN(d)} < |r1−r2|=${fmtN(Math.abs(p1.radius - p2.radius))}); no external tangent.`,
          affected: [],
        };
      }
    }

    // --- Compute belt loop ---
    // For each pair i→(i+1)%n, compute external tangent touch-points.
    // Then for each pulley, emit wrap arc from its incoming tp to its outgoing tp.

    // Gather per-pair tangent touch-points:
    // tangentPairs[i] = [outTP on pulleys[i], inTP on pulleys[(i+1)%n]]
    type TangentPair = readonly [readonly [number, number], readonly [number, number]];
    const tangentPairs: TangentPair[] = [];
    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const p1 = pulleys[i]!;
      const p2 = pulleys[ni]!;
      const result = externalTangentPoints(
        p1.center[0]!,
        p1.center[1]!,
        p1.radius,
        p2.center[0]!,
        p2.center[1]!,
        p2.radius,
      );
      if (result === null) {
        // Shouldn't happen since we checked above, but guard for safety
        return {
          document: doc,
          summary: `draw_belt_around: failed to compute tangent between pulleys[${i}] and pulleys[${ni}].`,
          affected: [],
        };
      }
      tangentPairs.push(result);
    }

    // Build the closed polyline points:
    // For each pulley i:
    //   1. Emit outgoing tangent point on pulley i (from tangentPairs[i][0])
    //   2. Emit the tangent line (implicit — just the start point; end is next arc's start)
    //   Actually: the loop is:
    //     outTP_i, [tangent line to] inTP_{i+1},
    //     arc on pulley_{i+1} from inTP_{i+1} to outTP_{i+1}
    // So we iterate: for i in 0..n-1:
    //   push outTP[i] (= tangentPairs[i][0])
    //   push arc samples on pulleys[(i+1)%n] from inAngle to outAngle
    //   (the end of the arc is outTP[(i+1)%n], which is tangentPairs[(i+1)%n][0])

    const points: Array<readonly [number, number]> = [];

    // Accumulate lengths for summary
    let totalLength = 0;

    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const outTP = tangentPairs[i]![0]; // outgoing TP on pulley i
      const inTP = tangentPairs[i]![1]; // incoming TP on pulley ni

      // 1. Outgoing tangent point on pulley i
      points.push(outTP);

      // 2. Tangent segment length: outTP → inTP
      const tdx = inTP[0] - outTP[0];
      const tdy = inTP[1] - outTP[1];
      totalLength += Math.sqrt(tdx * tdx + tdy * tdy);

      // 3. Wrap arc on pulley ni from inTP to its outgoing TP
      const pni = pulleys[ni]!;
      const outTPni = tangentPairs[ni]![0]; // outgoing TP on pulley ni

      const inAngle = Math.atan2(inTP[1] - pni.center[1]!, inTP[0] - pni.center[0]!);
      const outAngle = Math.atan2(outTPni[1] - pni.center[1]!, outTPni[0] - pni.center[0]!);

      const arcPts = sampleArc(
        pni.center[0]!,
        pni.center[1]!,
        pni.radius,
        inAngle,
        outAngle,
        samplesInt,
      );
      for (const pt of arcPts) {
        points.push(pt);
      }

      // Arc length contribution
      let arcSweep = outAngle - inAngle;
      while (arcSweep <= 0) arcSweep += 2 * Math.PI;
      while (arcSweep > 2 * Math.PI) arcSweep -= 2 * Math.PI;
      totalLength += pni.radius * arcSweep;
    }

    // --- Resolve position / rotation ---
    const resolvedPos: Vec3 =
      Array.isArray(position) &&
      position.length >= 3 &&
      Number.isFinite((position as number[])[0]) &&
      Number.isFinite((position as number[])[1]) &&
      Number.isFinite((position as number[])[2])
        ? [(position as number[])[0]!, (position as number[])[1]!, (position as number[])[2]!]
        : [0, 0, 0];

    const resolvedRot: Vec3 =
      Array.isArray(rotation) &&
      rotation.length >= 3 &&
      Number.isFinite((rotation as number[])[0]) &&
      Number.isFinite((rotation as number[])[1]) &&
      Number.isFinite((rotation as number[])[2])
        ? [(rotation as number[])[0]!, (rotation as number[])[1]!, (rotation as number[])[2]!]
        : [0, 0, 0];

    // --- Compute AABB for summary ---
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    // --- Build entity ---
    const id = nextId('belt');
    const safePoints: ReadonlyArray<Vec2> = points.map(([x, y]) => [x, y] as Vec2);

    const entity: Entity = {
      id,
      kind: 'polyline',
      points: safePoints,
      closed: true,
      position: resolvedPos,
      rotation: resolvedRot,
      layerId: DEFAULT_LAYER_ID,
      color,
      ...(name !== undefined && name !== '' ? { name } : {}),
    };

    return {
      document: withEntity(doc, entity),
      summary:
        `Drew belt ${id}: ${n} pulleys, length ≈ ${fmtN(totalLength)}, ` +
        `bounds x=[${fmtN(minX)}, ${fmtN(maxX)}] y=[${fmtN(minY)}, ${fmtN(maxY)}].`,
      affected: [id],
    };
  },
});
