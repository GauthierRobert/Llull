import type { CommandResult } from './types';
import { compactNumber } from '../lib/compactNumber';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { ORIGIN, finiteVec3OrZero } from '../lib/vec3';
import { MAX_CURVE_SAMPLES } from './limits';
import { DEFAULT_DRAW_COLOR, workPlanePositionField } from './draw2dShared';
import { commitEntity } from './commitEntity';
import { newEntity } from './newEntity';
import { pointsExtent } from './sceneBounds';
import { noop } from './noop';

/** One pulley/sprocket specification: center in local 2D frame + radius. */
interface PulleySpec {
  center: [number, number];
  radius: number;
}

type Point = readonly [number, number];

/**
 * The two external tangent points of a pair of circles (same-side, "open belt" convention): [tp1, tp2]
 * on `p1` and `p2`, on the CCW outer envelope side (angle = θ + π/2 + α, α = asin((r1−r2)/d)).
 * @invariant centers distinct and neither circle inside the other (checked by the caller)
 */
function externalTangentPoints(p1: PulleySpec, p2: PulleySpec): readonly [Point, Point] {
  const [c1x, c1y] = p1.center;
  const [c2x, c2y] = p2.center;
  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const alpha = Math.asin((p1.radius - p2.radius) / d);
  const angle = Math.atan2(dy, dx) + Math.PI / 2 + alpha;
  return [
    [c1x + p1.radius * Math.cos(angle), c1y + p1.radius * Math.sin(angle)],
    [c2x + p2.radius * Math.cos(angle), c2y + p2.radius * Math.sin(angle)],
  ];
}

/** CCW sweep from `startAngle` to `endAngle`, normalised into (0, 2π]. */
function ccwSweep(startAngle: number, endAngle: number): number {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  return sweep;
}

/**
 * `arcSamples` chord points on `pulley` from `startAngle` CCW to `endAngle` (radians): the start point
 * is excluded and the end point included, so consecutive runs concatenate without duplicates.
 */
function sampleArc(
  pulley: PulleySpec,
  startAngle: number,
  endAngle: number,
  arcSamples: number,
): Point[] {
  const [cx, cy] = pulley.center;
  const sweep = ccwSweep(startAngle, endAngle);
  return Array.from({ length: arcSamples }, (_, i): Point => {
    const t = startAngle + (sweep * (i + 1)) / arcSamples;
    return [cx + pulley.radius * Math.cos(t), cy + pulley.radius * Math.sin(t)];
  });
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
    position: workPlanePositionField(),
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
      position = ORIGIN,
      rotation = ORIGIN,
      color = DEFAULT_DRAW_COLOR,
      name,
    },
  ): CommandResult => {
    const pulleys = pulleyInput as unknown as PulleySpec[];
    const n = pulleys.length;
    if (n < 2) {
      return noop(doc, `draw_belt_around: requires at least 2 pulleys (got ${n}).`);
    }

    if (arcSamples < 2 || arcSamples > MAX_CURVE_SAMPLES) {
      return noop(
        doc,
        `draw_belt_around: arcSamples must be a finite number in [2, ${MAX_CURVE_SAMPLES}] (got ${String(arcSamples)}).`,
      );
    }
    const samplesInt = Math.round(arcSamples);

    for (let i = 0; i < n; i++) {
      const p = pulleys[i]!;
      if (p.center.length < 2) {
        return noop(doc, `draw_belt_around: pulley[${i}] center must be a [x, y] array.`);
      }
      const [cx, cy] = p.center;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        return noop(
          doc,
          `draw_belt_around: pulley[${i}] center contains non-finite coordinate (${cx}, ${cy}).`,
        );
      }
      if (!Number.isFinite(p.radius) || p.radius <= 0) {
        return noop(
          doc,
          `draw_belt_around: pulley[${i}] radius must be a finite positive number (got ${String(p.radius)}).`,
        );
      }
    }

    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const p1 = pulleys[i]!;
      const p2 = pulleys[ni]!;
      const dx = p2.center[0] - p1.center[0];
      const dy = p2.center[1] - p1.center[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d === 0) {
        return noop(
          doc,
          `draw_belt_around: pulleys[${i}] and pulleys[${ni}] have coincident centers.`,
        );
      }
      if (d < Math.abs(p1.radius - p2.radius)) {
        return noop(
          doc,
          `draw_belt_around: pulley[${ni}] is inside pulley[${i}] (d=${compactNumber(d)} < |r1−r2|=${compactNumber(Math.abs(p1.radius - p2.radius))}); no external tangent.`,
        );
      }
    }

    // tangentPairs[i] = [outgoing TP on pulleys[i], incoming TP on pulleys[(i+1)%n]]
    const tangentPairs = pulleys.map((pulley, i) =>
      externalTangentPoints(pulley, pulleys[(i + 1) % n]!),
    );

    const points: Point[] = [];
    let totalLength = 0;
    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const [outTP, inTP] = tangentPairs[i]!;
      points.push(outTP);

      const tdx = inTP[0] - outTP[0];
      const tdy = inTP[1] - outTP[1];
      totalLength += Math.sqrt(tdx * tdx + tdy * tdy);

      // Wrap arc on pulleys[ni] from its incoming tangent point to its outgoing one.
      const pni = pulleys[ni]!;
      const outTPni = tangentPairs[ni]![0];
      const inAngle = Math.atan2(inTP[1] - pni.center[1], inTP[0] - pni.center[0]);
      const outAngle = Math.atan2(outTPni[1] - pni.center[1], outTPni[0] - pni.center[0]);
      points.push(...sampleArc(pni, inAngle, outAngle, samplesInt));
      totalLength += pni.radius * ccwSweep(inAngle, outAngle);
    }

    const { minX, minY, maxX, maxY } = pointsExtent(points);

    const id = nextId('belt');
    const entity = newEntity(
      'polyline',
      id,
      { points, closed: true },
      finiteVec3OrZero(position, true),
      color,
      { rotation: finiteVec3OrZero(rotation, true), name },
    );

    return commitEntity(
      doc,
      entity,
      `Drew belt ${id}: ${n} pulleys, length ≈ ${compactNumber(totalLength)}, ` +
        `bounds x=[${compactNumber(minX)}, ${compactNumber(maxX)}] y=[${compactNumber(minY)}, ${compactNumber(maxY)}].`,
    );
  },
});
