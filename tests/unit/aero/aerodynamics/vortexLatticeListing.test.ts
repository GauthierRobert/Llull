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
  data<Vlm>(doc, 'analyze_vortex_lattice', {
    surfaces: [{ name: 'w', spanwisePanels: 8, chordwisePanels: 3, ...surface }],
    alphasDeg: [-4, 0, 6],
  });

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

describe('continuity and listing invariance of the nose-up sense', () => {
  const fin = (cantDeg: number, listDown: boolean): Record<string, unknown> => {
    const s = Math.sin((cantDeg * Math.PI) / 180);
    const c = Math.cos((cantDeg * Math.PI) / 180);
    const a = { leadingEdge: [0, 0, 0], chord: 1, incidenceDeg: 4 };
    const b = { leadingEdge: [0, 2 * s, 2 * c], chord: 1, incidenceDeg: 4 };
    return { sections: listDown ? [b, a] : [a, b], mirror: false };
  };

  it('a fin canted by a tiny angle either way gives the polar of the vertical fin (no flip across y = 0)', () => {
    const vertical = run(fin(0, false));
    for (const cant of [1e-6, -1e-6, 0.5, -0.5, 10, -10]) {
      const canted = run(fin(cant, false));
      canted.polar.forEach((row, k) => {
        expect(row.cl).toBeCloseTo((vertical.polar[k] as { cl: number }).cl, 1);
      });
    }
    // listing the canted fin downward changes nothing, and the vertical fin has no lift in this plane at all
    run(fin(1e-6, false)).polar.forEach((row, k) => expect(row.cl).toBeCloseTo((run(fin(-1e-6, true)).polar[k] as { cl: number }).cl, 6));
  });

  it('random sign and order of the section listing never changes the polar of a wing or a fin', () => {
    let seed = 12345;
    const random = (): number => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let trial = 0; trial < 12; trial++) {
      const cant = (random() - 0.5) * 60;
      const wing = [
        { leadingEdge: [0, 0, 0], chord: 1.1, incidenceDeg: 2 + random() },
        { leadingEdge: [0.2, 1, 0.1], chord: 0.9, incidenceDeg: 1 },
        { leadingEdge: [0.4, 2, 0.2], chord: 0.6, incidenceDeg: -1 },
      ];
      const finSections = fin(cant, false)['sections'] as Record<string, unknown>[];
      for (const sections of [wing, finSections]) {
        const base = run({ sections, naca: '4412', spacing: 'uniform', ...(sections === finSections ? { mirror: false } : {}) });
        const reversed = run({
          sections: [...sections].reverse(),
          naca: '4412',
          spacing: 'uniform',
          ...(sections === finSections ? { mirror: false } : {}),
        });
        const flipped = run({
          sections: sections.map((s) => {
            const le = s['leadingEdge'] as number[];
            return { ...s, leadingEdge: [le[0], -(le[1] as number), le[2]] };
          }),
          naca: '4412',
          spacing: 'uniform',
          ...(sections === finSections ? { mirror: false } : {}),
        });
        // a y-mirror is a listing change for a wing only: it flips the camber side of a canted fin
        for (const other of sections === finSections ? [reversed] : [reversed, flipped])
          other.polar.forEach((row, k) => {
            const ref = base.polar[k] as { cl: number; cdi: number; cm: number };
            expect(row.cl).toBeCloseTo(ref.cl, 6);
            expect(row.cdi).toBeCloseTo(ref.cdi, 6);
            expect(row.cm).toBeCloseTo(ref.cm, 6);
          });
      }
    }
  });
});
