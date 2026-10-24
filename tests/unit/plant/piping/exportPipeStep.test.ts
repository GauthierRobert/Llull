/**
 * Plant 02 RTE V1 part 2: `export_pipe_step` (exact solids through the kernel). Both paths: no kernel (execute refuses), a kernel without a STEP writer
 * (named XCH_WRITER_UNAVAILABLE) and a scripted exact kernel (the products of the derived parts, named by part id and line number).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExchangeWriteRequest } from '@core/geometry/kernelExchange';
import type { CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { fakeKernel } from '../../../helpers/fakeKernel';
import { fakeXdeKernel } from '../../../helpers/fakeXdeKernel';
import { addTie, cs150Line, routedPumpToVesselWithTee } from './rteFixtures';

const ctxOf = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });

function smallLine(): { doc: CadDocument; lineId: string; runId: string } {
  const line = cs150Line(100, '6001');
  const a = addTie(line.doc, 'STEP-A', [0, 0, 0], [1, 0, 0]);
  const doc = apply(a.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Z', length: 2000 },
    ],
  });
  return { doc, lineId: line.lineId, runId: doc.plant?.piping?.runOrder[0] as string };
}

describe('export_pipe_step', () => {
  const s = smallLine();

  it('without a kernel execute refuses it by name (requiresKernel) and the document is untouched', () => {
    const result = execute(s.doc, 'export_pipe_step', {}, ctxOf(null));
    expect(result.document).toBe(s.doc);
    expect(result.affected).toEqual([]);
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/kernel/i);
    expect(result.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
  });

  it('a kernel without a STEP writer (the mesh kernel) is a named refusal, not a faceted fallback', () => {
    const result = execute(s.doc, 'export_pipe_step', {}, ctxOf(fakeKernel()));
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('XCH_WRITER_UNAVAILABLE');
    expect(result.summary).toContain('export_pipe_step');
    expect(result.document).toBe(s.doc);
  });

  it('with the exact kernel every part is a product named by its part id and line number, and the text is returned for --save', () => {
    const fake = fakeXdeKernel();
    const result = execute(s.doc, 'export_pipe_step', { timestamp: '2026-10-24T00:00:00' }, ctxOf(fake.kernel));
    expect(result.rejected, result.summary).toBeUndefined();
    const request = fake.requests[0] as ExchangeWriteRequest;
    expect(request.products.map((product) => product.name)).toEqual([
      `Pipe ${s.runId}/pipe-1 100-P-6001-CS150`,
      `Elbow ${s.runId}/elbow-1 100-P-6001-CS150`,
      `Pipe ${s.runId}/pipe-2 100-P-6001-CS150`,
    ]);
    expect(request.header.fileName).toBe('pipe.stp');
    const data = result.data as { step: string; name: string; runs: string[]; lineIds: string[]; solidCount: number };
    expect(data).toMatchObject({ name: 'pipe.stp', runs: [s.runId], lineIds: [s.lineId], solidCount: 3 });
    expect(data.step).toContain('ISO-10303-21');
    expect(result.document).toBe(s.doc);
    expect(result.summary).toContain('export_pipe_step');
  });

  it('lineIds / runIds select the runs; the branch run is a separate selection', () => {
    const scene = routedPumpToVesselWithTee();
    const header = fakeXdeKernel();
    execute(scene.doc, 'export_pipe_step', { runIds: [scene.runId] }, ctxOf(header.kernel));
    const both = fakeXdeKernel();
    execute(scene.doc, 'export_pipe_step', { lineIds: [scene.line] }, ctxOf(both.kernel));
    const headerNames = (header.requests[0] as ExchangeWriteRequest).products.map((product) => product.name);
    const bothNames = (both.requests[0] as ExchangeWriteRequest).products.map((product) => product.name);
    expect(bothNames.length).toBe(headerNames.length + 1);
    expect(bothNames.some((name) => name.includes(`${scene.branchRunId}/pipe-1`))).toBe(true);
    expect(headerNames.some((name) => name.includes(`${scene.branchRunId}/`))).toBe(false);
  });

  it('refuses an unknown line or run, a document with no run, and a run that no longer derives', () => {
    const ctx = ctxOf(fakeXdeKernel().kernel);
    expect(execute(s.doc, 'export_pipe_step', { lineIds: ['line-99'] }, ctx).error?.code).toBe('RTE_UNKNOWN_LINE');
    expect(execute(s.doc, 'export_pipe_step', { runIds: ['run-99'] }, ctx).error?.code).toBe('RTE_UNKNOWN_RUN');
    const empty = cs150Line(100, '6002');
    expect(execute(empty.doc, 'export_pipe_step', {}, ctx).error?.code).toBe('RTE_NO_RUNS');
    const withoutSpec = { ...s.doc, plant: { ...s.doc.plant, spec: undefined } } as unknown as CadDocument;
    expect(execute(withoutSpec, 'export_pipe_step', {}, ctx).error?.code).toMatch(/^RTE_/);
  });

  it('is pure and read-only', () => {
    const ctx = ctxOf(fakeXdeKernel().kernel);
    expectPure(s.doc, () => execute(s.doc, 'export_pipe_step', {}, ctx));
  });
});
