/** Plant 01 PSC CAT-FU: `assign_pipe_spec all: true`, the sweep over every pipe element of the document (all or nothing). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { elementsOf, getBuilding } from '@aec/building/model';
import type { PipeElement } from '@aec/building/types';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { importedDoc, withPipe } from './specFixture';

const pipes = (doc: CadDocument): PipeElement[] => elementsOf(getBuilding(doc), 'pipe');
const base = (): CadDocument => apply(importedDoc(), 'add_level', { name: 'Grade', elevation: 0 });

/** Three legacy pipes: DN65 (line P-1), DN100 (line P-2) and DN80 (no line). */
function scene(): CadDocument {
  let doc = base();
  for (const [y, dn, line] of [
    [0, 65, 'P-1'],
    [1000, 100, 'P-2'],
    [2000, 80, undefined],
  ] as const)
    doc = apply(doc, 'add_pipe_run', {
      points: [
        [0, y, 3000],
        [4000, y, 3000],
      ],
      dn,
      ...(line === undefined ? {} : { line }),
    });
  return doc;
}

describe('assign_pipe_spec all', () => {
  it('binds every pipe element of the document to the spec at its own dn, in one step (the line selectors would need three calls)', () => {
    const doc = scene();
    expect(pipes(doc).every((pipe) => pipe.spec === undefined)).toBe(true);
    const result = ok(doc, 'assign_pipe_spec', { all: true, specId: 'CS150-A1' });
    const swept = pipes(result.document);
    expect(swept.map((pipe) => pipe.spec?.nps)).toEqual(['2-1/2', '4', '3']);
    expect(swept.map((pipe) => pipe.spec?.odMm)).toEqual([73, 114.3, 88.9]);
    expect(result.affected).toEqual(expect.arrayContaining(swept.map((pipe) => pipe.id)));
    expect((result.data as { pipes: unknown[] }).pipes).toHaveLength(3);
    expectPure(doc, () => execute(doc, 'assign_pipe_spec', { all: true, specId: 'CS150-A1' }));
  });

  it('with no size each pipe keeps its binding (a second sweep after a size was set does not reset it), and a given size applies to every pipe', () => {
    const doc = scene();
    const first = apply(doc, 'assign_pipe_spec', { all: true, specId: 'CS150-A1' });
    const resized = apply(first, 'assign_pipe_spec', { pipeId: pipes(first)[0]?.id, specId: 'CS150-A1', nps: 3 });
    const again = apply(resized, 'assign_pipe_spec', { all: true, specId: 'CS150-A1' });
    expect(pipes(again).map((pipe) => pipe.spec?.nps)).toEqual(['3', '4', '3']);
    const same = apply(doc, 'assign_pipe_spec', { all: true, specId: 'CS150-A1', nps: 4 });
    expect(pipes(same).map((pipe) => pipe.spec?.nps)).toEqual(['4', '4', '4']);
  });

  it('is all or nothing: a pipe with neither a binding nor a dn stops the sweep (PSC_SIZE_UNKNOWN) and changes nothing', () => {
    const doc = withPipe(scene(), 'pipe-sizeless', 88.9);
    const refused = expectRefusal(doc, 'assign_pipe_spec', { all: true, specId: 'CS150-A1' }, 'PSC_SIZE_UNKNOWN');
    expect(refused.summary).toContain('pipe-sizeless');
    expect(pipes(refused.document).every((pipe) => pipe.spec === undefined)).toBe(true);
    expect(pipes(apply(doc, 'assign_pipe_spec', { all: true, specId: 'CS150-A1', nps: 3 })).map((pipe) => pipe.spec?.nps)).toEqual([
      '3',
      '3',
      '3',
      '3',
    ]);
  });

  it('refuses a document without a pipe element, all together with another selector, and all: false alone', () => {
    const empty = base();
    expectRefusal(empty, 'assign_pipe_spec', { all: true, specId: 'CS150-A1' }, 'PSC_PIPE_UNKNOWN', 'all');
    const doc = scene();
    expectRefusal(doc, 'assign_pipe_spec', { all: true, line: 'P-1', specId: 'CS150-A1' }, 'PSC_PIPE_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { all: true, pipeId: 'pipe-1', specId: 'CS150-A1' }, 'PSC_PIPE_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { all: false, specId: 'CS150-A1' }, 'PSC_PIPE_UNKNOWN');
  });
});
