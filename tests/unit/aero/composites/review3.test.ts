import { describe, expect, it } from 'vitest';
import type { CompositePart, LaminaMaterial, Ply } from '@core/model/composites';
import { assessPly } from '@aero/composites/drape/producibility';
import { compositesDocument } from '@aero/composites/document';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { WOVEN, spherePart } from './drapeFixtures';

describe('incomplete nets (CMP_DRAPE_INCOMPLETE)', () => {
  const base = spherePart();
  const doc = apply(base.doc, 'add_ply', {
    part: base.part,
    name: 'W1',
    material: WOVEN.name,
    orientation: 0,
    boundary: { kind: 'whole_face' },
    drape: { stepLength: 5 },
  });
  const part = doc.composites?.parts[base.part] as CompositePart;
  const ply = Object.values(doc.composites?.plies ?? {})[0] as Ply;
  const material = doc.composites?.materials[WOVEN.name] as LaminaMaterial;

  it('reports full coverage for a complete drape', () => {
    const result = assessPly(part, ply, material, { stepLength: 5, lockingAngle: 80 });
    if ('error' in result) throw new Error(result.error);
    expect(result.coverage).toBeGreaterThan(0.99);
    expect(result.findings.map((f) => f.code)).not.toContain('CMP_DRAPE_INCOMPLETE');
    const drape = data<{ coverage: number; pieces: { failedNodes: { outside: number; inverted: number } }[] }>(doc, 'drape_ply', {
      ply: 'W1',
      part: base.part,
      stepLength: 5,
    });
    expect(drape.coverage).toBeGreaterThan(0.99);
    expect(drape.pieces[0]?.failedNodes.outside).toBeGreaterThanOrEqual(0);
  });

  it('fails when a node failure or the node budget truncates the net', () => {
    const result = assessPly(part, ply, material, { stepLength: 5, lockingAngle: 80, maxNodes: 60 });
    if ('error' in result) throw new Error(result.error);
    expect(result.coverage).toBeLessThan(0.99);
    const finding = result.findings.find((f) => f.code === 'CMP_DRAPE_INCOMPLETE');
    expect(finding?.severity).toBe('fail');
  });
});

describe('document validation of sphere / nurbs surfaces, drape settings and cuts', () => {
  const base = spherePart();
  const laid = ok(base.doc, 'add_ply', {
    part: base.part,
    name: 'W1',
    material: WOVEN.name,
    orientation: 0,
    boundary: { kind: 'whole_face' },
    drape: { stepLength: 5, seed: [0, 0] },
  }).document;
  const raw = JSON.parse(JSON.stringify(laid)) as { composites: Record<string, Record<string, Record<string, unknown>>> };
  const errors = (mutate: (c: typeof raw.composites) => void): string[] => {
    const copy = JSON.parse(JSON.stringify(raw)) as typeof raw;
    mutate(copy.composites);
    return compositesDocument.validate(copy as unknown as Record<string, unknown>);
  };
  const partId = Object.keys(raw.composites['parts'] ?? {})[0] as string;
  const plyId = Object.keys(raw.composites['plies'] ?? {})[0] as string;

  it('accepts the valid file and rejects bad sphere, nurbs, drape and cut records', () => {
    expect(errors(() => undefined)).toEqual([]);
    expect(errors((c) => ((c['parts']?.[partId]?.['surface'] as Record<string, unknown>)['radius'] = 0)).join(' ')).toContain('sphere');
    expect(
      errors((c) => {
        const part = c['parts']?.[partId] as Record<string, unknown>;
        part['surface'] = {
          type: 'nurbs',
          surface: 3,
          domain: [
            [1, 0],
            [0, 1],
          ],
          scale: [1, 0],
        };
      }).join(' '),
    ).toMatch(/nurbs[\s\S]*domain[\s\S]*scale/);
    expect(errors((c) => ((c['plies']?.[plyId] as Record<string, unknown>)['drape'] = { method: 'x' })).join(' ')).toContain(
      'drape.method',
    );
    expect(
      errors((c) => ((c['plies']?.[plyId] as Record<string, unknown>)['drape'] = { method: 'kinematic', stepLength: -1, seed: [1] })).join(
        ' ',
      ),
    ).toMatch(/stepLength[\s\S]*seed/);
    expect(errors((c) => ((c['plies']?.[plyId] as Record<string, unknown>)['cuts'] = 5)).join(' ')).toContain('cuts must be a list');
    expect(
      errors(
        (c) =>
          ((c['plies']?.[plyId] as Record<string, unknown>)['cuts'] = [
            { kind: 'dart', path: [[0, 0]] },
            {
              kind: 'splice',
              path: [
                [0, 0],
                [1, 1],
              ],
              overlap: -1,
            },
          ]),
      ).join(' '),
    ).toMatch(/cuts\.0[\s\S]*cuts\.1\.overlap/);
  });
});
