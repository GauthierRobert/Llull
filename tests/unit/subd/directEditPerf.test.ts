/** 04 DIR §8 / VC-DIR-18: timing of the direct-edit preview paths on the spec's cage sizes (p50 / p95 over repeated runs, bounds scaled by a reference slack like constraintPerf). */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { previewCageCommand } from '@core/commands/subdivision/preview';

const REFERENCE_MILLISECONDS = 12;
const timed = (run: () => unknown): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};
const percentile = (samples: number[], p: number): number =>
  [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(p * samples.length) - 1)] as number;
const measure = (runs: number, run: () => unknown): { p50: number; p95: number } => {
  run();
  const samples = Array.from({ length: runs }, () => timed(run));
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
};

function cageDoc(segments: number, levels: number): { doc: ReturnType<typeof createEmptyDocument>; id: string; vertices: number } {
  const made = execute(createEmptyDocument(), 'add_subdivision_solid', {
    box: { size: [4, 4, 4], segments: [segments, segments, segments] },
    levels,
  });
  const id = made.affected[0] as string;
  return { doc: made.document, id, vertices: (made.document.entities[id] as SubdivisionEntity).vertices.length };
}

const SLACK = Math.max(1, measure(5, () => cageDoc(4, 3)).p50 / REFERENCE_MILLISECONDS);
const log = (line: string): void => {
  if (process.env['LLULL_BENCH_LOG'] !== undefined) appendFileSync(process.env['LLULL_BENCH_LOG'], `${line}\n`);
};

describe('direct-edit preview timing (04 DIR §8)', () => {
  it('cage preview: 386 vertices at level 2 within 16 ms p95', () => {
    const { doc, id, vertices } = cageDoc(8, 2);
    expect(vertices).toBe(386);
    const t = measure(40, () => previewCageCommand(doc, 'edit_subdivision_cage', { id, vertexIndices: [0, 1, 2], translate: [0, 0, 0.1] }));
    log(`cage preview 386 vertices level 2: p50 ${t.p50.toFixed(2)} ms p95 ${t.p95.toFixed(2)} ms (slack ${SLACK.toFixed(2)})`);
    expect(t.p95).toBeLessThan(16 * SLACK);
  });

  it('cage preview: 98 vertices at level 3 within 16 ms p95', () => {
    const { doc, id } = cageDoc(4, 3);
    const t = measure(40, () => previewCageCommand(doc, 'edit_subdivision_cage', { id, vertexIndices: [0], translate: [0, 0, 0.1] }));
    log(`cage preview 98 vertices level 3: p50 ${t.p50.toFixed(2)} ms p95 ${t.p95.toFixed(2)} ms`);
    expect(t.p95).toBeLessThan(16 * SLACK);
  });

  it('subdivision_to_nurbs on a 386-vertex cage within 300 ms', () => {
    const { doc, id } = cageDoc(8, 2);
    const t = measure(5, () => execute(doc, 'subdivision_to_nurbs', { id }));
    log(`subdivision_to_nurbs 386 vertices: p50 ${t.p50.toFixed(1)} ms p95 ${t.p95.toFixed(1)} ms`);
    expect(t.p95).toBeLessThan(300 * SLACK);
  });

  it('check_subdivision on a 1946-vertex cage within 1 s', () => {
    const { doc, id, vertices } = cageDoc(18, 1);
    expect(vertices).toBe(1946);
    const t = measure(3, () => execute(doc, 'check_subdivision', { id }));
    log(`check_subdivision 1946 vertices: p50 ${t.p50.toFixed(1)} ms p95 ${t.p95.toFixed(1)} ms`);
    expect(t.p95).toBeLessThan(1000 * SLACK);
  });
});
