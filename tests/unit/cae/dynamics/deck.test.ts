/**
 * PHY-09 deck sections (TR-DYN-03/30) and readers (TR-DYN-31/60): frequency step with STORAGE=YES before the steady-state step, damping /
 * base-motion cards, refusals (VC-DYN-40, VC-DYN-47), structural damping card and zeta_eq, and the CalculiX-layout DAT tables (VC-DYN-17,
 * VC-DYN-22 values quoted in validation/calculix_dynamics_cases.json; the table bodies here are synthetic).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { DAT_TITLES, parseDat } from '@cae/results/datReader';
import { modalCoordinates, modalTables, steadyStatePoints } from '@cae/dynamics/results/modalData';
import { mustRun, readyRandomStrip, SOURCE, strip } from './fixtures';
import { stripMesh } from './solvedFixtures';

const CASES = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../docs/physics/09-structural-dynamics/validation/calculix_dynamics_cases.json'), 'utf8'),
) as { extracted: { beamdy8: { eigenfrequenciesHz: number[]; fractionOfTotalEffectiveMassXYZ: number[]; outputFrequenciesHz: number[] } } };

function deckOf(doc: CadDocument, analysisId: string, boxId: string): { text: string } | { code: string; message: string } {
  const mesh = stripMesh(doc, analysisId, boxId);
  const constraintId = doc.analysis?.cases[analysisId]?.constraintOrder[0] ?? '';
  const loadIds = doc.analysis?.cases[analysisId]?.loadOrder ?? [];
  const sets: Record<string, number[]> = { [`C_${constraintId}`]: mesh.nodes.filter(([, x]) => x === 0).map(([id]) => id) };
  for (const id of loadIds) sets[`L_${id}`] = mesh.nodes.filter(([, x]) => x === 100).map(([id]) => id);
  return writeInp(doc, analysisId, { ...mesh, nodeSets: sets });
}

const text = (deck: ReturnType<typeof deckOf>): string => ('text' in deck ? deck.text : `REFUSED ${deck.code}`);

describe('dynamic decks', () => {
  it('random_response: constraints in model data, 1 g base amplitude, STORAGE=YES frequency step with S, SSD with modal damping and base motion', () => {
    const { doc, analysisId, boxId } = readyRandomStrip();
    const deck = text(deckOf(doc, analysisId, boxId));
    const lines = deck.split('\n');
    const at = (line: string): number => lines.indexOf(line);
    expect(at('*BOUNDARY')).toBeGreaterThan(0);
    expect(at('*BOUNDARY')).toBeLessThan(at('*STEP'));
    expect(lines[at('*AMPLITUDE, NAME=A_BASE') + 1]).toBe('20, 9806.65, 2000, 9806.65');
    expect(lines.slice(at('*FREQUENCY, STORAGE=YES'), at('*FREQUENCY, STORAGE=YES') + 6)).toEqual([
      '*FREQUENCY, STORAGE=YES',
      '6',
      '*NODE FILE',
      'U',
      '*EL FILE',
      'S',
    ]);
    expect(lines[at('*STEADY STATE DYNAMICS') + 1]).toBe('20, 2000, 20, 3');
    expect(lines.slice(at('*MODAL DAMPING'), at('*MODAL DAMPING') + 2)).toEqual(['*MODAL DAMPING', '1, 6, 0.02']);
    expect(deck).toContain('*BASE MOTION, DOF=3, AMPLITUDE=A_BASE, TYPE=ACCELERATION');
    expect(deck).toContain("** base ASD 'gevs_q' applied by llull post-processing");
    expect(lines.filter((line) => line === '*STEP')).toHaveLength(2);
    expect(text(deckOf(doc, analysisId, boxId))).toBe(deck);
  });

  it('frequency_response: rayleigh card, the loads in the SSD step and complex output requests', () => {
    const base = strip({ type: 'frequency_response', modes: 10 });
    let doc = mustRun(base.doc, 'set_dynamic_damping', {
      analysisId: base.analysisId,
      model: 'rayleigh',
      alpha: 5000,
      beta: 0,
      source: SOURCE,
    });
    doc = mustRun(doc, 'set_frequency_sweep', { analysisId: base.analysisId, fMinHz: 12000, fMaxHz: 14000, pointsPerInterval: 5 });
    doc = mustRun(doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'tip',
      kind: 'force',
      loadCase: 'H1',
      category: 'limit',
      target: { entityId: base.boxId, pointsNear: [[100, 10, 1.5]] },
      vector: [100, 0, 0],
      distribution: 'total',
    });
    const deck = text(deckOf(doc, base.analysisId, base.boxId));
    expect(deck).toContain('*MODAL DAMPING, RAYLEIGH\n,,5000,0\n');
    expect(deck).toContain('12000, 14000, 5, 3');
    expect(deck).toContain('*CLOAD\n');
    expect(deck).not.toContain('*BASE MOTION');
    expect(deck).toMatch(/\*NODE FILE\nU\n\*EL FILE\nS\n\*END STEP\n$/);
  });

  it('refuses incomplete set-ups with their codes (VC-DYN-40 DYN_DAMPING_UNSET first)', () => {
    const bare = strip();
    expect(text(deckOf(bare.doc, bare.analysisId, bare.boxId))).toBe('REFUSED DYN_DAMPING_UNSET');
    const damped = mustRun(bare.doc, 'set_dynamic_damping', {
      analysisId: bare.analysisId,
      model: 'modal',
      ratios: [{ fromMode: 1, toMode: 6, zeta: 0.02 }],
      source: SOURCE,
    });
    expect(text(deckOf(damped, bare.analysisId, bare.boxId))).toBe('REFUSED DYN_SWEEP_UNSET');
    const swept = mustRun(damped, 'set_frequency_sweep', { analysisId: bare.analysisId, fMinHz: 20, fMaxHz: 2000 });
    expect(text(deckOf(swept, bare.analysisId, bare.boxId))).toBe('REFUSED DYN_BASE_UNSET');
    const harmonic = strip({ type: 'frequency_response' });
    let doc = mustRun(harmonic.doc, 'set_dynamic_damping', {
      analysisId: harmonic.analysisId,
      model: 'rayleigh',
      alpha: 1,
      beta: 0,
      source: SOURCE,
    });
    doc = mustRun(doc, 'set_frequency_sweep', { analysisId: harmonic.analysisId, fMinHz: 20, fMaxHz: 2000 });
    expect(text(deckOf(doc, harmonic.analysisId, harmonic.boxId))).toBe('REFUSED FEA_NO_LOADS');
  });

  it('structural damping: refusal without a loss factor, *DAMPING,STRUCTURAL=0.02 and zeta_eq 0.01 with one (VC-DYN-47)', () => {
    const ready = readyRandomStrip();
    const structural = mustRun(ready.doc, 'set_dynamic_damping', { analysisId: ready.analysisId, model: 'structural_material' });
    expect(text(deckOf(structural, ready.analysisId, ready.boxId))).toBe('REFUSED DYN_MATERIAL_NO_DAMPING');
    const eta = mustRun(structural, 'define_property_model', {
      material: 'steel',
      model: {
        id: 'eta',
        property: 'structuralLossFactor',
        unit: '1',
        variables: [],
        validity: [],
        form: { kind: 'constant', value: 0.02 },
        basis: 'typical',
        source: SOURCE,
      },
    });
    const deck = text(deckOf(eta, ready.analysisId, ready.boxId));
    expect(deck).toContain('*DAMPING,STRUCTURAL=0.02');
    expect(deck).not.toContain('*MODAL DAMPING');
  });
});

/** A synthetic CalculiX frequency + SSD .dat in the layout of the test outputs (beamdy8 / beamdy10bm): headings, column heads, rows. */
function syntheticDat(): string {
  const { eigenfrequenciesHz, fractionOfTotalEffectiveMassXYZ, outputFrequenciesHz } = CASES.extracted.beamdy8;
  const e = (value: number): string =>
    value
      .toExponential(6)
      .replace(/e([+-])(\d)$/, 'E$10$2')
      .replace('e', 'E')
      .padStart(15);
  const modeRows = (values: (mode: number) => number[]): string =>
    eigenfrequenciesHz
      .map(
        (_, i) =>
          `      ${i + 1}${values(i + 1)
            .map(e)
            .join(' ')}`,
      )
      .join('\n');
  const ssd = outputFrequenciesHz
    .map(
      (f) => `P A R T I C I P A T I O N   F A C T O R S   F O R   F R E Q U E N C Y    ${f.toExponential(12)} (CYCLES/TIME)

 MODE NO    FREQUENCY               FACTOR
           (CYCLES/TIME)      REAL        IMAGINARY

${modeRows((m) => [eigenfrequenciesHz[m - 1] ?? 0, 1e-3 / m, -1e-4 / m])}

 displacements (vx,vy,vz) for set N1 and time  ${f.toExponential(6)}

       100  3.5E+00  0.0E+00  0.0E+00

 displacements (vx,vy,vz) for set N1 and time  ${f.toExponential(6)}

       100 -1.2E+00  0.0E+00  0.0E+00
`,
    )
    .join('\n');
  return `                        S T E P       1


     E I G E N V A L U E   O U T P U T

 MODE NO    EIGENVALUE                       FREQUENCY
                                     REAL PART            IMAGINARY PART
                           (RAD/TIME)      (CYCLES/TIME     (RAD/TIME)

${modeRows((m) => {
  const f = eigenfrequenciesHz[m - 1] ?? 0;
  return [(2 * Math.PI * f) ** 2, 2 * Math.PI * f, f, 0];
})}

     P A R T I C I P A T I O N   F A C T O R S

MODE NO.   X-COMPONENT     Y-COMPONENT     Z-COMPONENT     X-ROTATION      Y-ROTATION      Z-ROTATION

${modeRows((m) => [1e-4 / m, -2e-5 / m, 3e-6, 0, 1e-3, -1e-4])}

     E F F E C T I V E   M O D A L   M A S S

MODE NO.   X-COMPONENT     Y-COMPONENT     Z-COMPONENT     X-ROTATION      Y-ROTATION      Z-ROTATION

${modeRows((m) => [1e-8 / m, 4e-10 / m, 9e-12, 0, 1e-6, 1e-8])}
TOTAL     ${[1, 2, 3, 4, 5, 6].map(() => e(1e-7)).join(' ')}

     T O T A L   E F F E C T I V E   M A S S

           X-COMPONENT     Y-COMPONENT     Z-COMPONENT     X-ROTATION      Y-ROTATION      Z-ROTATION

          ${[9.1e-8, 9.1e-8, 9.1e-8, 2.06e-6, 2.03e-6, 9.86e-8].map(e).join(' ')}


     F R A C T I O N   O F   T O T A L S

           X-COMPONENT     Y-COMPONENT     Z-COMPONENT     X-ROTATION      Y-ROTATION      Z-ROTATION

          ${[...fractionOfTotalEffectiveMassXYZ, 0.99, 0.99, 0.92].map(e).join(' ')}


                        S T E P       2


${ssd}`;
}

describe('dynamic result readers', () => {
  const dat = parseDat(syntheticDat());
  const artifact = { kind: 'fe_results' as const, meshHash: '', inputHash: '', solver: 'calculix', solverVersion: 't', steps: [], dat };

  it('reads eigenvalues, participation, effective mass, totals and fractions of totals (VC-DYN-22 fractions)', () => {
    const tables = modalTables(artifact);
    expect(tables?.modes).toHaveLength(10);
    expect(tables?.modes[0]?.fHz).toBeCloseTo(13096.03, 1);
    expect(tables?.participation[1]?.[1]).toBeCloseTo(-1e-5, 12);
    expect(tables?.effectiveMass[0]?.[0]).toBeCloseTo(1e-8, 14);
    expect(tables?.totalMass?.[3]).toBeCloseTo(2.06e-6, 12);
    const fractions = dat.tables.find((table) => table.title === DAT_TITLES.fractions)?.rows[0];
    expect(fractions?.slice(0, 3)).toEqual(CASES.extracted.beamdy8.fractionOfTotalEffectiveMassXYZ);
  });

  it('reads the modal coordinates of every steady-state frequency: 9 points for n = 5, m = 1 (VC-DYN-17), and the real / imaginary prints', () => {
    const coordinates = modalCoordinates(artifact);
    expect(coordinates.map((entry) => entry.fHz)).toEqual(CASES.extracted.beamdy8.outputFrequenciesHz);
    expect(coordinates).toHaveLength(5 * 1 - 1 + 5);
    expect(coordinates[0]?.rows[0]?.slice(2)).toEqual([1e-3, -1e-4]);
    const prints = dat.tables.filter((table) => table.title.startsWith('displacements'));
    expect(prints).toHaveLength(18);
    expect(prints[1]?.rows[0]?.[1]).toBe(-1.2);
    expect(steadyStatePoints(artifact)).toEqual([]);
    expect(
      modalTables({ ...artifact, dat: { tables: dat.tables.filter((table) => table.title !== DAT_TITLES.participation) } }),
    ).toBeNull();
    expect(modalTables({ ...artifact, dat: { tables: [] } })).toBeNull();
  });
});
