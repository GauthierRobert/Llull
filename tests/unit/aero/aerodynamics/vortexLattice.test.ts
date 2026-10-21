/** analyze_vortex_lattice (10 AER M3): VC-AER-34 Bertin & Smith swept wing, VC-AER-35 elliptic wing vs lifting line, VC-AER-36 neutral point. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { solveLinear } from '@core/model/materialLaws/linalg';
import { luFactor, luSolve } from '@lib/denseLinalg';
import { influenceMatrix, solveBasis } from '@aero/aerodynamics/vlmKernel';
import { buildLattice } from '@aero/aerodynamics/vlmLattice';
import refs from '../../../../docs/aerospace/10-aerodynamics/validation/data/vlm_references.json';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface Vlm {
  lattice: { panels: number; surfaces: { name: string; area: number; meanChord: number; span: number }[] };
  reference: { area: number; chord: number; aspectRatio: number; defaulted: { area: boolean; point: boolean } };
  polar: {
    alphaDeg: number;
    cl: number;
    cdi: number;
    cm: number;
    spanEfficiency: number | null;
    surfaces: { name: string; cl: number }[];
  }[];
  liftSlopePerRad: number;
  momentSlopePerRad: number;
  neutralPoint: { x: number; staticMargin: number };
  spanLoading: { strips: { y: number; chord: number; cl: number }[] };
  sections: { zeroLiftAngleDeg: number; source: string }[];
  solver: { engine: string };
  warnings: string[];
}

const doc = createEmptyDocument();
const rectangle = (span: number, chord = 1, x = 0, z = 0, incidenceDeg = 0): unknown => ({
  sections: [
    { leadingEdge: [x, 0, z], chord, incidenceDeg },
    { leadingEdge: [x, span / 2, z], chord, incidenceDeg },
  ],
});

function elliptic(aspectRatio: number, stations: number): unknown[] {
  const span = (aspectRatio * Math.PI) / 4;
  return Array.from({ length: stations + 1 }, (_, k) => {
    const eta = Math.sin((Math.PI * k) / (2 * stations));
    const chord = Math.sqrt(Math.max(0, 1 - eta * eta));
    return { leadingEdge: [0.25 - chord / 4, (eta * span) / 2, 0], chord };
  });
}

describe('VC-AER-34: Bertin & Smith swept wing (AR 5, λ 1, Λ 45°, 4 + 4 horseshoes)', () => {
  it(`CL_α = ${refs.bertin_smith_swept_wing.liftSlopePerRad} per rad`, () => {
    const g = refs.bertin_smith_swept_wing.geometry;
    const semiSpan = g.aspectRatio / 2;
    const tan = Math.tan((g.quarterChordSweepDeg * Math.PI) / 180);
    const vlm = data<Vlm>(doc, 'analyze_vortex_lattice', {
      surfaces: [
        {
          name: 'wing',
          sections: [
            { leadingEdge: [0, 0, 0], chord: 1 },
            { leadingEdge: [semiSpan * tan, semiSpan, 0], chord: 1 },
          ],
          spanwisePanels: g.spanwisePanelsPerSide,
          chordwisePanels: g.chordwisePanels,
          spacing: g.spacing,
        },
      ],
      alphasDeg: [0, 4],
    });
    const expected = refs.bertin_smith_swept_wing.liftSlopePerRad;
    expect(Math.abs(vlm.liftSlopePerRad - expected) / expected).toBeLessThan(refs.bertin_smith_swept_wing.tolerance.relative);
    expect(vlm.lattice.panels).toBe(8);
    expect(vlm.reference.aspectRatio).toBeCloseTo(5, 12);
    expect(vlm.polar[0]?.cl).toBe(0);
    expect(vlm.solver.engine).toBe('ts');
  });
});

describe('VC-AER-35: elliptic wing against lifting-line theory (closed form)', () => {
  it('at AR 20 the lift slope is within 1.5 % of a0/(1 + a0/πAR) and e → 1 with spanwise refinement', () => {
    const ref = refs.elliptic_wing_lifting_line;
    const vlm = data<Vlm>(doc, 'analyze_vortex_lattice', {
      surfaces: [{ name: 'wing', sections: elliptic(ref.aspectRatio, 200), spanwisePanels: 200, chordwisePanels: 1 }],
      alphasDeg: [5],
    });
    const a0 = 2 * Math.PI;
    const liftingLine = a0 / (1 + a0 / (Math.PI * vlm.reference.aspectRatio));
    expect(Math.abs(vlm.liftSlopePerRad - liftingLine) / liftingLine).toBeLessThan(ref.liftSlopeRelativeTolerance);
    expect(Math.abs((vlm.polar[0]?.spanEfficiency as number) - 1)).toBeLessThan(ref.spanEfficiencyTolerance);
  });

  it('the lifting-surface slope stays below lifting line and the gap closes as AR grows', () => {
    const gaps = [4, 8, 20].map((ar) => {
      const vlm = data<Vlm>(doc, 'analyze_vortex_lattice', {
        surfaces: [{ name: 'wing', sections: elliptic(ar, 40), spanwisePanels: 40, chordwisePanels: 2 }],
        alphasDeg: [2],
      });
      const liftingLine = (2 * Math.PI) / (1 + 2 / vlm.reference.aspectRatio);
      return (liftingLine - vlm.liftSlopePerRad) / liftingLine;
    });
    expect(gaps.every((gap) => gap > 0)).toBe(true);
    expect(gaps[0]).toBeGreaterThan(gaps[1] as number);
    expect(gaps[1]).toBeGreaterThan(gaps[2] as number);
  });
});

describe('VC-AER-36: neutral point and static margin', () => {
  it('an unswept rectangular AR-20 wing has its neutral point at the quarter chord', () => {
    const ref = refs.quarter_chord_aerodynamic_centre;
    const vlm = data<Vlm>(doc, 'analyze_vortex_lattice', {
      surfaces: [{ name: 'wing', ...(rectangle(ref.aspectRatio) as object), spanwisePanels: 30, chordwisePanels: 6 }],
      referencePoint: [0.1, 0, 0],
    });
    expect(Math.abs(vlm.neutralPoint.x - ref.neutralPointOverChord)).toBeLessThan(ref.tolerance);
    expect(vlm.neutralPoint.staticMargin).toBeCloseTo(vlm.neutralPoint.x - 0.1, 9);
  });

  it('a tail moves the neutral point aft; about the neutral point Cm does not change with α', () => {
    const wing = { name: 'wing', ...(rectangle(8) as object), spanwisePanels: 16, chordwisePanels: 3 };
    const tail = { name: 'htail', ...(rectangle(3, 0.6, 4, 0.2, -2) as object), spanwisePanels: 8, chordwisePanels: 2 };
    const alone = data<Vlm>(doc, 'analyze_vortex_lattice', { surfaces: [wing] });
    const both = data<Vlm>(doc, 'analyze_vortex_lattice', { surfaces: [wing, tail], alphasDeg: [0, 4] });
    expect(both.neutralPoint.x).toBeGreaterThan(alone.neutralPoint.x + 0.3);
    expect(both.polar[1]?.surfaces.map((s) => s.name)).toEqual(['wing', 'htail']);
    expect(both.reference.area).toBeCloseTo(8, 12);
    const aboutNp = data<Vlm>(doc, 'analyze_vortex_lattice', { surfaces: [wing, tail], referencePoint: [both.neutralPoint.x, 0, 0] });
    // x_np uses the small-angle transfer (normal force ≈ lift, tail z-offset ignored): a residual slope of order 1e-4 remains.
    expect(Math.abs(aboutNp.momentSlopePerRad)).toBeLessThan(1e-3);
    expect(Math.abs(aboutNp.neutralPoint.staticMargin)).toBeLessThan(1e-4);
  });
});

describe('surfaces on or across the symmetry plane (review finding)', () => {
  const fin = (incidenceDeg: number): unknown => ({
    name: 'fin',
    sections: [
      { leadingEdge: [4.4, 0, 0], chord: 0.9, incidenceDeg },
      { leadingEdge: [4.9, 0, 1.2], chord: 0.5, incidenceDeg },
    ],
    spanwisePanels: 6,
    chordwisePanels: 2,
  });
  const htail = { name: 'htail', ...(rectangle(3, 0.6, 4.5, 0) as object), spanwisePanels: 6, chordwisePanels: 2 };

  it.each([0, 3])('a fin on y = 0 (incidence %d°) is not mirrored by default and solves', (incidence) => {
    const vlm = data<Vlm>(doc, 'analyze_vortex_lattice', { surfaces: [htail, fin(incidence)], alphasDeg: [0, 4] });
    expect(vlm.lattice.panels).toBe(24 + 12);
    expect(vlm.polar[1]?.surfaces[0]?.cl).toBeGreaterThan(0);
    expect(Math.abs(vlm.polar[1]?.surfaces[1]?.cl as number)).toBeLessThan(incidence === 0 ? 1e-9 : 1e-3);
    expect(Number.isFinite(vlm.neutralPoint.x)).toBe(true);
  });

  it('mirror: true on a fin is refused; a full-span surface equals the mirrored half wing', () => {
    expectRefusal(
      doc,
      'analyze_vortex_lattice',
      { surfaces: [{ ...(fin(0) as object), mirror: true }] },
      'AER_SURFACE_INVALID',
      'surfaces.0.mirror',
    );
    const half = data<Vlm>(doc, 'analyze_vortex_lattice', {
      surfaces: [{ name: 'w', ...(rectangle(8) as object), spanwisePanels: 8, chordwisePanels: 2, spacing: 'uniform' }],
    });
    const full = data<Vlm>(doc, 'analyze_vortex_lattice', {
      surfaces: [
        {
          name: 'w',
          sections: [
            { leadingEdge: [0, -4, 0], chord: 1 },
            { leadingEdge: [0, 4, 0], chord: 1 },
          ],
          spanwisePanels: 16,
          chordwisePanels: 2,
          spacing: 'uniform',
        },
      ],
    });
    expect(full.lattice.panels).toBe(32);
    expect(full.liftSlopePerRad).toBeCloseTo(half.liftSlopePerRad, 10);
  });
});

describe('analyze_vortex_lattice behaviour', () => {
  it('camber from naca: CL is 0 at the zero-lift angle', () => {
    const vlm = data<Vlm>(doc, 'analyze_vortex_lattice', {
      surfaces: [{ name: 'wing', ...(rectangle(10) as object), naca: '2412', spanwisePanels: 12, chordwisePanels: 2 }],
      alphasDeg: [-2.077, 0],
    });
    expect(vlm.sections[0]?.source).toContain('2412');
    expect(Math.abs(vlm.polar[0]?.cl as number)).toBeLessThan(2e-3);
    expect(vlm.polar[1]?.cl).toBeGreaterThan(0.15);
    expect(vlm.warnings.some((w) => w.includes('flat plate'))).toBe(false);
  });

  it('a wing read from a loft_sections solid equals the same sections given explicitly', () => {
    const airfoil = [
      [0, 0],
      [0.3, 0.04],
      [1, 0],
      [0.3, -0.04],
    ];
    const lofted = ok(doc, 'loft_sections', {
      sections: [0, 2, 4].map((y) => ({ center: [0, y, 0], rotation: [Math.PI / 2, 0, 0], section: airfoil })),
      ruled: true,
    });
    expect(lofted.affected, lofted.summary).toHaveLength(1);
    const withLoft: CadDocument = lofted.document;
    const fromLoft = data<Vlm>(withLoft, 'analyze_vortex_lattice', {
      surfaces: [{ name: 'wing', loftId: lofted.affected[0], spanwisePanels: 10, chordwisePanels: 2 }],
    });
    const chord = fromLoft.lattice.surfaces[0]?.meanChord as number;
    expect(chord).toBeGreaterThan(0.9);
    expect(chord).toBeLessThan(1.1);
    expect(fromLoft.lattice.surfaces[0]?.span).toBeCloseTo(8, 9);
    const flat = data<Vlm>(doc, 'analyze_vortex_lattice', {
      surfaces: [{ name: 'wing', ...(rectangle(8, chord) as object), spanwisePanels: 10, chordwisePanels: 2 }],
    });
    expect(fromLoft.liftSlopePerRad).toBeCloseTo(flat.liftSlopePerRad, 2);
    expectRefusal(
      withLoft,
      'analyze_vortex_lattice',
      { surfaces: [{ name: 'w', loftId: 'nope' }] },
      'AER_ENTITY_NOT_FOUND',
      'surfaces.0.loftId',
    );
  });

  it('span loading peaks inboard on a rectangular wing and the result is pure', () => {
    const params = {
      surfaces: [{ name: 'wing', ...(rectangle(6) as object), spanwisePanels: 10, chordwisePanels: 2, mirror: true }],
      alphasDeg: [5],
    };
    const before = structuredClone(doc);
    const result = execute(doc, 'analyze_vortex_lattice', params);
    expect(result.document).toBe(doc);
    expect(doc).toEqual(before);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('neutral point');
    const strips = (result.data as Vlm).spanLoading.strips;
    expect(strips[0]?.cl).toBeGreaterThan(strips[strips.length - 1]?.cl as number);
    expect((result.data as Vlm).reference.defaulted).toMatchObject({ area: true, point: true });
  });

  it.each([
    [{ surfaces: [] }, 'AER_PARAM_INVALID', 'surfaces'],
    [{ surfaces: [{ name: 'w', ...(rectangle(4) as object) }], alphasDeg: [30] }, 'AER_PARAM_INVALID', 'alphasDeg'],
    [{ surfaces: [{ name: 'w', ...(rectangle(4) as object), spanwisePanels: 0 }] }, 'AER_PARAM_INVALID', 'surfaces.0.spanwisePanels'],
    [{ surfaces: [{ name: 'w', ...(rectangle(4) as object), chordwisePanels: 99 }] }, 'AER_PARAM_INVALID', 'surfaces.0.chordwisePanels'],
    [{ surfaces: [{ name: 'w' }] }, 'AER_SURFACE_SOURCE_CONFLICT', 'surfaces.0'],
    [{ surfaces: [{ name: 'w', sections: [{ leadingEdge: [0, 0, 0], chord: 1 }] }] }, 'AER_SURFACE_INVALID', 'surfaces.0.sections'],
    [
      {
        surfaces: [
          {
            name: 'w',
            sections: [
              { leadingEdge: [0, 0, 0], chord: -1 },
              { leadingEdge: [0, 1, 0], chord: 1 },
            ],
          },
        ],
      },
      'AER_SURFACE_INVALID',
      'surfaces.0.sections.0',
    ],
    [
      {
        surfaces: [
          {
            name: 'w',
            sections: [
              { leadingEdge: [0, 0, 0], chord: 1 },
              { leadingEdge: [1, 0, 0], chord: 1 },
            ],
          },
        ],
      },
      'AER_SURFACE_INVALID',
      'surfaces.0',
    ],
    [{ surfaces: [{ name: 'w', ...(rectangle(4) as object), naca: '9999x' }] }, 'AER_AIRFOIL_INVALID', 'surfaces.0.naca'],
    [
      { surfaces: [{ name: 'w', ...(rectangle(4) as object), spanwisePanels: 200, chordwisePanels: 3 }] },
      'AER_LATTICE_TOO_LARGE',
      'surfaces',
    ],
    [{ surfaces: [{ name: 'w', ...(rectangle(4) as object) }], referenceArea: 0 }, 'AER_PARAM_INVALID', 'referenceArea'],
  ])('%j -> %s', (params, code, path) => {
    expectRefusal(doc, 'analyze_vortex_lattice', params, code, path);
  });

  it('a box is not a loft', () => {
    const boxed = ok(doc, 'add_box', { size: [1, 1, 1] });
    const withBox = boxed.document;
    const b1 = boxed.affected[0];
    expectRefusal(withBox, 'analyze_vortex_lattice', { surfaces: [{ name: 'w', loftId: b1 }] }, 'AER_SURFACE_INVALID', 'surfaces.0.loftId');
  });
});

describe('dense LU (RS1 §5 follow-up)', () => {
  it('one factorisation solves several right-hand sides with the bits of solveLinear', () => {
    const n = 7;
    const rows = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => Math.sin(1 + i * 3.1 + j * 1.7) + (i === j ? 0.1 : 0)),
    );
    const factors = luFactor(Float64Array.from(rows.flat()), n);
    expect(factors).not.toBeNull();
    for (const k of [0, 1, 2]) {
      const b = Array.from({ length: n }, (_, i) => Math.cos(i + k));
      const reference = solveLinear(rows, b) as number[];
      expect([...luSolve(factors as NonNullable<typeof factors>, b)]).toEqual(reference);
    }
    expect(luFactor(new Float64Array(4), 2)).toBeNull();
  });

  it('a singular lattice (all panels coincident) has no basis', () => {
    const lattice = buildLattice([
      {
        name: 'w',
        sections: [
          { leadingEdge: [0, 0, 0], chord: 1, incidence: 0 },
          { leadingEdge: [0, 1, 0], chord: 1, incidence: 0 },
        ],
        mirror: false,
        spanwisePanels: 1,
        chordwisePanels: 1,
        spacing: 'uniform',
      },
    ]);
    const doubled = Float64Array.from([...lattice.panels, ...lattice.panels]);
    expect(influenceMatrix(doubled)).toHaveLength(4);
    expect(solveBasis(doubled)).toBeNull();
  });
});
