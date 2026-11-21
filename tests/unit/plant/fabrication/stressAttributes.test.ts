/** PST-FU2: `withStressAttributes` scope rules (pipe-scoped models on legacy lines, run-scoped on routed lines) and the carrier filter. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { stressAttributesOf, withStressAttributes } from '@aec/plant/fabrication/stressAttributes';
import type { NetworkComponent } from '@aec/plant/fabrication/model';
import { findModel } from '@aec/plant/stress/model/store';
import type { StressModel } from '@aec/plant/stress/model/schema';
import { baseDoc, conditioned, DN100, withModel, withPipe } from '../stress/m3Fixtures';

const part = (id: string, type: NetworkComponent['type'], extra?: Record<string, string>): NetworkComponent => ({
  id,
  type,
  ends: [],
  ...(extra === undefined ? {} : { extra }),
});

function scene(): { model: StressModel; doc: CadDocument; id: string; bare: { doc: CadDocument; id: string } } {
  const pipe = withPipe(
    baseDoc(),
    [
      [0, 0, 0],
      [1000, 0, 0],
    ],
    DN100.odMm,
  );
  const made = withModel(pipe.doc, [pipe.id]);
  const doc = conditioned(made.doc, made.id);
  return { model: findModel(doc, made.id) as StressModel, doc, id: made.id, bare: made };
}

const ATTRIBUTES = { 'COMPONENT-ATTRIBUTE1': '10' };

describe('withStressAttributes', () => {
  const stressModel = scene().model;
  const owner = stressModel.scope.ids[0] as string;
  const components = [
    part(`${owner}/elbow-1`, 'ELBOW'),
    part(`${owner}/weld-1`, 'WELD'),
    part('other/pipe-1', 'PIPE'),
    part(`${owner}/pipe-2`, 'PIPE', { 'COMPONENT-ATTRIBUTE1': '99' }),
  ];

  it('a pipe-scoped model covers a legacy line: carriers in scope get the attributes, others are skipped, welds are untouched, a held attribute is kept', () => {
    expect(stressModel.scope.kind).toBe('pipes');
    const out = withStressAttributes(components, ATTRIBUTES, stressModel, 'legacy');
    expect(out.applied).toEqual([owner]);
    expect(out.skipped).toBe(1);
    expect(out.components[0]?.extra).toEqual(ATTRIBUTES);
    expect(out.components[1]).toBe(components[1]);
    expect(out.components[2]).toBe(components[2]);
    expect(out.components[3]?.extra).toEqual({ 'COMPONENT-ATTRIBUTE1': '99' });
  });

  it('a pipe-scoped model does not cover a routed line: nothing is applied and the carriers are counted as skipped', () => {
    const out = withStressAttributes(components, ATTRIBUTES, stressModel, 'route');
    expect(out.applied).toEqual([]);
    expect(out.skipped).toBe(3);
    expect(out.components).toEqual(components);
  });
});

describe('stressAttributesOf', () => {
  it('reports an unknown model and a model without operating conditions, and lists the present slots otherwise', () => {
    const s = scene();
    expect(stressAttributesOf(s.doc, 'nope')).toEqual({ ok: false, reason: 'no stress model "nope"' });
    expect(stressAttributesOf(s.bare.doc, s.bare.id)).toMatchObject({ ok: false });
    const found = stressAttributesOf(s.doc, s.id);
    expect(found.ok).toBe(true);
    const attributes = found.ok ? found.attributes : {};
    expect(attributes).toMatchObject({ 'COMPONENT-ATTRIBUTE7': expect.any(String), 'COMPONENT-ATTRIBUTE9': expect.any(String) });
    expect(attributes).not.toHaveProperty('COMPONENT-ATTRIBUTE3');
    expect(attributes).not.toHaveProperty('COMPONENT-ATTRIBUTE8');
  });
});
