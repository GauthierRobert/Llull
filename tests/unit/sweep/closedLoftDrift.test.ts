/** DES-2c: the closure drift (holonomy) of a closed loft's seams is shared out over all section pairs instead of one re-seam. */
import { describe, it, expect } from 'vitest';
import type { Vec3 } from '@core/model/vectors';
import { alignSections } from '@core/geometry/loftSkin/sections';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { wireCentroid } from '@lib/nurbs/skinEnds';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '@lib/vec3';

const SIDES = 24;

/** Minimal rotation of `v` taking the unit vector `a` to the unit vector `b`. */
function transport(v: Vec3, a: Vec3, b: Vec3): Vec3 {
  const axis = cross3(a, b);
  const sine = Math.hypot(...axis);
  if (sine < 1e-14) return v;
  const k = scale3(axis, 1 / sine);
  const cosine = dot3(a, b);
  return add3(add3(scale3(v, cosine), scale3(cross3(k, v), sine)), scale3(k, dot3(k, v) * (1 - cosine)));
}

/** Sections (closed 24-gons of radius 3) at `count` points of a skewed loop, each start carried by the minimal rotation from the previous one. */
function saddleSections(count: number, rise = 40): { sections: NurbsCurveData[]; drift: number } {
  const loop = (k: number): { point: Vec3; tangent: Vec3 } => {
    const a = (2 * Math.PI * k) / count;
    return {
      point: [40 * Math.cos(a), 40 * Math.sin(a), rise * (Math.sin(a) + Math.sin(2 * a) / 2)],
      tangent: normalize3([-40 * Math.sin(a), 40 * Math.cos(a), rise * (Math.cos(a) + Math.cos(2 * a))]),
    };
  };
  let start: Vec3 = normalize3(cross3(loop(0).tangent, [0, 0, 1]));
  const sections: NurbsCurveData[] = [];
  let first: Vec3 = start;
  for (let k = 0; k <= count; k++) {
    const { point, tangent } = loop(k % count);
    if (k > 0) start = transport(start, loop(k - 1).tangent, tangent);
    if (k === count) {
      // the start carried once round the loop, seen from the first plane
      const axis = loop(0).tangent;
      const drift = Math.atan2(dot3(cross3(start, first), axis), dot3(start, first));
      return { sections, drift };
    }
    first = k === 0 ? start : first;
    const side = cross3(tangent, start);
    const poles: Vec3[] = Array.from({ length: SIDES + 1 }, (_, j) => {
      const angle = (2 * Math.PI * (j % SIDES)) / SIDES;
      return add3(point, add3(scale3(start, 3 * Math.cos(angle)), scale3(side, 3 * Math.sin(angle))));
    });
    sections.push({
      degree: 1,
      poles,
      knots: poles.map((_, j) => j / SIDES),
      multiplicities: poles.map((_, j) => (j === 0 || j === SIDES ? 2 : 1)),
    });
  }
  return { sections, drift: 0 };
}

/** Signed twist of each pair (i, i + 1 wrapping): the start of section i carried by the minimal rotation onto the next plane, to the next start. */
function pairTwists(sections: readonly NurbsCurveData[]): number[] {
  const centre = (c: NurbsCurveData): Vec3 =>
    scale3(
      c.poles.slice(0, SIDES).reduce((sum, q) => add3(sum, q), [0, 0, 0] as Vec3),
      1 / SIDES,
    );
  const axis = (c: NurbsCurveData): Vec3 => {
    const [p0, p1, p2] = [c.poles[0], c.poles[SIDES / 4], c.poles[SIDES / 2]] as [Vec3, Vec3, Vec3];
    return normalize3(cross3(sub3(p1, p0), sub3(p2, p0)));
  };
  return sections.map((current, i) => {
    const next = sections[(i + 1) % sections.length] as NurbsCurveData;
    const [a, b] = [axis(current), axis(next)];
    const carried = transport(sub3(current.poles[0] as Vec3, centre(current)), a, b);
    const own = sub3(next.poles[0] as Vec3, centre(next));
    return Math.atan2(dot3(cross3(carried, own), b), dot3(carried, own));
  });
}

describe('closed loft seam alignment: closure drift', () => {
  const count = 12;
  const { sections, drift } = saddleSections(count, 30);
  const sequential = alignSections(sections, 'auto', undefined, false) as NurbsCurveData[];
  const shared = alignSections(sections, 'auto', undefined, true) as NurbsCurveData[];

  it('the skewed loop has a real holonomy that the sequential alignment leaves on the closing pair', () => {
    expect(Math.abs(drift)).toBeGreaterThan(0.2);
    const twists = pairTwists(sequential);
    expect(Math.abs(twists[count - 1] as number)).toBeGreaterThan(0.8 * Math.abs(drift));
    for (const twist of twists.slice(0, count - 1)) expect(Math.abs(twist)).toBeLessThan(0.02);
  });
  it('the drift is shared out: every pair, the closing one included, turns by about drift / n', () => {
    expect(shared).toHaveLength(count);
    const twists = pairTwists(shared);
    for (const twist of twists) expect(Math.abs(twist - drift / count)).toBeLessThan(0.02);
    expect(twists.reduce((sum, twist) => sum + twist, 0)).toBeCloseTo(drift, 1);
    expect(Math.max(...twists.map(Math.abs))).toBeLessThan(Math.abs(drift) / 4);
  });
  it('a section wound the other way does not turn the loop the wrong way: the seams are those of the same loop wound alike', () => {
    const reversed = sections.map((section, i) =>
      i === 5 ? { ...section, poles: [...section.poles].reverse(), knots: section.knots.map((k) => 1 - k).reverse() } : section,
    );
    const alike = alignSections(sections, 'auto', undefined, true) as NurbsCurveData[];
    const mixed = alignSections(reversed, 'auto', undefined, true) as NurbsCurveData[];
    const start = (list: NurbsCurveData[], i: number): Vec3 => list[i]?.poles[0] as Vec3;
    const gap = (i: number): number => Math.hypot(...sub3(start(mixed, i), start(alike, i)));
    for (const i of [1, 3, 5, 7, 10]) expect(gap(i), `section ${i}`).toBeLessThan(0.5);
    // the sharing is active (a section far from the first starts away from the sequential position)
    expect(Math.hypot(...sub3(start(alike, 9), start(sequential, 9)))).toBeGreaterThan(0.05);
  });
  it('a ring that turns 120 degrees per step keeps its sense whatever the winding of a section (signs follow the travel, not the previous normal)', () => {
    const ring = saddleSections(3, 0).sections;
    const reversed = ring.map((section, i) =>
      i === 1 ? { ...section, poles: [...section.poles].reverse(), knots: section.knots.map((k) => 1 - k).reverse() } : section,
    );
    const alike = alignSections(ring, 'auto', undefined, true) as NurbsCurveData[];
    const mixed = alignSections(reversed, 'auto', undefined, true) as NurbsCurveData[];
    ring.forEach((_, i) =>
      expect(Math.hypot(...sub3(mixed[i]?.poles[0] as Vec3, alike[i]?.poles[0] as Vec3)), `section ${i}`).toBeLessThan(1e-6),
    );
  });
  it('a section edge-on to the travel (its plane contains it) is signed like the previous axis, whatever its winding', () => {
    const polygon = (point: (angle: number) => Vec3): NurbsCurveData => {
      const poles = Array.from({ length: SIDES + 1 }, (_, j) => point((2 * Math.PI * (j % SIDES)) / SIDES));
      return {
        degree: 1,
        poles,
        knots: poles.map((_, j) => j / SIDES),
        multiplicities: poles.map((_, j) => (j === 0 || j === SIDES ? 2 : 1)),
      };
    };
    // the outer sections are tilted (normal (-0.6, 0.48, 0.64)); the middle one lies in the plane x = 0, which contains the travel along z
    const tiltNormal: Vec3 = [-0.6, 0.48, 0.64];
    const u = normalize3(cross3(tiltNormal, [0, 0, 1]));
    const v = cross3(tiltNormal, u);
    const tilted = (z: number, dx = 0): NurbsCurveData =>
      polygon((t) => add3([dx, 0, z], add3(scale3(u, 3 * Math.cos(t + Math.PI / 4)), scale3(v, 3 * Math.sin(t + Math.PI / 4)))));
    const bottom = tilted(0);
    const edgeOn = polygon((t) => [0, 3 * Math.cos(t), 10 + 3 * Math.sin(t)]);
    // the top is a hair off the axis, so the travel is not exactly along z: a sign taken from it alone would be +x, the previous axis says -x
    const top = tilted(20, 1e-9);
    const reversedEdgeOn = { ...edgeOn, poles: [...edgeOn.poles].reverse(), knots: edgeOn.knots.map((k) => 1 - k).reverse() };
    const alike = alignSections([bottom, edgeOn, top], 'auto', undefined, false) as NurbsCurveData[];
    const mixed = alignSections([bottom, reversedEdgeOn, top], 'auto', undefined, false) as NurbsCurveData[];
    // the middle axis has no sign of its own, so it follows the bottom one: -x (dot -0.6 with its normal); the carried start is the bottom start turned from the tilted normal to +x
    const carried = transport(sub3(bottom.poles[0] as Vec3, wireCentroid(bottom)), tiltNormal, [-1, 0, 0]);
    const target = add3(wireCentroid(edgeOn), carried);
    const nearest = (poles: readonly Vec3[]): Vec3 => {
      let best = poles[0] as Vec3;
      for (let k = 0; k + 1 < poles.length; k++) {
        const [from, to] = [poles[k] as Vec3, poles[k + 1] as Vec3];
        const edge = sub3(to, from);
        const t = Math.min(1, Math.max(0, dot3(sub3(target, from), edge) / dot3(edge, edge)));
        const point = add3(from, scale3(edge, t));
        if (Math.hypot(...sub3(point, target)) < Math.hypot(...sub3(best, target))) best = point;
      }
      return best;
    };
    const expected = nearest(edgeOn.poles);
    // the same seam whichever way the section is wound; the opposite sign (+x) would put the target elsewhere
    expect(Math.hypot(...sub3(alike[1]?.poles[0] as Vec3, expected))).toBeLessThan(1e-6);
    expect(Math.hypot(...sub3(mixed[1]?.poles[0] as Vec3, expected))).toBeLessThan(1e-6);
  });
  it('a loop without drift is not touched by the sharing', () => {
    const planar = saddleSections(6, 0).sections;
    const closed = alignSections(planar, 'auto', undefined, true) as NurbsCurveData[];
    const open = alignSections(planar, 'auto', undefined, false) as NurbsCurveData[];
    expect(closed).toHaveLength(open.length);
    closed.forEach((section, i) => expect(section.poles).toEqual((open[i] as NurbsCurveData).poles));
  });
});
