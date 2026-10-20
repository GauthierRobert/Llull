// SC-F2 modelled ISO metric threads (ISO 68-1 basic profile) and coils. Volumes by Pappus-Guldin: a groove whose axial cross-section has width(r)
// is swept along a helix of lead p, so it removes (L / p) * integral width(r) 2 pi r dr over a length L (exact for a groove running out through
// both end faces and any L, by periodicity). The surface area of a threaded part has no cheap closed form and is not checked (area null).
import { addCase, mesh } from './caseKit.mjs';
import { PI, box, cylinder, minus, part } from './formulas.mjs';

const TAN_30 = Math.tan(PI / 6);

/** (L / p) * integral from r1 to r2 of width(r) 2 pi r dr by the midpoint rule (width: axial groove width at radius r). */
function swept(width, r1, r2, p, length) {
  const steps = 200000;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const r = r1 + ((i + 0.5) / steps) * (r2 - r1);
    sum += width(r) * 2 * PI * r;
  }
  return ((sum * (r2 - r1)) / steps / p) * length;
}

/** Groove removed from a bolt of major diameter d: root flat p/4 at the minor radius, 7p/8 at the major radius, 60 degree flanks. */
const externalRemoved = (d, p, length) => {
  const r2 = d / 2;
  const r1 = r2 - (5 / 8) * (Math.sqrt(3) / 2) * p;
  return swept((r) => p / 4 + 2 * (r - r1) * TAN_30, r1, r2, p, length);
};

/** Tapped hole of major diameter d: the minor bore plus the groove (p/8 at the major radius, 3p/4 at the minor radius). */
const internalRemoved = (d, p, length) => {
  const r2 = d / 2;
  const r1 = r2 - (5 / 8) * (Math.sqrt(3) / 2) * p;
  return PI * r1 * r1 * length + swept((r) => p / 8 + 2 * (r2 - r) * TAN_30, r1, r2, p, length);
};

const WHY_EXTERNAL =
  'mesh kernel: the cylinder is an inscribed n-gon (volume loss k (1 - cos(pi/n)) / the clipped groove outer edge) and the groove tool is faceted (32 rings per turn)';

export function threadCases(out) {
  // M10 coarse (p = 1.5) bolt blank r=5, h=18 = 12 pitches: V = pi r^2 h - (h / p) * groove sweep; centroid on the axis by screw symmetry.
  const [d, p, h] = [10, 1.5, 18];
  const blank = cylinder(d / 2, h);
  addCase(out, {
    family: 'thread',
    name: 'external-thread-m10',
    description: 'M10 coarse (P 1.5) external thread over the whole length of a r=5 h=18 cylinder (12 pitches)',
    formula: 'V = pi r^2 h - (h/p) int w(r) 2 pi r dr, w = p/4 + 2 (r - r1) tan 30, r1 = d/2 - 5H/8, H = sqrt3/2 p (ISO 68-1)',
    actions: [
      { command: 'add_cylinder', params: { radius: d / 2, height: h }, as: 'c' },
      { command: 'add_external_thread', params: { target: '$c', size: 'M10' } },
    ],
    p: part(blank.v - externalRemoved(d, p, h), null, [0, 0, 0], blank.min, blank.max),
    mesh: mesh(0.012, null, WHY_EXTERNAL),
  });

  // M6 tapped through a 20x20x4 plate (4 pitches): minor bore (d1) + groove.
  const plate = box([20, 20, 4]);
  const [d6, p6] = [6, 1];
  addCase(out, {
    family: 'thread',
    name: 'tapped-hole-m6',
    description: 'M6 coarse (P 1) tapped through hole in a 20x20x4 plate',
    formula: 'V = abc - pi r1^2 t - (t/p) int w(r) 2 pi r dr, w = p/8 + 2 (R - r) tan 30 on [r1, R], r1 = R - 5H/8 (ISO 68-1)',
    actions: [
      { command: 'add_box', params: { size: [20, 20, 4] }, as: 'p' },
      {
        command: 'add_tapped_hole',
        params: {
          target: '$p',
          face: { near: [0, 0, 2] },
          points: [[0, 0]],
          pointsFrame: 'world_xy',
          size: 'M6',
          extent: { kind: 'through_all' },
        },
      },
    ],
    p: minus(plate, { v: internalRemoved(d6, p6, 4), c: [0, 0, 0] }),
    mesh: mesh(0.002, null, 'mesh kernel: bore tessellated as an inscribed n-gon and the thread groove tool is faceted'),
    area: null,
  });

  // Round-wire coil, Pappus-Guldin for a tube: V = pi r_s^2 L with L the centre-line length (the tube does not overlap itself: r_s < pitch / 2).
  const [R, pitch, turns, rs] = [10, 5, 6, 1];
  const turnLength = Math.hypot(2 * PI * R, pitch);
  const cosTilt = (2 * PI * R) / turnLength; // z component of the section's axial axis: the section is perpendicular to the helix tangent
  addCase(out, {
    family: 'coil',
    name: 'coil-round-wire',
    description: 'coil of wire r=1 on a helix of radius 10, pitch 5, 6 turns (base on z = 0)',
    formula:
      'V = pi r_s^2 L, L = turns sqrt((2 pi R)^2 + pitch^2); z from r_s (1 - cos a) to pitch turns + r_s (1 + cos a), tan a = pitch / (2 pi R)',
    actions: [{ command: 'add_coil', params: { radius: R, pitch, turns, sectionRadius: rs } }],
    p: part(
      PI * rs * rs * turns * turnLength,
      null,
      [0, 0, rs + (pitch * turns) / 2],
      [-(R + rs), -(R + rs), rs * (1 - cosTilt)],
      [R + rs, R + rs, pitch * turns + rs * (1 + cosTilt)],
    ),
    tolerance: { volume: 6e-3, centroid: 2e-3, bbox: 2e-3 },
    mesh: mesh(
      0.01,
      null,
      'the wire is a 24-gon section along a 16-per-turn Catmull-Rom spline of the helix (measured 4e-4 on Manifold); the exact run tolerates 6e-3 for the spline path',
    ),
  });

  // Flat wire: a radial w x axial h rectangle in the axial plane screwed 4 turns: V = w h 2 pi R turns, exact (the section does not rotate).
  const [Rf, w, hf, pf, nf] = [10, 2, 1.5, 3, 4];
  addCase(out, {
    family: 'coil',
    name: 'coil-flat-wire',
    description: 'flat wire 2 (radial) x 1.5 (axial) on a helix of radius 10, pitch 3, 4 turns',
    formula: 'V = w h 2 pi R turns; z from 0 to pitch turns + h',
    actions: [
      { command: 'add_coil', params: { radius: Rf, pitch: pf, turns: nf, sectionShape: 'rectangle', sectionWidth: w, sectionHeight: hf } },
    ],
    p: part(
      w * hf * 2 * PI * Rf * nf,
      null,
      [0, 0, (pf * nf + hf) / 2],
      [-(Rf + w / 2), -(Rf + w / 2), 0],
      [Rf + w / 2, Rf + w / 2, pf * nf + hf],
    ),
    tolerance: { volume: 5e-3, centroid: 2e-3, bbox: 2e-3 },
    mesh: mesh(0.005, null, 'faceted helical skin (32 rings per turn, radii inflated to keep the facet area of the circular sector)'),
  });
}
