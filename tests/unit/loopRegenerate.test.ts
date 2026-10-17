import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { TETRA, fakeKernel } from '../helpers/fakeKernel';

const plan = [
  { command: 'set_parameter', params: { name: 'n', expression: '3' } },
  { command: 'add_box', params: { size: [100, 100, 10] }, as: 'h' },
  {
    repeat: { count: '=n', as: 'i' },
    actions: [
      { command: 'add_cylinder', params: { radius: 4, height: 20, position: ['=30*i', 0, 0] }, as: 'c{i}' },
      { command: 'boolean', params: { op: 'subtract', a: '$h', b: '$c{i}' }, as: 'h' },
    ],
  },
];

describe('loop regeneration with a rebinding outer alias', () => {
  beforeEach(() => setGeometryKernel(fakeKernel({ boolean: TETRA })));
  afterEach(() => setGeometryKernel(null));

  it('set_parameter regenerates the loop with the new count and keeps the cuts', () => {
    const built = execute(createEmptyDocument(), 'build_project', { actions: plan });
    expect(Object.keys(built.document.entities)).toHaveLength(1);
    const r = execute(built.document, 'set_parameter', { name: 'n', expression: '5' });
    expect(r.summary).not.toMatch(/failed|no longer/i);
    const entity = Object.values(r.document.entities)[0]!;
    expect(entity.kind).toBe('mesh');
    // five subtractions: the final solid is a boolean chain of depth 5
    let depth = 0;
    let brep = (entity as { brep?: { op: string; a?: unknown } }).brep;
    while (brep?.op === 'boolean') {
      depth++;
      brep = brep.a as { op: string; a?: unknown } | undefined as typeof brep;
    }
    expect(depth).toBe(5);
  });

  it('replay_history reports a failing regenerated step instead of claiming success', () => {
    const built = execute(createEmptyDocument(), 'build_project', { actions: plan });
    const broken = {
      ...built.document,
      featureHistory: built.document.featureHistory.map((s) => (s.name === 'add_box' ? { ...s, params: { size: 'bad' } } : s)),
    };
    const r = execute(broken, 'replay_history', {});
    expect(r.summary).toMatch(/failed|no longer change/i);
  });

  it('set_parameter reports a loop step that fails on regeneration', () => {
    const built = execute(createEmptyDocument(), 'build_project', { actions: plan });
    const broken = {
      ...built.document,
      featureHistory: built.document.featureHistory.map((s) => (s.name === 'add_box' ? { ...s, params: { size: 'bad' } } : s)),
    };
    const r = execute(broken, 'replay_history', {});
    expect(r.summary).toMatch(/failed|no longer change/i);
  });

  it('set_parameter reports a loop step that fails on regeneration', () => {
    const built = execute(createEmptyDocument(), 'build_project', { actions: plan });
    const broken = {
      ...built.document,
      featureHistory: built.document.featureHistory.map((s) =>
        s.name === 'build_project' ? { ...s, params: JSON.parse(JSON.stringify(s.params).replace(/"a":"[^"]*"/, '"a":"$nope"')) } : s,
      ),
    };
    const r = execute(broken, 'set_parameter', { name: 'n', expression: '4' });
    expect(r.summary).toMatch(/FAILED during regeneration/);
    expect(r.error?.code).toBe('HIST_STEP_FAILED');
  });
});
