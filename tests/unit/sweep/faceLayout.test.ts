/**
 * LIM-1: the joined face layout of a fitted sweep is decided by the DOCUMENT (`sweepFaceLayout`), never by the replay flag: a document made before
 * it keeps one face per ring edge on every path (its stored `f<k>` / `e(f|f)` names refer to that layout), a new document joins on every path.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type SweepEntity } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { FACE_GROUPS } from '@core/geometry/sweepEval/mergeFaces';
import { withSweepLayoutOf } from '@core/model/documentSettings';
import { fitSweepFaces, fitToleranceOf } from '@core/geometry/sweepEval/fitted';

const RING_EDGES = 24;
const PATH = [
  [0, 0, 0],
  [0, 40, 120],
  [30, 90, 220],
  [80, 110, 300],
];
const PARAMS = {
  path: PATH,
  smooth: true,
  stations: [
    { at: 0, radius: 60 },
    { at: 0.5, radiusX: 50, radiusY: 40 },
    { at: 1, radius: 30 },
  ],
};

/** A document made before the joined layout: no marker on the document, none on its entities. */
function legacy(doc: CadDocument): CadDocument {
  const plain = JSON.parse(
    JSON.stringify(doc, (key, value: unknown) => (key === 'faceLayout' || key === 'sweepFaceLayout' ? undefined : value)),
  ) as CadDocument;
  return plain;
}

const sweeps = (doc: CadDocument): SweepEntity[] => Object.values(doc.entities).filter((e): e is SweepEntity => e.kind === 'sweep');
const facesPerSweep = (doc: CadDocument): number[] =>
  sweeps(doc).map((sweep) => {
    const fit = fitSweepFaces(sweep, fitToleranceOf(sweep));
    return 'faces' in fit ? fit.faces.length : -1;
  });
/** The 4 runs of this sweep (3 path segments plus the station at 0.5). */
const JOINED = 4 * FACE_GROUPS;
const EDGES = 4 * RING_EDGES;

describe('fitted sweep face layout follows the document', () => {
  it('a new document joins; the entity carries the layout the kernel lowering reads', () => {
    expect(createEmptyDocument().sweepFaceLayout).toBe('joined');
    const made = execute(createEmptyDocument(), 'sweep_profile', PARAMS).document;
    expect(sweeps(made)[0]?.faceLayout).toBe('joined');
    expect(facesPerSweep(made)).toEqual([JOINED]);
    expect(made.featureHistory[0]?.params).not.toHaveProperty('faceLayout');
  });

  it('an old document keeps one face per ring edge for a sweep added to it, and loading never adds the marker', () => {
    const old = legacy(execute(createEmptyDocument(), 'sweep_profile', PARAMS).document);
    const loaded = deserializeDocument(serializeDocument(old));
    expect(loaded.sweepFaceLayout).toBeUndefined();
    const added = execute(loaded, 'sweep_profile', { ...PARAMS, radius: undefined, id: 'second' }).document;
    expect(facesPerSweep(added)).toEqual([EDGES, EDGES]);
    expect(added.sweepFaceLayout).toBeUndefined();
  });

  it.each([
    ['a new document', (d: CadDocument): CadDocument => d, JOINED],
    ['an old document', legacy, EDGES],
  ])('%s keeps its layout through edit_step_params with complete fresh params and through replay_history', (_name, make, faces) => {
    const doc = make(execute(createEmptyDocument(), 'sweep_profile', PARAMS).document);
    const stepId = doc.featureHistory[0]?.id as string;
    const edited = execute(doc, 'edit_step_params', { stepId, params: { ...PARAMS, radius: undefined } }).document;
    expect(facesPerSweep(edited)).toEqual([faces]);
    expect(facesPerSweep(execute(doc, 'replay_history', {}).document)).toEqual([faces]);
  });

  it.each([
    ['a new document', (d: CadDocument): CadDocument => d, JOINED],
    ['an old document', legacy, EDGES],
  ])('%s keeps its layout when a recipe expands and when build_project replays', (_name, make, faces) => {
    let doc = execute(createEmptyDocument(), 'sweep_profile', PARAMS).document;
    doc = execute(doc, 'save_recipe', { name: 'duct' }).document;
    doc = execute(doc, 'instantiate_recipe', { name: 'duct' }).document;
    doc = make(doc);
    expect(facesPerSweep(execute(doc, 'replay_history', {}).document)).toEqual([faces, faces]);
    const built = make(
      execute(createEmptyDocument(), 'build_project', { actions: [{ command: 'sweep_profile', params: PARAMS }] }).document,
    );
    expect(facesPerSweep(execute(built, 'replay_history', {}).document)).toEqual([faces]);
  });

  it('withSweepLayoutOf gives a fresh document the marker of its base, or none when the base has none', () => {
    expect(withSweepLayoutOf(createEmptyDocument(), createEmptyDocument()).sweepFaceLayout).toBe('joined');
    const none = withSweepLayoutOf(createEmptyDocument(), legacy(createEmptyDocument()));
    expect(none.sweepFaceLayout).toBeUndefined();
    expect('sweepFaceLayout' in none).toBe(false);
    expect(withSweepLayoutOf(none, createEmptyDocument()).sweepFaceLayout).toBe('joined');
  });

  it('refuses a marker other than joined on load', () => {
    const bad = { ...createEmptyDocument(), sweepFaceLayout: 'edges' } as unknown as Record<string, unknown>;
    expect(validateDocumentValues(bad)).toContain("sweepFaceLayout must be 'joined' or absent");
    expect(validateDocumentValues({ ...bad, sweepFaceLayout: 'joined' })).toEqual([]);
  });
});

describe('a .lld design in an old document', () => {
  beforeAll(async () => setGeometryKernel(await createManifoldKernel()), 60_000);
  afterAll(() => setGeometryKernel(null));

  it('keeps the per-edge layout of its sweeps (apply_design, then replay_history)', () => {
    const source =
      'sweep_profile path=[[0,0,0],[0,40,120],[30,90,220],[80,110,300]] smooth=true stations=[{at:0,radius:60},{at:0.5,radiusX:50,radiusY:40},{at:1,radius:30}]';
    const old = legacy(createEmptyDocument());
    const applied = execute(old, 'apply_design', { source });
    expect(applied.affected.length, applied.summary).toBeGreaterThan(0);
    expect(facesPerSweep(applied.document)).toEqual([EDGES]);
    expect(facesPerSweep(execute(applied.document, 'replay_history', {}).document)).toEqual([EDGES]);
    const fresh = execute(createEmptyDocument(), 'apply_design', { source });
    expect(facesPerSweep(fresh.document)).toEqual([JOINED]);
  });
});
