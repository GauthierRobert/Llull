/** Remaining PHY-06 branches: the extra nodes a pretension adds to a results file, the copies of several cuts, the stick-slope default without a material. */
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { defaultStickSlope } from '@cae/contact/defaults';
import { copiesOf, pretensionExtraNodes, pretensionResultMap } from '@cae/contact/pretensionDeck';
import { caseOf, withCase } from '@cae/shared/access';
import { must } from './support';
import { bolted, boltedMesh, sectionParams } from './boltSupport';

describe('pretensionExtraNodes', () => {
  it('lists the duplicates (29..32) and the reference node (33) of one bolt, ascending; none without a bolt', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    expect(pretensionExtraNodes(added.doc, b.analysisId, boltedMesh(b, added.doc))).toEqual({
      duplicates: [29, 30, 31, 32],
      references: [33],
    });
    expect(pretensionExtraNodes(b.doc, b.analysisId, boltedMesh(b, b.doc))).toEqual({ duplicates: [], references: [] });
    expect(pretensionExtraNodes(b.doc, 'nope', boltedMesh(b, b.doc))).toEqual({ duplicates: [], references: [] });
  });

  it('is empty when the deck would refuse the bolt (the stored preload step is gone)', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const analysis = caseOf(added.doc, b.analysisId);
    const boltId = added.affected[1] ?? '';
    const bolt = analysis?.pretension?.bolts[boltId];
    if (analysis === undefined || bolt === undefined) throw new Error('no bolt');
    const stale = withCase(added.doc, {
      ...analysis,
      pretension: { order: [boltId], bolts: { [boltId]: { ...bolt, preloadStepId: 'gone' } } },
    });
    expect(pretensionExtraNodes(stale, b.analysisId, boltedMesh(b, stale))).toEqual({ duplicates: [], references: [] });
  });
});

describe('pretensionResultMap / copiesOf', () => {
  it('two bolts: every cut node maps to its own copy; the lenient map ignores a stale preload step the deck would refuse', () => {
    const b = bolted();
    const one = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const two = must(
      one.doc,
      'add_bolt_pretension',
      sectionParams(b, { name: 'm2', section: { point: [0.5, 0.5, 3], normal: [0, 0, 1] } }),
    );
    const plan = pretensionResultMap(two.doc, b.analysisId, boltedMesh(b, two.doc));
    const copies = plan === null ? new Map() : copiesOf(plan);
    expect([...copies.keys()]).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(copies.get(9)).toEqual([29]);
    expect(copies.get(13)).toEqual([33]);
    const analysis = caseOf(two.doc, b.analysisId);
    const boltId = two.affected[1] ?? '';
    const bolt = analysis?.pretension?.bolts[boltId];
    if (analysis === undefined || bolt === undefined) throw new Error('no bolt');
    const stale: CadDocument = withCase(two.doc, {
      ...analysis,
      pretension: {
        ...analysis.pretension,
        bolts: { ...analysis.pretension?.bolts, [boltId]: { ...bolt, preloadStepId: 'gone' } },
        order: analysis.pretension?.order ?? [],
      },
    });
    expect(pretensionResultMap(stale, b.analysisId, boltedMesh(b, stale))).not.toBeNull();
  });

  it('is null for a bolt whose plane no longer cuts the part on this mesh', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const analysis = caseOf(added.doc, b.analysisId);
    const boltId = added.affected[1] ?? '';
    const bolt = analysis?.pretension?.bolts[boltId];
    if (analysis === undefined || bolt === undefined) throw new Error('no bolt');
    const off = withCase(added.doc, {
      ...analysis,
      pretension: { order: [boltId], bolts: { [boltId]: { ...bolt, section: { point: [0.5, 0.5, 40], normal: [0, 0, 1] } } } },
    });
    expect(pretensionResultMap(off, b.analysisId, boltedMesh(b, off))).toBeNull();
  });
});

describe('defaultStickSlope', () => {
  it('is null when no part of the case has a material with an elastic law, and half the first E otherwise', () => {
    const b = bolted();
    const analysis = caseOf(b.doc, b.analysisId);
    if (analysis === undefined) throw new Error('no analysis');
    expect(defaultStickSlope(b.doc, analysis)).toMatchObject({ value: 100000, defaulted: true });
    const bare: CadDocument = { ...b.doc, materials: {} };
    expect(defaultStickSlope(bare, analysis)).toBeNull();
    const noElastic: CadDocument = {
      ...b.doc,
      materials: Object.fromEntries(
        Object.entries(b.doc.materials).map(([id, material]) => [
          id,
          { ...material, constitutiveSets: [], materialModels: [], propertyModels: undefined },
        ]),
      ),
    } as CadDocument;
    expect(defaultStickSlope(noElastic, analysis)).toBeNull();
  });
});
