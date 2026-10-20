/**
 * SC-N1 / SC-N2: persistent edge names. A fillet records the names of the edges it picked and, after an upstream edit renumbers the
 * kernel's edges, regenerates on the same named edge; a name that disappears or splits refuses the step instead of rounding another edge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { hasNames, namesOf, referenceProblem, resolveNames } from '@core/geometry/naming/references';
import { TETRA } from '../../helpers/fakeKernel';
import { expectPure } from '../../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

type Edge = ShapeTopology['edges'][number];

const edge = (index: number, name: string | undefined, x: number): Edge => ({
  index,
  ...(name === undefined ? {} : { name }),
  curve: 'line',
  length: 1,
  start: [x, 0, 0],
  end: [x, 1, 0],
  mid: [x, 0.5, 0],
  seam: false,
  degenerate: false,
});

const topologyOf = (edges: readonly Edge[]): ShapeTopology => ({ solids: 1, faces: [], edges, vertices: 8, volume: 1 });

const BOX_EDGES = ['e(b:x+|b:z+)', 'e(b:x-|b:z+)', 'e(b:y+|b:z+)', 'e(b:y-|b:z+)'];

/** A box whose edge numbering is reversed once it is wider than 5 (what an upstream edit can do to a real kernel's indices). */
function namedBoxKernel(options: { names?: (size: readonly number[]) => readonly (string | undefined)[] } = {}): { fillets: number[][] } {
  const fillets: number[][] = [];
  type FakeShape = { readonly entity?: Entity; readonly filleted?: true };
  const kernel = kernelFromOps<FakeShape>({
    solid: (entity) => ({ entity }),
    boolean: () => null,
    fillet: (_shape, edges) => {
      fillets.push([...edges]);
      return { filleted: true };
    },
    blend: () => null,
    chamfer: () => ({ filleted: true }),
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    tessellate: () => TETRA,
    topology: (shape) => {
      const size = shape.entity?.kind === 'box' ? shape.entity.size : [1, 1, 1];
      const names = options.names?.(size) ?? BOX_EDGES;
      const ordered = (size[0] ?? 0) > 5 ? [...names].reverse() : [...names];
      return topologyOf(ordered.map((name, index) => edge(index, name, index)));
    },
    exportStep: () => null,
    release: () => undefined,
  });
  setGeometryKernel(kernel);
  return { fillets };
}

function filletedBox(): { doc: CadDocument; boxStep: string; filletStep: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
  const id = box.affected[0] ?? '';
  const filleted = execute(box.document, 'fillet_edge', { id, edgeIndices: [0], radius: 0.5 });
  const [boxStep, filletStep] = filleted.document.featureHistory.map((step) => step.id);
  return { doc: filleted.document, boxStep: boxStep ?? '', filletStep: filletStep ?? '' };
}

describe('persistent names: resolution', () => {
  const topology = topologyOf([edge(0, 'e(A|B)', 0), edge(1, 'e(A|C)#1', 1), edge(2, 'e(A|C)#2', 2)]);

  it('resolves each name to its one edge, in order', () => {
    expect(resolveNames(topology, 'edge', ['e(A|C)#2', 'e(A|B)'])).toEqual({ ok: true, indices: [2, 0] });
  });

  it('reports a name that is gone as lost and one that now has several images as split', () => {
    const resolved = resolveNames(topology, 'edge', ['e(B|C)', 'e(A|C)']);
    expect(resolved).toEqual({ ok: false, lost: ['e(B|C)'], split: ['e(A|C)'] });
    if (!resolved.ok) expect(referenceProblem('edge', resolved)).toMatch(/REF_LOST edge e\(B\|C\).*REF_SPLIT edge e\(A\|C\)/);
  });

  it('knows a kernel without history (no names) and names nothing then', () => {
    const unnamed = topologyOf([edge(0, undefined, 0)]);
    expect(hasNames(unnamed, 'edge')).toBe(false);
    expect(hasNames(null, 'edge')).toBe(false);
    expect(namesOf(unnamed, 'edge', [0])).toBeNull();
    expect(namesOf(topology, 'edge', [1])).toEqual(['e(A|C)#1']);
  });
});

describe('persistent names: fillet_edge', () => {
  it('records the names of the edges it picked by index', () => {
    namedBoxKernel();
    const { doc, filletStep } = filletedBox();
    const step = doc.featureHistory.find((entry) => entry.id === filletStep);
    expect(step?.params).toMatchObject({ edgeIndices: [0], edgeNames: ['e(b:x+|b:z+)'] });
  });

  it('follows the named edge after an upstream edit renumbers the edges', () => {
    const { fillets } = namedBoxKernel();
    const { doc, boxStep } = filletedBox();
    expect(fillets.at(-1)).toEqual([0]);
    const edited = execute(doc, 'edit_step_params', { stepId: boxStep, params: { size: [8, 4, 4] } });
    expect(edited.summary).toMatch(/regenerated/);
    // reversed numbering: e(b:x+|b:z+) is now edge 3, and index 0 would have rounded e(b:y-|b:z+)
    expect(fillets.at(-1)).toEqual([3]);
  });

  it('refuses with REF_LOST when the named edge is gone, and says how to re-pick', () => {
    namedBoxKernel({ names: (size) => ((size[0] ?? 0) > 5 ? ['e(b:x+|b:w+)', ...BOX_EDGES.slice(1)] : BOX_EDGES) });
    const { doc, filletStep } = filletedBox();
    const step = doc.featureHistory.find((entry) => entry.id === filletStep);
    const target = doc.order.find((id) => doc.entities[id]?.kind === 'box');
    expect(target).toBeUndefined();
    const replayed = execute(createEmptyDocument(), 'add_box', { size: [8, 4, 4] });
    const lost = execute(replayed.document, 'fillet_edge', { ...(step?.params ?? {}), id: replayed.affected[0] });
    expect(lost.document).toBe(replayed.document);
    expect(lost.summary).toMatch(/REF_LOST edge e\(b:x\+\|b:z\+\)/);
    expect(lost.summary).toMatch(/edit_step_params/);
    expect(lost.error?.code).toBe('REF_LOST');
  });

  it('refuses with REF_SPLIT when the named edge now has several images', () => {
    namedBoxKernel({ names: () => ['e(b:x+|b:z+)#1', 'e(b:x+|b:z+)#2', ...BOX_EDGES.slice(1)] });
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const split = execute(box.document, 'fillet_edge', { id: box.affected[0], edgeNames: ['e(b:x+|b:z+)'], radius: 0.5 });
    expect(split.document).toBe(box.document);
    expect(split.error?.code).toBe('REF_SPLIT');
  });

  it('keeps the positional pick, flagged unverified, on a kernel without names', () => {
    const { fillets } = namedBoxKernel({ names: () => [undefined, undefined, undefined, undefined] });
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const picked = execute(box.document, 'fillet_edge', {
      id: box.affected[0],
      edgeIndices: [1],
      edgeNames: ['e(b:x+|b:z+)'],
      radius: 0.5,
    });
    expect(fillets.at(-1)).toEqual([1]);
    expect(picked.summary).toMatch(/unverified/);
    const plain = execute(box.document, 'fillet_edge', { id: box.affected[0], edgeIndices: [1], radius: 0.5 });
    expect(plain.document.featureHistory.at(-1)?.params).not.toHaveProperty('edgeNames');
  });

  it('records names for a fillet inside a build_project plan too', () => {
    namedBoxKernel();
    const plan = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [4, 4, 4] }, as: 'b' },
        { command: 'fillet_edge', params: { id: '$b', edgeIndices: [2], radius: 0.5 } },
      ],
    });
    const fillet = plan.document.featureHistory.find((step) => step.name === 'fillet_edge');
    expect(fillet?.params).toMatchObject({ edgeNames: ['e(b:y+|b:z+)'] });
  });

  it('chamfer_edge records and follows names the same way', () => {
    namedBoxKernel();
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const chamfered = execute(box.document, 'chamfer_edge', { id: box.affected[0], edgeIndices: [3], distance: 0.2 });
    expect(chamfered.document.featureHistory.at(-1)?.params).toMatchObject({ edgeNames: ['e(b:y-|b:z+)'] });
  });

  it('is pure', () => {
    namedBoxKernel();
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    expectPure(box.document, () => execute(box.document, 'fillet_edge', { id: box.affected[0], edgeIndices: [0], radius: 0.5 }));
  });
});

describe('persistent names: regeneration and check_model (SC-N2)', () => {
  it('a regeneration that loses the named edge fails the step loudly, and check_model reports REF_LOST with the re-pick', () => {
    namedBoxKernel({ names: (size) => ((size[0] ?? 0) > 5 ? ['e(b:x+|b:w+)', ...BOX_EDGES.slice(1)] : BOX_EDGES) });
    const { doc, boxStep, filletStep } = filletedBox();
    const edited = execute(doc, 'edit_step_params', { stepId: boxStep, params: { size: [8, 4, 4] } });
    expect(edited.summary).toContain(`FAILED during regeneration — the model is incomplete: ${filletStep} (fillet_edge)`);
    expect(edited.summary).toContain('REF_LOST edge e(b:x+|b:z+)');
    const check = execute(edited.document, 'check_model', {});
    const data = check.data as { ok: boolean; issues: { code: string; message: string }[] };
    expect(data.ok).toBe(false);
    expect(data.issues.find((found) => found.code === 'REF_LOST')?.message).toMatch(/edit_step_params/);
  });

  it('check_model says the step did not apply when it cannot tell why (no kernel)', () => {
    namedBoxKernel({ names: (size) => ((size[0] ?? 0) > 5 ? ['e(b:x+|b:w+)', ...BOX_EDGES.slice(1)] : BOX_EDGES) });
    const { doc, boxStep } = filletedBox();
    const edited = execute(doc, 'edit_step_params', { stepId: boxStep, params: { size: [8, 4, 4] } });
    setGeometryKernel(null);
    const codes = (execute(edited.document, 'check_model', {}).data as { issues: { code: string }[] }).issues.map((found) => found.code);
    expect(codes).toContain('feature_step_not_applied');
  });

  it('check_model stays clean while the named edges still resolve', () => {
    namedBoxKernel();
    const { doc, boxStep } = filletedBox();
    const edited = execute(doc, 'edit_step_params', { stepId: boxStep, params: { size: [8, 4, 4] } });
    expect(execute(edited.document, 'check_model', {}).summary).toMatch(/clean/);
  });
});
