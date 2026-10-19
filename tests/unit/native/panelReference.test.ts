/**
 * TypeScript reference of the native vortex-lattice solve (VC-AER-33 at crate level, RS1 §2 rule 4): a wing + tail lattice, its influence
 * matrix and the basis circulations, written to solver/crates/llull-panel/tests/fixtures/lattice.json. `cargo test` must rebuild the
 * influence matrix bit for bit and solve to Γ within the VC-AER-33 tolerance. Regenerate with LLULL_WRITE_NATIVE_FIXTURES=1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { influenceMatrix, solveBasis } from '@aero/aerodynamics/vlmKernel';
import { isVlmRefusal, resolveVortexLattice, type VortexLatticeParams } from '@aero/aerodynamics/vlmModel';

const FIXTURE = path.resolve(__dirname, '../../../solver/crates/llull-panel/tests/fixtures/lattice.json');
const WRITE = process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1';

/** Swept, tapered, twisted wing with dihedral + a horizontal tail above it: 56 panels, every branch of the kernel. */
const REFERENCE_LATTICE: VortexLatticeParams = {
  surfaces: [
    {
      name: 'wing',
      sections: [
        { leadingEdge: [0, 0, 0], chord: 1.6 },
        { leadingEdge: [0.9, 4, 0.35], chord: 0.7, incidenceDeg: -2 },
      ],
      spanwisePanels: 8,
      chordwisePanels: 3,
      naca: '2412',
    },
    {
      name: 'htail',
      sections: [
        { leadingEdge: [4.5, 0, 0.6], chord: 0.8, incidenceDeg: -1.5 },
        { leadingEdge: [4.9, 1.5, 0.6], chord: 0.5 },
      ],
      spanwisePanels: 4,
      chordwisePanels: 1,
      spacing: 'uniform',
    },
  ],
};

describe('vortex-lattice native reference fixture (TS = oracle)', () => {
  it('lattice, influence matrix and basis circulations for llull-panel', () => {
    const model = resolveVortexLattice(createEmptyDocument(), REFERENCE_LATTICE, 1000);
    if (isVlmRefusal(model)) throw new Error(model.message);
    const { panels } = model.lattice;
    const basis = solveBasis(panels);
    expect(basis).not.toBeNull();
    const fixture = {
      panels: [...panels],
      influence: [...influenceMatrix(panels)],
      gammaX: [...(basis?.gammaX ?? [])],
      gammaZ: [...(basis?.gammaZ ?? [])],
    };
    expect(fixture.gammaX).toHaveLength(56);
    const text = `${JSON.stringify(fixture)}\n`;
    if (WRITE) writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, 'utf8') === text, 'lattice.json is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1').toBe(true);
  });
});
