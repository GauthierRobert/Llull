/** recognize_features, hole_table and check_machining on recognised (not authored) features: the live-OCC face graphs of the 07 pack, no WASM. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { RecognizeData } from '@core/commands/features/recognizeFeatures';
import type { HoleTableData } from '@core/commands/features/holeTable';
import type { FtrCheckData } from '@core/model/manufacturing';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type FixtureName, fixtureKernel, loadFixture } from '../../helpers/recognitionFixture';
import { ctxWith } from '../../helpers/featureSupport';

const part = (): { doc: ReturnType<typeof createEmptyDocument>; id: string } => {
  const result = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  return { doc: result.document, id: result.affected[0] as string };
};
const kernelOf = (name: FixtureName): GeometryKernel => fixtureKernel(loadFixture(name));

describe('recognize_features', () => {
  it('reports counts, holes, pockets and the result meta of the machined plate (VC-FTR-17)', () => {
    const { doc, id } = part();
    const result = execute(doc, 'recognize_features', { id }, ctxWith(kernelOf('machinedPlate')));
    const data = result.data as RecognizeData;
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(data.counts).toEqual({ holes: 7, countersink: 4, counterbore: 2, blind: 1, pockets: 1, bends: 0, fillets: 0, chamfers: 0 });
    expect(data).toMatchObject({ entityId: id, lengthUnit: 'mm', angleUnit: 'deg', reviewRequired: true, unclassified: [], findings: [] });
    expect(data.provenance.sources).toEqual(['07 FTR §5.6']);
    expect(data.provenance.inputs['lengthTolerance']).toMatchObject({ unit: 'mm', defaulted: true });
    expect(data.provenance.inputs['angularTolerance']).toMatchObject({ value: 1e-4, unit: 'deg', defaulted: true });
    expect(result.summary).toContain('7 holes');
    expect(result.summary).toContain('not approved');
    expectPure(doc, () => execute(doc, 'recognize_features', { id }, ctxWith(kernelOf('machinedPlate'))));
  });

  it('honours kinds, explicit tolerances and mergeSplitFaces', () => {
    const { doc, id } = part();
    const ctx = ctxWith(kernelOf('splitBlind'));
    const merged = execute(doc, 'recognize_features', { id, kinds: ['hole'], lengthTolerance: 1e-4, angularTolerance: 0.001 }, ctx)
      .data as RecognizeData;
    expect(merged.counts.holes).toBe(1);
    expect(merged.provenance.inputs['lengthTolerance']).toMatchObject({ value: 1e-4, defaulted: false, source: 'parameter' });
    const split = execute(doc, 'recognize_features', { id, mergeSplitFaces: false }, ctx).data as RecognizeData;
    expect(split.counts.holes).toBe(0);
    expect(split.unclassified.length).toBeGreaterThan(0);
    const onlyPockets = execute(doc, 'recognize_features', { id, kinds: ['pocket'] }, ctxWith(kernelOf('machinedPlate')))
      .data as RecognizeData;
    expect(onlyPockets.holes).toEqual([]);
  });

  it('flags an ambiguous countersink with FTR_RECOGNITION_AMBIGUOUS (info)', () => {
    const { doc, id } = part();
    const data = execute(doc, 'recognize_features', { id }, ctxWith(kernelOf('flatAndShallow'))).data as RecognizeData;
    expect(data.findings).toMatchObject([{ code: 'FTR_RECOGNITION_AMBIGUOUS', severity: 'info' }]);
    expect(data.holes.find((hole) => hole.confidence === 'ambiguous')?.subtype).toBe('countersink');
  });

  it('bends of the bracket and the block fillets are listed', () => {
    const { doc, id } = part();
    const bracket = execute(doc, 'recognize_features', { id }, ctxWith(kernelOf('bracketL'))).data as RecognizeData;
    expect(bracket.counts.bends).toBe(1);
    const block = execute(doc, 'recognize_features', { id }, ctxWith(kernelOf('filletChamfer'))).data as RecognizeData;
    expect(block.counts).toMatchObject({ fillets: 1, chamfers: 1, holes: 0 });
  });

  it('refuses a kernel without the face-query port, a failing graph and a missing solid', () => {
    const { doc, id } = part();
    const exact = kernelOf('machinedPlate');
    const portless: GeometryKernel = { ...exact, faceQuery: undefined } as unknown as GeometryKernel;
    const noPort = execute(doc, 'recognize_features', { id }, ctxWith(portless));
    expectNoOp(noPort, doc);
    expect(noPort.error).toMatchObject({ code: 'FTR_NEEDS_EXACT_KERNEL', ids: [id] });
    const blind: GeometryKernel = { ...exact, faceQuery: { ...exact.faceQuery!, faceGraph: () => null } } as GeometryKernel;
    expect(execute(doc, 'recognize_features', { id }, ctxWith(blind)).error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
    expect(execute(doc, 'recognize_features', { id: 'nope' }, ctxWith(exact)).error?.code).toBe('FTR_PART_NOT_FOUND');
    expect(execute(doc, 'recognize_features', { id }, ctxWith(null)).error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
  });
});

describe('hole_table on a recognised part (imported, no add_hole)', () => {
  it('lists the 7 holes sorted by face, y and x, with the recognised drill point not defaulted', () => {
    const { doc, id } = part();
    const table = execute(doc, 'hole_table', { id }, ctxWith(kernelOf('machinedPlate'))).data as HoleTableData;
    expect(table.rows).toHaveLength(7);
    expect(table.rows.map((row) => row.label)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']);
    const ys = table.rows.map((row) => row.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    const blind = table.rows.find((row) => !row.through);
    expect(blind).toMatchObject({ subtype: 'simple', diameter: 6, depth: 6 });
    expect(blind?.drillPointAngle).toMatchObject({ defaulted: false, source: 'add_hole input' });
    expect(blind?.tipHeight).toBeCloseTo(1.802581857, 6);
    expect(table.unverified).toBe(false);
    const csk = table.rows.find((row) => row.subtype === 'countersink');
    expect(csk).toMatchObject({ cskDiameter: 9, through: true });
    expect(csk?.cskDepth).toBeCloseTo(1.762109225, 6);
    expect(table.rows.find((row) => row.subtype === 'counterbore')).toMatchObject({ cboreDiameter: 10, cboreDepth: 5.5 });
  });
});

describe('check_machining on a recognised part', () => {
  const ctx = (): ReturnType<typeof ctxWith> => ctxWith(kernelOf('machinedPlate'));

  it('uses the given thickness: no knife edge at 10, four at 1.6 (VC-FTR-23)', () => {
    const { doc, id } = part();
    const thick = execute(doc, 'check_machining', { id, thickness: 10 }, ctx()).data as FtrCheckData;
    expect(thick.findings.map((f) => f.code)).toEqual([
      'FTR_RULE_THRESHOLD_MISSING',
      'FTR_RULE_THRESHOLD_MISSING',
      'FTR_RULE_THRESHOLD_MISSING',
    ]);
    const thin = execute(doc, 'check_machining', { id, thickness: 1.6 }, ctx()).data as FtrCheckData;
    const knives = thin.findings.filter((f) => f.code === 'FTR_CSK_KNIFE_EDGE');
    expect(knives).toHaveLength(4);
    expect(knives.every((f) => f.ids[0]?.startsWith('hole-r'))).toBe(true);
    expect(thin.status).toBe('fail');
  });

  it('the recognised pocket corner radius is checked against the cutter (VC-FTR-27)', () => {
    const { doc, id } = part();
    const data = execute(
      doc,
      'check_machining',
      { id, thickness: 10, rules: [{ rule: 'toolDiameter', value: 8, source: 'cutter' }] },
      ctx(),
    ).data as FtrCheckData;
    expect(data.findings.find((f) => f.code === 'FTR_POCKET_CORNER_BELOW_TOOL_RADIUS')).toMatchObject({
      value: 3,
      limit: 4,
      source: 'cutter',
    });
  });

  it('a thickness that cannot be measured (no mesh) is refused when it is needed', () => {
    const { doc, id } = part();
    const result = execute(doc, 'check_machining', { id }, ctx());
    expectNoOp(result, doc);
    expect(result.error).toMatchObject({ code: 'FTR_NEEDS_EXACT_KERNEL', paths: ['thickness'] });
  });
});
