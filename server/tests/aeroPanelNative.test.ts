/**
 * vortex_lattice_solve (10 AER M3, VC-AER-33) with the real `llull-compute` when it is built (cargo build --release -p llull-compute in
 * solver/), else skipped with a logged reason; the missing-binary and refusal paths always run. Native vs TypeScript on the same lattice:
 * circulations within 1e-12 of max |Γ| (influence matrix bit-identical, LU round-off only), identical output on rerun; above the TS cap the
 * native solve keeps converging to the closed form (elliptic wing, e -> 1).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { isNativeTool, nativeToolDefinitions, runNativeTool } from '../src/native/tools';
import { runVortexLatticeSolve } from '../src/native/vortexLattice';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('aeroPanelNative: llull-compute not built (cargo build --release -p llull-compute in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

const doc = createEmptyDocument();
const host: FeaHost = {
  getDoc: (): CadDocument => doc,
  applyCommand: (name, params) => {
    const result = execute(doc, name, params);
    return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
  },
};

const wingAndTail = {
  surfaces: [
    {
      name: 'wing',
      sections: [
        { leadingEdge: [0, 0, 0], chord: 1.6 },
        { leadingEdge: [0.9, 4, 0.35], chord: 0.7, incidenceDeg: -2 },
      ],
      spanwisePanels: 20,
      chordwisePanels: 6,
      naca: '2412',
    },
    {
      name: 'htail',
      sections: [
        { leadingEdge: [4.5, 0, 0.6], chord: 0.8, incidenceDeg: -1.5 },
        { leadingEdge: [4.9, 1.5, 0.6], chord: 0.5 },
      ],
      spanwisePanels: 8,
      chordwisePanels: 3,
    },
  ],
  alphasDeg: [-2, 0, 4, 8],
  referencePoint: [0.6, 0, 0],
};

function elliptic(aspectRatio: number, stations: number): unknown[] {
  const span = (aspectRatio * Math.PI) / 4;
  return Array.from({ length: stations + 1 }, (_, k) => {
    const eta = Math.sin((Math.PI * k) / (2 * stations));
    const chord = Math.sqrt(Math.max(0, 1 - eta * eta));
    return { leadingEdge: [0.25 - chord / 4, (eta * span) / 2, 0], chord };
  });
}

interface Vlm {
  lattice: { panels: number };
  polar: { cl: number; cdi: number; cm: number; spanEfficiency: number }[];
  liftSlopePerRad: number;
  neutralPoint: { x: number };
  solver: { engine: string; tool?: string; threads?: number; residualX?: number };
  verification?: { largestGammaDifference?: number; skipped?: string };
}

describe('vortex_lattice_solve transport', () => {
  it('is a native tool whose schema is analyze_vortex_lattice plus timeoutS / verify', () => {
    expect(isNativeTool('vortex_lattice_solve')).toBe(true);
    const tool = nativeToolDefinitions().find((definition) => definition.name === 'vortex_lattice_solve');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['surfaces', 'alphasDeg', 'timeoutS', 'verify']),
    );
  });

  it('without the binary answers NATIVE_TOOL_MISSING; refuses invalid params and lattices above 20000 panels', async () => {
    const runner = createComputeRunner({}, null);
    const missing = await runVortexLatticeSolve(wingAndTail, {}, host, { runner });
    expect(missing).toMatchObject({ isError: true, data: { code: 'NATIVE_TOOL_MISSING' } });
    expect(missing.summary).toContain('analyze_vortex_lattice still solves up to 1000 panels');
    expect(await runVortexLatticeSolve({ surfaces: 3 }, {}, host, { runner })).toMatchObject({ data: { code: 'CMD_INVALID_PARAMS' } });
    const big = { ...wingAndTail.surfaces[0], spanwisePanels: 200, chordwisePanels: 50 };
    const huge = { surfaces: [big, { ...big, name: 'wing2' }] };
    expect(await runVortexLatticeSolve(huge, {}, host, { runner })).toMatchObject({
      isError: true,
      data: { code: 'AER_LATTICE_TOO_LARGE' },
    });
  });

  native(
    'native vs TypeScript on the same 288-panel lattice: Γ within 1e-12 of max |Γ|, same loads, identical rerun (VC-AER-33)',
    async () => {
      const runner = createComputeRunner({}, BINARY);
      const first = await runVortexLatticeSolve(wingAndTail, { verify: true }, host, { runner });
      expect(first.isError, first.summary).toBe(false);
      const nativeData = first.data as Vlm;
      expect(nativeData.lattice.panels).toBe(288);
      expect(nativeData.solver).toMatchObject({ engine: 'native', tool: 'llull-compute panel' });
      expect(nativeData.solver.residualX).toBeLessThan(1e-12);
      expect(nativeData.verification?.largestGammaDifference).toBeLessThan(1e-12);
      const ts = execute(doc, 'analyze_vortex_lattice', wingAndTail).data as Vlm;
      expect(ts.solver.engine).toBe('ts');
      nativeData.polar.forEach((row, i) => {
        const reference = ts.polar[i] as Vlm['polar'][number];
        expect(Math.abs(row.cl - reference.cl)).toBeLessThan(1e-9);
        expect(Math.abs(row.cm - reference.cm)).toBeLessThan(1e-9);
        expect(Math.abs(row.cdi - reference.cdi)).toBeLessThan(1e-10);
      });
      expect(Math.abs(nativeData.neutralPoint.x - ts.neutralPoint.x)).toBeLessThan(1e-9);
      const second = await runVortexLatticeSolve(wingAndTail, {}, host, { runner });
      expect((second.data as Vlm).polar).toEqual(nativeData.polar);
    },
    120_000,
  );

  native(
    'above the TS cap (2400 panels): the elliptic wing converges to e = 1 within 0.3 %',
    async () => {
      const params = { surfaces: [{ name: 'wing', sections: elliptic(8, 300), spanwisePanels: 150, chordwisePanels: 8 }], alphasDeg: [4] };
      expect(execute(doc, 'analyze_vortex_lattice', params).error?.code).toBe('AER_LATTICE_TOO_LARGE');
      const result = await runVortexLatticeSolve(params, { verify: true }, host, { runner: createComputeRunner({}, BINARY) });
      expect(result.isError, result.summary).toBe(false);
      const vlm = result.data as Vlm;
      expect(vlm.lattice.panels).toBe(2400);
      expect(Math.abs((vlm.polar[0]?.spanEfficiency as number) - 1)).toBeLessThan(3e-3);
      expect(vlm.verification?.skipped).toContain('exceed the TypeScript cap');
    },
    300_000,
  );

  native(
    'through runNativeTool (the CLI / POST /exchange path), never changing the document',
    async () => {
      const outcome = await runNativeTool('vortex_lattice_solve', { ...wingAndTail, timeoutS: 60 }, host, {
        runner: createComputeRunner({}, BINARY),
        store: undefined as never,
      });
      expect(outcome).toMatchObject({ isError: false, changed: false });
      expect(outcome?.summary).toContain('llull-compute solved 288 panels');
    },
    120_000,
  );
});
