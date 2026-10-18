import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { hashOf, portOf, solvedBar } from './deckFixtures';

interface Items {
  status: string;
  items: { code: string; severity: string; ids: string[]; message: string; remediation: string }[];
}

/** The solved bar with a mesh artifact that does / does not carry `facetedParts`, recorded through the commands. */
function checked(faceted: boolean): { data: Items; doc: CadDocument } {
  const bar = solvedBar();
  const mesh = faceted ? { ...bar.mesh, facetedParts: [bar.boxId] } : bar.mesh;
  const meshHash = hashOf(mesh);
  const results = { ...bar.results, meshHash };
  const resultsHash = hashOf(results);
  const context: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
  const meshed = execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) }, context);
  const doc = execute(
    meshed.document,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(bar.doc, bar.analysisId, mesh, results, resultsHash) },
    context,
  ).document;
  const result = execute(doc, 'check_analysis', { analysisId: bar.analysisId }, context);
  expect(result.document).toBe(doc);
  return { data: result.data as Items, doc };
}

describe('check_analysis FEA_FACETED_GEOMETRY', () => {
  it('warns (not an error) when the mesh artifact records a faceted curved part, with the part id and a remediation', () => {
    const { data } = checked(true);
    const item = data.items.find((entry) => entry.code === 'FEA_FACETED_GEOMETRY');
    expect(item?.severity).toBe('warning');
    expect(item?.message).toContain('off by several % (either sign)');
    expect(item?.ids).toContain('box-1.1');
    expect(item?.remediation).toContain('OCC kernel');
    expect(data.items.filter((entry) => entry.severity === 'error')).toEqual([]);
  });

  it('is silent for a mesh without faceted parts (a box, or an exact STEP mesh), and the recorded summary still verifies', () => {
    const { data } = checked(false);
    expect(data.items.map((entry) => entry.code)).not.toContain('FEA_FACETED_GEOMETRY');
    expect(data.items.map((entry) => entry.code)).not.toContain('FEA_SUMMARY_MISMATCH');
  });
});
