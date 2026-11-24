/** LIM-1: a `.lld` design keeps the sweep face layout of its DOCUMENT through every sandbox it re-runs in (apply, check_design, expand_design, replay). */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { sweepProfile } from '@core/commands/solids/sweep';
import { createEmptyDocument, type CadDocument, type SweepEntity } from '@core/model/types';

const SOURCE = `sweep_profile path=[[0,0,0],[0,40,120],[30,90,220],[80,110,300]] smooth=true stations=[{at:0,radius:60},{at:0.5,radiusX:50,radiusY:40},{at:1,radius:30}]
check bbox of=@last expect == [0, 0, 0]
`;
const PLAIN = SOURCE.split('\n')[0] as string;

/** An old document: no marker. */
const old = (): CadDocument => {
  const { sweepFaceLayout: _marker, ...rest } = createEmptyDocument();
  return rest;
};

/** The `sweepFaceLayout` every sweep_profile run saw, in the order they ran. */
function recordLayouts(): { seen: Array<string | undefined>; restore: () => void } {
  const seen: Array<string | undefined> = [];
  const original = sweepProfile.run;
  const spy = vi.spyOn(sweepProfile, 'run').mockImplementation((doc, params, ctx) => {
    seen.push(doc.sweepFaceLayout);
    return original(doc, params, ctx);
  });
  return { seen, restore: () => spy.mockRestore() };
}

beforeAll(async () => setGeometryKernel(await createManifoldKernel()), 60_000);
afterAll(() => setGeometryKernel(null));
afterEach(() => vi.restoreAllMocks());

describe.each([
  ['an old document', old, undefined],
  ['a new document', createEmptyDocument, 'joined'],
] as const)('%s', (_name, make, marker) => {
  it('runs every sweep of apply_design, expand_design and its re-run in a sandbox with the document marker', () => {
    const recorder = recordLayouts();
    const applied = execute(make(), 'apply_design', { source: PLAIN });
    expect(applied.affected.length, applied.summary).toBeGreaterThan(0);
    expect(execute(applied.document, 'expand_design', { source: PLAIN }).rejected).not.toBe(true);
    execute(applied.document, 'check_design', {});
    execute(applied.document, 'replay_history', {});
    recorder.restore();
    expect(recorder.seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(recorder.seen)).toEqual(new Set([marker]));
    const sweep = Object.values(applied.document.entities).find((e): e is SweepEntity => e.kind === 'sweep');
    expect(sweep?.faceLayout).toBe(marker);
  });
});
