/** preview_emboss_on_face / preview_add_knurl — read-only previews of what the two commands would do, from the same checks and parameters (03 WRP, spec §14.17): the footprint on the face and the groove lines of a knurl. */

import type { Vec3 } from '../../model/types';
import { frameOf } from '../../geometry/chartFrame';
import { add3, scale3 } from '../../lib/vec3';
import { defineCommand } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { knurlParams } from './addKnurl';
import { embossParams } from './embossOnFace';
import { runEmboss } from './embossRun';
import { planKnurl } from './knurlPlan';

/** Groove lines returned at most (every n-th tooth is kept above it): a drawing, not an export. */
const MAX_LINES = 400;
const MAX_POINTS_PER_LINE = 200;

/**
 * @affects none (read-only); data = { footprint [{ hole, points }] (world polylines of the loops of the sketch on the face), mode, depth, method, distortion { maxLengthStrain, areaRatio, ... }, expectedVolumeDelta (closed form, null where unknown), anchor, normal, unit }
 * @invariant runs the checks of emboss_on_face up to the kernel build (profile, chart, wrap-around, on-face probes, distortion limit, depth reach) so a preview that answers is a command that would reach the kernel; nothing is built, stored or changed
 * @failure every refusal of emboss_on_face before the build, with the same code and message (the chart distortion limit, the profile, the face); a chain is not drawn (WRP_PARAM_INVALID)
 */
export const previewEmbossOnFace = defineCommand({
  name: 'preview_emboss_on_face',
  annotations: { readsMeshTriangles: true, readOnly: true, requiresKernel: true },
  description:
    'Preview of emboss_on_face (same parameters, nothing is changed or built): where the sketch lands on the face and how the chart stretches it. Returns data.footprint [{ hole, points[] }] (the loops of the sketch on the face, world coordinates, closed polylines), ' +
    'data.distortion (maxLengthStrain, meanLengthStrain, areaRatio, worst, limit), data.method, data.expectedVolumeDelta (the closed form of the relief, null where it is only measured), data.anchor, data.normal (the face normal at the anchor, the direction a relief is lifted along), data.instances. ' +
    'It makes the same refusals as emboss_on_face up to the build of the solid (an open profile, a sketch off the face, a distortion over maxLengthStrain, a deboss deeper than the material), with the same codes. A chain of faces is not drawn (leave out chain). Needs the exact native kernel. Next: emboss_on_face with the same parameters.',
  params: embossParams,
  run: (doc, params, ctx): CommandResult => runEmboss(doc, ctx, 'preview_emboss_on_face', params, { preview: true }),
});

interface Line {
  readonly tooth: number;
  readonly hand: 'right' | 'left' | null;
  readonly points: Vec3[];
}

/**
 * @affects none (read-only); data = { lines [{ tooth, hand, points }] (the groove centre lines on the cylinder, world polylines), teeth, pitch, requestedPitch, diameter, pattern, helixAngleDeg?, pitchAdjusted, thinned, length, unit }
 * @invariant teeth = round(pi d / pitch) like add_knurl, so the lines are the ones the knurl closes round the face; straight: axial lines, diagonal: one helix of the hand given (right default), diamond: both hands; at most 400 lines (every n-th tooth), 200 points per line
 * @failure the refusals of add_knurl before its build (not a cylinder, pitch, helix angle, hand, tooth count outside 3..2000, no exact kernel) with the same codes
 */
export const previewAddKnurl = defineCommand({
  name: 'preview_add_knurl',
  annotations: { readsMeshTriangles: true, readOnly: true, requiresKernel: true },
  description:
    'Preview of add_knurl (same parameters, nothing is changed or built): the groove lines of the knurl on the cylinder face. Returns data.lines [{ tooth, hand: "right" | "left" | null, points[] }] (world polylines of the groove centre lines: axial for straight, a helix for diagonal, both hands for diamond), ' +
    'data.teeth, data.pitch (the pitch used, pi d / teeth), data.requestedPitch, data.pitchAdjusted, data.diameter, data.pattern, data.helixAngleDeg, data.thinned (more than 400 lines: every n-th is drawn). ' +
    'It makes the checks of add_knurl before its build (face is a cylinder, pitch > 0, helix angle in (0, 90), 3 to 2000 teeth) with the same codes. Needs the exact native kernel. Next: add_knurl with the same parameters.',
  params: knurlParams,
  run: (doc, params, ctx): CommandResult => {
    const plan = planKnurl(doc, ctx, 'preview_add_knurl', params);
    if ('summary' in plan) return plan;
    const { session, teeth, pitch, diameter, adjusted, helix } = plan;
    const { origin, axis, xDir, radius } = session.surface;
    const frame = frameOf(axis, xDir);
    const [[uLow, vLow], [uHigh, vHigh]] = session.uvBounds;
    const length = vHigh - vLow;
    const turn = helix === undefined ? 0 : (length * Math.tan((helix * Math.PI) / 180)) / radius;
    const keep = Math.ceil((teeth * (params.pattern === 'diamond' ? 2 : 1)) / MAX_LINES);
    const hands: ReadonlyArray<'right' | 'left' | null> =
      params.pattern === 'straight'
        ? [null]
        : params.pattern === 'diamond'
          ? ['right', 'left']
          : [params.hand === 'left' ? 'left' : 'right'];
    const full = uHigh - uLow >= 2 * Math.PI * (1 - 1e-9);
    const lines: Line[] = [];
    let counter = 0;
    for (const hand of hands)
      for (let tooth = 0; tooth < teeth; tooth++) {
        const sign = hand === 'left' ? -1 : 1;
        const start = uLow + (2 * Math.PI * tooth) / teeth;
        const count = turn === 0 ? 2 : Math.max(2, Math.min(MAX_POINTS_PER_LINE, Math.ceil(Math.abs(turn) / 0.1) + 1));
        const azimuth = (k: number): number => start + sign * turn * (k / (count - 1));
        // a patch of the cylinder keeps the grooves that stay on it
        if (!full && (azimuth(0) > uHigh || azimuth(count - 1) > uHigh || azimuth(0) < uLow || azimuth(count - 1) < uLow)) continue;
        if (counter++ % keep !== 0) continue;
        lines.push({
          tooth,
          hand,
          points: Array.from({ length: count }, (_, k): Vec3 => {
            const phi = azimuth(k);
            const radial = add3(scale3(frame.x, radius * Math.cos(phi)), scale3(frame.y, radius * Math.sin(phi)));
            return add3(add3(origin, scale3(frame.axis, vLow + (length * k) / (count - 1))), radial);
          }),
        });
      }
    return report(
      doc,
      `preview_add_knurl: ${params.pattern} knurl, ${teeth} teeth at pitch ${pitch.toPrecision(6)} ${doc.units} (d ${diameter} ${doc.units}${adjusted ? `, asked ${params.pitch}` : ''}${helix === undefined ? '' : `, helix ${helix} degrees`}): ${lines.length} groove line(s) drawn${keep > 1 ? ` (every ${keep}th)` : ''}; nothing is changed.`,
      {
        lines,
        teeth,
        pitch,
        requestedPitch: params.pitch,
        pitchAdjusted: adjusted,
        diameter,
        pattern: params.pattern,
        ...(helix === undefined ? {} : { helixAngleDeg: helix }),
        thinned: keep > 1,
        length,
        unit: doc.units,
      },
    );
  },
});
