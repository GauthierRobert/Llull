/** analyze_vortex_lattice: incidence, camber and zero-lift incidence are "nose up positive" whichever way the sections are listed. */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { data } from '../../../helpers/commandAssertions';

interface Vlm {
  polar: { alphaDeg: number; cl: number; cdi: number; cm: number }[];
  liftSlopePerRad: number;
}
const doc = createEmptyDocument();
const run = (surface: Record<string, unknown>): Vlm =>
  data<Vlm>(doc, 'analyze_vortex_lattice', { surfaces: [{ name: 'w', spanwisePanels: 8, chordwisePanels: 3, ...surface }], alphasDeg: [-4, 0, 6] });

const tapered = (sign: 1 | -1, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sections: [
    { leadingEdge: [0, 0, 0], chord: 1.2, incidenceDeg: 3 },
    { leadingEdge: [0.3, sign * 2, 0.2], chord: 0.6, incidenceDeg: -1 },
  ],
  ...extra,
});

describe('listing direction of the sections', () => {
  it('a half wing with twist and camber listed toward -y gives the same CL, CDi and Cm as listed toward +y (positive incidence is nose up)', () => {
    const plus = run(tapered(1, { naca: '4412' }));
    const minus = run(tapered(-1, { naca: '4412' }));
    expect(minus.polar).toEqual(plus.polar);
    // the incidence really lifts: cambered + 3° root twist gives lift at zero alpha
    expect(plus.polar[1]?.cl).toBeGreaterThan(0.3);
  });

  it('a full-span wing listed toward -y with mirror omitted is not mirrored (as listed toward +y) and gives the same numbers', () => {
    const full = (a: number, b: number): Record<string, unknown> => ({
      sections: [
        { leadingEdge: [0, a, 0], chord: 1, incidenceDeg: 2 },
        { leadingEdge: [0, 0, 0], chord: 1, incidenceDeg: 2 },
        { leadingEdge: [0, b, 0], chord: 1, incidenceDeg: 2 },
      ],
    });
    expect(run(full(2, -2)).polar).toEqual(run(full(-2, 2)).polar);
    expect(run(full(2, -2)).polar[1]?.cl).toBeGreaterThan(0.1);
  });

  it('a vertical fin listed upward or downward has the same nose-up sense', () => {
    const fin = (z: number): Record<string, unknown> => ({
      sections: [
        { leadingEdge: [0, 0, 0], chord: 1, incidenceDeg: 4 },
        { leadingEdge: [0, 0, z], chord: 1, incidenceDeg: 4 },
      ],
      mirror: false,
    });
    const up = run(fin(2));
    const down = run(fin(-2));
    expect(down.polar.map((row) => row.cm)).toEqual(up.polar.map((row) => row.cm));
    expect(down.polar.map((row) => row.cl)).toEqual(up.polar.map((row) => row.cl));
  });
});
