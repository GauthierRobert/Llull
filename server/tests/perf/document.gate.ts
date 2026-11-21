/** PERF1 gate, document core: editing, hashing, saving, regenerating and exporting large documents (budgets.ts `document.*`). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext, runInContext } from '@core/commands/context';
import { createReplayCache } from '@core/commands/history/replayCache';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { DEFAULT_LAYER_ID, createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { documentHash } from '@protocol/liveSync';
import { expectWithinBudget, medianMs, reportMeasurements } from './harness';

const DRAFT_ENTITIES = 20_000;
const HISTORY_STEPS = 2000;

let draft: CadDocument;

function must(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params);
  if (result.rejected === true) throw new Error(`${name}: ${result.summary}`);
  return result.document;
}

beforeAll(() => {
  let doc = createEmptyDocument();
  for (let index = 0; index < DRAFT_ENTITIES; index += 1) {
    const [x, y] = [(index % 200) * 10, Math.floor(index / 200) * 10];
    doc = must(doc, 'draw_polyline', {
      points:
        index % 2 === 0
          ? [
              [0, 0],
              [5, 5],
            ]
          : [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 4],
            ],
      closed: index % 2 === 1,
      position: [x, y, 0],
    });
  }
  draft = doc;
});

afterAll(() => console.warn(reportMeasurements()));

describe('document performance budgets (PERF1)', () => {
  it('document.command.draft20k: one drafting command with its state hash on 20 000 entities', async () => {
    let doc = draft;
    documentHash(doc);
    const elapsed = await medianMs(() => {
      doc = must(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [3, 1],
        ],
        position: [1, 2, 0],
      });
      documentHash(doc);
    }, 15);
    expect(Object.keys(doc.entities).length).toBe(DRAFT_ENTITIES + 15);
    expectWithinBudget('document.command.draft20k', elapsed);
  });

  it('document.hash.mesh300k: the state hash after a 300k-triangle mesh entity was replaced', () => {
    const positions = Array.from({ length: 900_000 }, (_, index) => Math.sin(index) * 100);
    const indices = Array.from({ length: 900_000 }, (_, index) => index % 300_000);
    const entity = {
      id: 'mesh-1',
      kind: 'mesh',
      layerId: DEFAULT_LAYER_ID,
      position: [0, 0, 0],
      mesh: { positions, indices },
    } as unknown as Entity;
    const doc: CadDocument = { ...draft, entities: { ...draft.entities, 'mesh-1': entity }, order: [...draft.order, 'mesh-1'] };
    documentHash(draft);
    const started = performance.now();
    const hash = documentHash(doc);
    const elapsed = performance.now() - started;
    expect(hash).not.toBe(documentHash(draft));
    expectWithinBudget('document.hash.mesh300k', elapsed);
  });

  it('document.save.incremental: the autosave text after one more command', async () => {
    let doc = draft;
    serializeDocument(doc);
    const elapsed = await medianMs(() => {
      doc = must(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [3, 1],
        ],
      });
      expect(serializeDocument(doc).length).toBeGreaterThan(1_000_000);
    }, 9);
    expectWithinBudget('document.save.incremental', elapsed);
  });

  it('document.regenerate.late_edit: editing the last step of a 2 000-step history', () => {
    const context = { ...defaultContext(), replayCache: createReplayCache() };
    runInContext(context, () => {
      let doc = createEmptyDocument();
      for (let index = 0; index < HISTORY_STEPS; index += 1)
        doc = execute(doc, 'add_box', { size: [4, 4, 4], position: [(index % 50) * 10, Math.floor(index / 50) * 10, 0] }, context).document;
      const replayed = execute(doc, 'replay_history', {}, context).document;
      const last = replayed.featureHistory.at(-1)?.id ?? '';
      const started = performance.now();
      const edited = execute(replayed, 'edit_step_params', { stepId: last, params: { size: [5, 5, 5] } }, context);
      const elapsed = performance.now() - started;
      expect(edited.summary).toContain('params updated');
      expectWithinBudget('document.regenerate.late_edit', elapsed);
    });
  });

  it('document.export.svg20k / dxf20k: the 2D exports of 20 000 entities', () => {
    let started = performance.now();
    const svg = execute(draft, 'export_svg', {});
    expectWithinBudget('document.export.svg20k', performance.now() - started);
    expect(svg.summary).toContain('20000');
    started = performance.now();
    const dxf = execute(draft, 'export_dxf', {});
    expectWithinBudget('document.export.dxf20k', performance.now() - started);
    expect(dxf.summary).toContain('20000');
  });
});
