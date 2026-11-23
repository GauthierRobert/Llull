/**
 * `cfd_solve gridStudy` through the live host (command bus, `/live`): the two dispatched commands are two log entries in order, and one undo
 * removes only the study. The bus runs its commands with the process-wide FE artifact store (`LLULL_FEA_CACHE`), which the solves fill.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const cacheDir = vi.hoisted(() => {
  const dir = `${process.env['TMPDIR'] ?? '/tmp'}/llull-cfd-study-live-${process.pid}`;
  process.env['LLULL_FEA_CACHE'] = dir;
  return dir;
});

import { rmSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import type { FeaHost } from '@protocol/index';
import { applyCommand, undo, _resetHistory } from '../src/commandBus';
import { runCfdGridStudy } from '../src/cfd/flowGridStudy';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { getLiveDoc, _resetLiveDoc, subscribeLive } from '../src/liveDocument';
import { makeFakeRes, parseSseFrame } from './sseTestHelpers';
import { fakeRunner, sphereModel } from './cfdTestSupport';

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
beforeEach(() => {
  _resetHistory();
});

describe('cfd_solve gridStudy on the live document', () => {
  it('logs record_cfd_results then record_cfd_grid_study, and one undo removes only the study', async () => {
    const base = sphereModel();
    _resetLiveDoc(execute(base.doc, 'update_cfd_case', { caseId: 're100', cellsPerReferenceLength: 32 }).document);
    const res = makeFakeRes();
    const unsubscribe = subscribeLive(res);
    const host: FeaHost = {
      getDoc: getLiveDoc,
      applyCommand: (name, params) => {
        const result = applyCommand(name, params);
        return { summary: result.summary, affected: result.affected, isError: result.isError, data: result.data };
      },
    };
    const solved = await runCfdGridStudy('re100', {}, host, {
      store: defaultFeArtifactStore(),
      runner: fakeRunner({ byGrid: (h) => 0.5 + 8 * h * h }),
    });
    expect(solved.isError, solved.summary).toBe(false);
    const events = res.written.map(parseSseFrame).filter((frame) => frame.event === 'command');
    expect(events.map((frame) => frame.data['name'])).toEqual(['record_cfd_results', 'record_cfd_grid_study']);
    expect(getLiveDoc().cfd?.studies?.['re100']).toMatchObject({ verified: true });

    undo();
    expect(getLiveDoc().cfd?.studies?.['re100']).toBeUndefined();
    expect(getLiveDoc().cfd?.results['re100']).toMatchObject({ verified: true });
    unsubscribe();
  });
});
