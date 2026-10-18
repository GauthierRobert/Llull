import { describe, expect, it } from 'vitest';
import { applied as step } from '../../helpers/runFixtures';
import { createEmptyDocument, type CadDocument, type Entity, type Vec2 } from '@core/model/types';
import { execute } from '@core/commands/registry';

const groundZ = (x: number): number => 100 + 0.05 * x;

function sloped(): CadDocument {
  let doc = execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
  const points: Array<{ x: number; y: number; z: number }> = [];
  for (let x = 0; x <= 100; x += 20) for (let y = 0; y <= 100; y += 20) points.push({ x, y, z: groundZ(x) });
  doc = step(doc, 'import_survey_points', { points });
  return step(doc, 'create_surface', {});
}

const PAD: Vec2[] = [
  [40, 40],
  [60, 40],
  [60, 60],
  [40, 60],
];

function meshOf(doc: CadDocument, id: string): Extract<Entity, { kind: 'mesh' }>['mesh'] {
  const entity = doc.entities[id] as Extract<Entity, { kind: 'mesh' }> | undefined;
  if (!entity) throw new Error(`missing ${id}`);
  return entity.mesh;
}

const padDoc = (): CadDocument => step(sloped(), 'add_platform', { surfaceId: 'surface-1', boundary: PAD, elevation: 102.5 });

describe('platform daylight and existing-ground trim', () => {
  it('draws the 3D daylight line at ground elevation, not at the pad level', () => {
    const doc = padDoc();
    const { positions } = meshOf(doc, 'platform-1:daylight-3d');
    const zs: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const ground = groundZ(positions[i] as number);
      expect(positions[i + 2] as number).toBeGreaterThanOrEqual(ground - 1e-6);
      expect(positions[i + 2] as number).toBeLessThan(ground + 0.05);
      zs.push(positions[i + 2] as number);
    }
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.5);
    const polyline = doc.entities['platform-1:daylight'];
    expect(polyline?.position[2]).toBeCloseTo(102.5, 0);
    expect(polyline?.position[2]).not.toBe(102.5);
  });

  it('cuts the existing-ground TIN away under the pad and batters', () => {
    const untrimmed = sloped();
    const doc = padDoc();
    const area = (id: string, source: CadDocument): number => {
      const { positions, indices } = meshOf(source, id);
      let sum = 0;
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => (indices[i + k] as number) * 3);
        sum +=
          Math.abs(
            ((positions[b as number] as number) - (positions[a as number] as number)) *
              ((positions[(c as number) + 1] as number) - (positions[(a as number) + 1] as number)) -
              ((positions[(b as number) + 1] as number) - (positions[(a as number) + 1] as number)) *
                ((positions[c as number] as number) - (positions[a as number] as number)),
          ) / 2;
      }
      return sum;
    };
    expect(area('surface-1:tin', untrimmed)).toBeCloseTo(10000, 3);
    const trimmed = area('surface-1:tin', doc);
    expect(10000 - trimmed).toBeGreaterThan(400);
    expect(10000 - trimmed).toBeLessThan(700);
    const { positions, indices } = meshOf(doc, 'surface-1:tin');
    for (let i = 0; i < indices.length; i += 3) {
      const ids = [0, 1, 2].map((k) => (indices[i + k] as number) * 3);
      const cx = ids.reduce((s, v) => s + (positions[v] as number), 0) / 3;
      const cy = ids.reduce((s, v) => s + (positions[v + 1] as number), 0) / 3;
      expect(cx > 40.01 && cx < 59.99 && cy > 40.01 && cy < 59.99).toBe(false);
    }
  });

  it('keeps cut / fill volumes independent of the trim', () => {
    const result = execute(sloped(), 'add_platform', { surfaceId: 'surface-1', boundary: PAD, elevation: 102.5 });
    const data = result.data as { cutM3: number; fillM3: number };
    expect(data.cutM3).toBeGreaterThan(0);
    expect(data.fillM3).toBeGreaterThan(0);
    expect(data.cutM3 - data.fillM3).toBeCloseTo(0, -2);
  });
});
